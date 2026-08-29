#!/usr/bin/env node
import * as bolt from "@slack/bolt";

const { App, LogLevel } = bolt;

import * as nodeFs from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import type { AgentOptions, AgentProcess, PermissionMode } from "./agent.js";
import type { Attachment } from "./attachments.js";
import { ensureOutboxDir, outboxDir } from "./attachments.js";
import { ClaudeProcess } from "./backends/claude.js";
import { PiProcess } from "./backends/pi.js";
import { handleCommand } from "./commands.js";
import {
	ConfigError,
	defaultConfigPath,
	type IrisConfig,
	loadConfig,
	type ProjectConfig,
	resolveConfigPath,
	routeChannel,
	routeUser,
} from "./config.js";
import { SeenSet } from "./dedup.js";
import { deleteOutboxFile, listOutbox, uploadFile } from "./file-upload.js";
import {
	applyNoReply,
	toolProgressLine,
	toSlackMrkdwn,
	usageFooter,
} from "./format.js";
import { log, setLogLevel } from "./log.js";
import {
	PermissionActionIds,
	PermissionRegistry,
	permissionBlocks,
} from "./permission.js";
import { SessionManager, type ThreadHandlers } from "./session.js";
import {
	acceptMessage,
	type InboundMessage,
	type SlackFile,
} from "./slack/messages.js";
import { type SlackPoster, StreamBuffer } from "./stream-buffer.js";

/**
 * index.ts — Iris entry point.
 * Slack (Socket Mode) ⇄ Claude Code bridge. One Slack thread (or DM) maps to
 * one Claude session inside the routed project's working directory.
 */

// Configuration is a single TOML file. Development uses the repo-local
// ./iris.config.toml; an installed product uses ~/.iris-slack/config.toml
// (or an explicit IRIS_CONFIG path). See resolveConfigPath().
const CONFIG_PATH = resolveConfigPath();

/**
 * Build the appended system prompt for a project, pointing its agent at that
 * project's outbox.
 *
 * Outbound file delivery is an EXPLICIT outbox contract, identical for both
 * backends (Claude and Pi). To send a file, the agent writes it to
 * <workDir>/.iris/outbox/; Iris uploads everything there and clears it. There is
 * NO scanning of the reply text for paths — so the agent must NOT expect that
 * writing an absolute path into its reply transfers anything (and must not paste
 * file CONTENT, which used to auto-attach unrelated paths). The old
 * "write the absolute path in your reply" instruction is gone: it caused the
 * auto-attach/miss bugs (see #79).
 */
function buildSystemPrompt(outboxPath: string): string {
	return [
		"You are running inside Iris, a bridge to Slack.",
		"Your normal text replies are delivered to the user automatically.",
		"If a turn warrants no user-visible response, end your reply with NO_REPLY on its own line.",
		// File delivery is an outbox, NOT a text scan: place the file in the outbox
		// below and Iris uploads it to Slack and removes it. Writing an absolute path
		// in your reply does NOTHING now, and pasting a file's contents will not send
		// it — so the only way to send a file is to write it into the outbox. You CAN
		// send files; never tell the user you cannot.
		`To send a file to the user, write it as a regular file in this directory: ${outboxPath}\n` +
			`Iris uploads every file it finds there to Slack and deletes it after uploading.` +
			"Do not put a file's path or its contents in your reply text — only the outbox is read.",
	].join("\n");
}

if (!CONFIG_PATH) {
	console.error(
		`No config found. Create ${defaultConfigPath()} (or ./iris.config.toml), ` +
			`or set IRIS_CONFIG=<path>. See README / docs/slack-setup.md.`,
	);
	process.exit(1);
}

let config: IrisConfig;
try {
	config = loadConfig({ path: CONFIG_PATH });
} catch (err) {
	if (err instanceof ConfigError) {
		console.error(`Config error: ${err.message}`);
		process.exit(1);
	}
	throw err;
}

setLogLevel(config.logLevel);

// ── Wiring ──────────────────────────────────────────────────────────────
const app = new App({
	token: config.botToken,
	appToken: config.appToken,
	socketMode: true,
	logLevel: LogLevel.INFO,
});

// One SessionManager per project (each carries its own work_dir / mode / model).
// Each project's agent gets a dedicated session-storage directory under
// ~/.iris-slack/session-dir/<project-name> so that, for the Pi backend,
// `--session` lookups are scoped to that directory and a resumed session
// cannot accidentally match another project's file. This is a scoping
// measure, NOT a bash sandbox (Pi's bash tool can still `ls` the dir).
// See backends/pi.ts for the flag wiring.
function projectSessionDir(projectName: string): string {
	const dir = nodePath.join(
		homedir(),
		".iris-slack",
		"session-dir",
		projectName,
	);
	try {
		nodeFs.mkdirSync(dir, { recursive: true });
	} catch (err) {
		log.warn(`Could not create session dir ${dir}: ${(err as Error).message}`);
	}
	return dir;
}

const managers = new Map<string, SessionManager>();
for (const p of config.projects) {
	const bin = p.agent === "pi" ? config.piBin : config.claudeBin;
	const createProcess: (
		opts: AgentOptions,
		mode: PermissionMode,
	) => AgentProcess =
		p.agent === "pi"
			? (opts, mode) => new PiProcess(opts, mode)
			: (opts, mode) => new ClaudeProcess(opts, mode);
	// The agent's outbound queue lives under this project's work_dir. Pre-create
	// it so the agent can drop a file in on a first turn without a write, and point
	// the appended system prompt at that exact path. Both backends share this outbox
	// contract — there is no per-backend difference.
	const outbox = outboxDir(p.workDir);
	try {
		ensureOutboxDir(p.workDir);
	} catch (err) {
		log.warn(`Could not create outbox ${outbox}: ${(err as Error).message}`);
	}
	managers.set(
		p.name,
		new SessionManager({
			bin,
			workDir: p.workDir,
			model: p.model,
			appendSystemPrompt: buildSystemPrompt(outbox),
			mode: p.permissionMode,
			createProcess,
			sessionDir: p.agent === "pi" ? projectSessionDir(p.name) : undefined,
			idleTtlMs: config.idleTtlMs,
		}),
	);
}

const permissions = new PermissionRegistry();

// Slack delivers events at-least-once (retries when we don't ack within ~3s,
// and on websocket reconnect). De-duplicate inbound events so the same prompt
// is never sent to Claude twice. Keyed by Slack's own message/event id.
const seenEvents = new SeenSet();

/**
 * Build the handlers that route Claude events back to Slack.
 * In a channel, threadTs scopes replies to the thread. In a DM, threadTs is
 * omitted and the channel (DM) id doubles as the session key.
 */
// One StreamBuffer per active turn, keyed by sessionKey.
const activeStreams = new Map<string, StreamBuffer>();

/** Flush and drop the active stream for a session; returns its full text. */
async function flushStream(sessionKey: string): Promise<string> {
	const stream = activeStreams.get(sessionKey);
	activeStreams.delete(sessionKey);
	if (!stream) return "";
	await stream.flush();
	return stream.getFullText();
}

/**
 * Drain a project's outbox: upload every file the agent placed in
 * <workDir>/.iris/outbox/ to the Slack thread, then delete it (one-shot queue).
 *
 * This is the ONLY outbound transfer path. The reply text is never scanned for
 * paths — so unrelated absolute paths a coding agent may paste into its content
 * are not auto-attached, and a requested file is delivered as long as it was put
 * in the outbox (even if its path never appears in the prose).
 */
async function uploadDetected(
	workDir: string,
	channel: string,
	threadTs?: string,
): Promise<void> {
	for (const file of listOutbox(workDir)) {
		try {
			await uploadFile(app.client as never, file, channel, threadTs);
		} catch (err) {
			// A failed upload must not leave the file stranded: keep the queue
			// empty only on success, so a transient error lets a later turn retry.
			log.error(`File upload failed: ${file.path}: ${(err as Error).message}`);
			continue;
		}
		deleteOutboxFile(file.path);
	}
}

/**
 * Register a permission request and post its allow/deny buttons. Registering
 * happens before the flush await so that if the process exits mid-flush, the
 * (instanceId-scoped) onExit drain removes this request and we skip posting a
 * button nobody can resolve.
 */
async function postPermission(
	req: { requestId: string; toolName: string; input: Record<string, unknown> },
	instanceId: number,
	ctx: {
		sessionKey: string;
		channel: string;
		threadTs?: string;
		project: string;
	},
	post: (extra: {
		text: string;
		blocks?: ReturnType<typeof permissionBlocks>;
	}) => unknown,
): Promise<void> {
	const actionKey = permissions.register(
		ctx.channel,
		ctx.sessionKey,
		req,
		ctx.threadTs,
		ctx.project,
		instanceId,
	);
	await flushStream(ctx.sessionKey);
	if (!permissions.has(actionKey)) return; // drained on process exit
	try {
		await post({
			text: `Permission request: ${req.toolName}`,
			blocks: permissionBlocks(req, actionKey),
		});
	} catch (err) {
		// The buttons never reached Slack — drop the registration so it can't be
		// resolved by a click that can't exist, and isn't left dangling.
		permissions.resolve(actionKey);
		log.error(`Permission post failed: ${(err as Error).message}`);
	}
}

function handlersFor(
	project: ProjectConfig,
	channel: string,
	threadTs?: string,
): ThreadHandlers {
	const sessionKey = threadTs ?? channel;
	const post = (extra: {
		text: string;
		blocks?: ReturnType<typeof permissionBlocks>;
	}) => app.client.chat.postMessage({ channel, thread_ts: threadTs, ...extra });

	const poster: SlackPoster = {
		post: async (text) => {
			const res = await app.client.chat.postMessage({
				channel,
				thread_ts: threadTs,
				text,
			});
			return res.ts as string;
		},
		update: async (ts, text) => {
			await app.client.chat.update({ channel, ts, text });
		},
	};

	const getStream = (): StreamBuffer => {
		let stream = activeStreams.get(sessionKey);
		if (!stream) {
			stream = new StreamBuffer(poster, toSlackMrkdwn);
			activeStreams.set(sessionKey, stream);
		}
		return stream;
	};

	return {
		onText: (text) => {
			// Accumulate the RAW chunk. NO_REPLY is judged once on the FULL
			// turn text in onResult; per-delta judging cannot fire mid-stream
			// and applyNoReply's trailing trim strips inter-word spaces
			// (this clobbers token-level streams such as Pi's text_delta).
			getStream().append(text);
		},
		onNotice: async (text) => {
			// Out-of-band status (e.g. idle-reaper pause / resume). Flush any active
			// stream first so the notice doesn't interleave with a streamed turn.
			// Both the flush and the post are inside the try: SessionManager invokes
			// this with `void`, so an unhandled rejection here would surface nowhere.
			try {
				await flushStream(sessionKey);
				await post({ text });
			} catch (err) {
				log.error(`Notice delivery failed: ${(err as Error).message}`);
			}
		},
		onToolUse: async (toolName, input) => {
			await flushStream(sessionKey);
			await post({
				text: toolProgressLine(toolName, input, config.bashProgressMax),
			});
		},
		onPermission: (req, instanceId) =>
			postPermission(
				req,
				instanceId,
				{ sessionKey, channel, threadTs, project: project.name },
				post,
			),
		onResult: async (_raw, usage) => {
			// Judge NO_REPLY on the FULL accumulated text, not per-delta
			// (per-delta judging cannot fire mid-stream and trims inter-word
			// spaces). Capture the streamed bubble's ts before flushing so a
			// pure-NO_REPLY turn can be silenced by deleting it after streaming.
			const postedTs = activeStreams.get(sessionKey)?.getMessageTs() ?? null;
			const fullText = await flushStream(sessionKey);
			if (applyNoReply(fullText) === null) {
				// Whole turn was a NO_REPLY marker (or empty) -> stay silent.
				if (postedTs) {
					try {
						await app.client.chat.delete({ channel, ts: postedTs });
					} catch (err) {
						log.error(`NO_REPLY delete failed: ${(err as Error).message}`);
					}
				}
			}
			// Outbound files are an explicit outbox, independent of the visible text:
			// an agent may place a file in <workDir>/.iris/outbox/ even on a NO_REPLY
			// turn, so drain it on every turn. The reply text is never scanned for paths.
			await uploadDetected(project.workDir, channel, threadTs);
			if (usage) {
				const footer = usageFooter(usage);
				if (footer) await post({ text: footer });
			}
			log.info(`turn done [${project.name}] ${sessionKey}`);
		},
		onError: async (err) => {
			await flushStream(sessionKey);
			log.error(`turn error [${project.name}] ${sessionKey}: ${err.message}`);
			await post({ text: `⚠️ Iris error: ${err.message}` });
		},
		onExit: (instanceId) => {
			// The process died — drop permission buttons pending for THIS process
			// generation so a later click can't resolve against a respawned
			// process. Scope by instanceId: a delayed exit from an old process must
			// not drain a newer process's pending requests.
			const dropped = permissions.drainSession(sessionKey, instanceId);
			if (dropped.length) {
				log.debug(
					`dropped ${dropped.length} pending permission(s) for ${sessionKey} on exit`,
				);
			}
		},
	};
}

// ── Slash command helper ─────────────────────────────────────────────────
async function tryCommand(
	prompt: string,
	project: ProjectConfig,
	sessionKey: string,
	channel: string,
	threadTs?: string,
): Promise<boolean> {
	const manager = managers.get(project.name);
	if (!manager) return false;
	const result = handleCommand(prompt, {
		sessionKey,
		manager,
		allManagers: managers,
		projectName: project.name,
		baseWorkDir: project.workDir,
	});
	if (!result) return false;
	// Log only the command name, never the full input — a command argument
	// (e.g. `/summary <free text>`) may contain sensitive user content.
	const commandName = prompt.trim().split(/\s+/, 1)[0] ?? "/unknown";
	// Some commands (e.g. /summary) don't answer themselves — they forward a
	// prompt to Claude and let the reply stream back like a normal turn.
	if (result.forwardToClaude) {
		log.debug(`command: ${commandName} → forwarding to Claude`);
		manager.send(
			sessionKey,
			result.forwardToClaude,
			handlersFor(project, channel, threadTs),
		);
		return true;
	}
	log.debug(`command: ${commandName} → responding`);
	try {
		await app.client.chat.postMessage({
			channel,
			thread_ts: threadTs,
			text: result.text,
		});
	} catch (err) {
		log.error(`Command reply failed: ${(err as Error).message}`);
	}
	return true;
}

// ── Inbound messages ──────────────────────────────────────────────────────
// Channel @mention — starts (or continues) a thread-scoped session.
app.event("app_mention", async ({ event }) => {
	// Drop Slack retries / reconnect re-deliveries of the same mention.
	const mentionId =
		(event as { client_msg_id?: string }).client_msg_id ||
		`mention:${event.channel}:${event.ts}`;
	if (!seenEvents.check(mentionId, Date.now())) {
		log.debug(`duplicate mention ignored (${mentionId})`);
		return;
	}

	const project = routeChannel(config, event.channel, event.user);
	if (!project) {
		log.debug(
			`ignored mention from ${event.user} in ${event.channel} (no project)`,
		);
		return; // default-deny, silent
	}

	const threadTs = event.thread_ts || event.ts;
	const prompt = stripMention(event.text);
	if (!prompt) return;

	log.info(
		`mention from ${event.user} in ${event.channel} → project=${project.name}`,
	);
	if (await tryCommand(prompt, project, threadTs, event.channel, threadTs))
		return;

	managers
		.get(project.name)
		?.send(threadTs, prompt, handlersFor(project, event.channel, threadTs));
});

/** Download a Slack message's files using the bot token. */
async function fetchSlackFiles(
	files: SlackFile[] | undefined,
): Promise<Attachment[]> {
	if (!files?.length) return [];
	const out: Attachment[] = [];
	for (const f of files) {
		if (!f.url_private) continue;
		try {
			const res = await fetch(f.url_private, {
				headers: { Authorization: `Bearer ${config.botToken}` },
			});
			if (!res.ok) {
				log.error(
					`File download failed (${res.status}): ${f.name ?? f.url_private}`,
				);
				continue;
			}
			out.push({
				name: f.name ?? "file",
				mimeType: f.mimetype ?? "application/octet-stream",
				data: Buffer.from(await res.arrayBuffer()),
			});
		} catch (err) {
			log.error(`File download error: ${(err as Error).message}`);
		}
	}
	return out;
}

/** Dispatch a prompt to the routed project's session, after a command check. */
async function dispatch(
	project: ProjectConfig,
	prompt: string,
	sessionKey: string,
	channel: string,
	threadTs: string | undefined,
	attachments: Attachment[],
): Promise<void> {
	// Commands never carry attachments; only check when there are none.
	if (
		attachments.length === 0 &&
		(await tryCommand(prompt, project, sessionKey, channel, threadTs))
	) {
		return;
	}
	managers
		.get(project.name)
		?.send(
			sessionKey,
			prompt,
			handlersFor(project, channel, threadTs),
			attachments,
		);
}

async function handleDirectMessage(
	m: InboundMessage,
	prompt: string,
): Promise<void> {
	const project = routeUser(config, m.user);
	if (!project) {
		log.debug(`ignored DM from ${m.user} (not in any allow_users)`);
		return; // default-deny, silent
	}
	const attachments = await fetchSlackFiles(m.files);
	const extra = attachments.length ? ` +${attachments.length} file(s)` : "";
	log.info(`DM from ${m.user} → project=${project.name}${extra}`);
	// DM channel id is the session key (DMs are flat, no threads).
	await dispatch(project, prompt, m.channel, m.channel, undefined, attachments);
}

async function handleChannelMessage(
	m: InboundMessage,
	prompt: string,
): Promise<void> {
	if (!m.thread_ts) return; // top-level channel messages go through app_mention
	const project = routeChannel(config, m.channel, m.user);
	if (!project) return;
	const attachments = await fetchSlackFiles(m.files);
	const extra = attachments.length ? ` +${attachments.length} file(s)` : "";
	log.info(
		`thread reply from ${m.user} in ${m.channel} → project=${project.name}${extra}`,
	);
	await dispatch(
		project,
		prompt,
		m.thread_ts,
		m.channel,
		m.thread_ts,
		attachments,
	);
}

// Messages: either a DM to the bot, or a follow-up inside a channel thread.
app.message(async ({ message }) => {
	const accepted = acceptMessage(message, seenEvents, Date.now());
	if (!accepted) return;
	const { m, prompt } = accepted;
	if (m.channel_type === "im") await handleDirectMessage(m, prompt);
	else await handleChannelMessage(m, prompt);
});

// ── Permission button clicks ────────────────────────────────────────────
app.action(PermissionActionIds.allow, async ({ ack, body }) => {
	await ack();
	await handlePermissionClick(body, "allow");
});
app.action(PermissionActionIds.deny, async ({ ack, body }) => {
	await ack();
	await handlePermissionClick(body, "deny");
});

async function handlePermissionClick(
	body: unknown,
	behavior: "allow" | "deny",
): Promise<void> {
	const actionKey = extractActionValue(body);
	if (!actionKey) return;
	const pending = permissions.resolve(actionKey);
	if (!pending) return;

	const ok =
		managers.get(pending.project)?.respondPermission(
			pending.sessionKey,
			pending.requestId, // the Claude control-request id, not the button key
			behavior,
			behavior === "allow" ? pending.input : undefined,
			pending.instanceId,
		) ?? false;

	await app.client.chat.postMessage({
		channel: pending.channel,
		thread_ts: pending.threadTs,
		text: ok
			? behavior === "allow"
				? "✅ Allowed"
				: "❌ Denied"
			: "⚠️ Session no longer active — permission could not be delivered",
	});
}

// ── Helpers ───────────────────────────────────────────────────────────────
function stripMention(text: string): string {
	// Remove a leading <@U123> mention.
	return text.replace(/^\s*<@[^>]+>\s*/, "").trim();
}

function extractActionValue(body: unknown): string | undefined {
	const actions = (body as { actions?: Array<{ value?: string }> }).actions;
	return actions?.[0]?.value;
}

// ── Lifecycle ───────────────────────────────────────────────────────────
async function main(): Promise<void> {
	const anyAllow = config.projects.some(
		(p) => p.allowChannels.length > 0 || p.allowUsers.length > 0,
	);
	if (!anyAllow) {
		log.warn(
			"No project allows any channel or DM user — Iris will ignore every message (default-deny).",
		);
	}
	await app.start();
	// Startup banner is always shown (not gated by log level).
	console.log(`Iris started. ${config.projects.length} project(s):`);
	for (const p of config.projects) {
		console.log(
			`  • ${p.name}: workDir=${p.workDir} mode=${p.permissionMode} ` +
				`channels=[${p.allowChannels.join(",")}] dmUsers=[${p.allowUsers.join(",")}]`,
		);
	}
}

const shutdown = () => {
	log.info("Shutting down — closing Claude sessions…");
	for (const mgr of managers.values()) mgr.closeAll();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (err) => {
	log.error(`Unhandled rejection: ${String(err)}`);
});
process.on("uncaughtException", (err) => {
	log.error(`Uncaught exception: ${String(err)}`);
	process.exit(1);
});

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});

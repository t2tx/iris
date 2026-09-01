import {
	type ChildProcessWithoutNullStreams,
	spawn,
	spawnSync,
} from "node:child_process";
import { randomInt } from "node:crypto";
import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentOptions, AgentProcess, PermissionMode } from "../agent.js";
import { type Attachment, safeSessionKey } from "../attachments.js";
import type { ParsedEvent, PermissionRequest } from "../protocol.js";
import {
	classifyHermesAcpHealth,
	HERMES_ACP_PRECHECK_PHASE,
	HERMES_ACP_RECOVERY,
} from "./hermes-health.js";
import { resolvePermissionOption } from "./hermes-permission.js";
import { parseHermesLine } from "./hermes-protocol.js";

/**
 * hermes.ts — manages a resident Hermes Agent in ACP (`hermes acp`) mode.
 *
 * Mirrors PiProcess but speaks the Agent Client Protocol (newline-delimited
 * JSON-RPC 2.0 over stdio). The one new mechanism versus Pi is JSON-RPC `id`
 * correlation: we own the request ids we send and echo the ids Hermes sends for
 * `session/request_permission` back on the permission response.
 *
 * Event surface is identical to ClaudeProcess / PiProcess:
 *     "session"(sid) "text"(t) "thinking"(t) "tool_use"(name,input)
 *     "permission"(req) "result"(raw,usage?) "exit"(code,signal) "error"(err) "stderr"(line)
 *
 * Backend-specific wiring (issues #81/#82/#83/#84):
 *     - #83 health-gate: a pre-spawn `hermes acp --check` classifies the
 *      `agent-client-protocol` dependency; on missing deps we emit a graceful
 *      "error" with recovery instructions instead of crashing.
 *     - #81/#82 per-session HERMES_HOME: the outbox contract is injected via a
 *      `SOUL.md` written into a per-session HERMES_HOME (Hermes has no spawn
 *      system-prompt flag; SOUL.md is the only injection carrier). Per-session
 *      isolation means no two threads race on the same SOUL.md.
 *     - #84 permission policy: `session/request_permission` is mapped through
 *      resolvePermissionOption so `auto`/`acceptEdits` auto-resolve and the
 *      manual path surfaces the standard two-button request.
 */

/** Seed the per-process counter from a random boot offset so instanceIds do not
 * repeat across Iris restarts (same strategy as ClaudeProcess / PiProcess). */
let nextInstanceId = randomInt(1, 1_000_000_000);

/** Per-session HERMES_HOME base, isolated per Slack session key. */
function hermesHomeFor(sessionKey: string): string {
	return join(
		homedir(),
		".iris-slack",
		"hermes-home",
		safeSessionKey(sessionKey),
	);
}

/** Shared read-only files inherited from the base (user default) HERMES_HOME
 * into a fresh per-session home so the model/provider config is available while
 * sessions + memory stay isolated per session. */
const HERMES_SHARED_FILES = ["config.yaml", ".env", "auth.json"];

export class HermesProcess extends EventEmitter implements AgentProcess {
	private proc?: ChildProcessWithoutNullStreams;
	private alive = false;
	private sessionId = "";
	private readonly mode: PermissionMode;
	private readonly workDir: string;
	private readonly hermesHome?: string;
	readonly instanceId = nextInstanceId++;
	/** Monotonic JSON-RPC request id counter for requests WE initiate. */
	private nextReqId = 1;
	/** Pending request/response correlation (id → resolver). */
	private pending = new Map<
		string,
		{ resolve: (r: unknown) => void; reject: (e: Error) => void }
	>();
	/** True once the initialize→new_session/resume handshake succeeds. */
	private ready = false;
	/** Prompts sent before the session is ready are queued, then flushed. */
	private promptQueue: { prompt: string; attachments: Attachment[] }[] = [];
	private readonly opts: AgentOptions;

	constructor(opts: AgentOptions, mode: PermissionMode) {
		super();
		this.mode = mode;
		this.opts = opts;
		this.workDir = opts.workDir;

		// #83 — pre-spawn health gate: a quick `hermes acp --check` classifies
		// the acp dependency before we spawn the real agent. On failure we emit
		// a graceful error (deferred, so the caller's listeners are attached) and
		// do not spawn.
		const precheck = spawnSync(opts.bin, ["acp", "--check"], {
			encoding: "utf8",
			timeout: 15_000,
		});
		const health = classifyHermesAcpHealth({
			stdout: precheck.stdout ?? "",
			stderr: precheck.stderr ?? "",
			exitCode: precheck.status,
		});
		if (!health.ok) {
			// Defer so the post-construction `on("error")` handler in ensure()
			// (and any others) actually receive it.
			setImmediate(() =>
				this.emit(
					"error",
					new Error(
						`Hermes ACP pre-check failed (${HERMES_ACP_PRECHECK_PHASE}): ${health.recovery}`,
					),
				),
			);
			return;
		}

		// #81/#82 — per-session storage home with the outbox contract injected via
		// SOUL.md (Hermes auto-loads it from HERMES_HOME).
		this.hermesHome = this.setupHermesHome(opts);

		// `acp` is the ACP server subcommand. detached so we can kill the whole
		// tree with a single negative-pid signal.
		this.proc = spawn(opts.bin, ["acp"], {
			cwd: opts.workDir,
			env: this.hermesHome
				? { ...process.env, HERMES_HOME: this.hermesHome }
				: process.env,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.alive = true;

		this.proc.on("error", (err) => {
			this.alive = false;
			this.emit("error", err);
		});
		this.proc.on("exit", (code, signal) => {
			this.alive = false;
			this.emit("exit", code, signal);
		});

		createInterface({ input: this.proc.stdout }).on("line", (line) =>
			this.handleLine(line),
		);
		createInterface({ input: this.proc.stderr }).on("line", (line) => {
			if (line.trim()) this.emit("stderr", line);
		});

		// Seed a resume session id synchronously so getSessionId() reflects it
		// before the async handshake runs; the handshake then resumes by id.
		if (opts.resume) this.sessionId = opts.resume;

		// Handshake: initialize → (new_session | resume), sequenced by id correlation
		// so the session exists before any prompt is sent. Prompts sent before the
		// session is ready are queued and flushed when the handshake completes.
		void this.handshake();
	}

	isAlive(): boolean {
		return this.alive;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getPid(): number | undefined {
		return this.proc?.pid;
	}

	/**
	 * Send a user prompt. Content is a list of ACP content blocks:
	 *    - text          → { type:"text", text }
	 *    - image         → { type:"image", data, mime_type } (inline base64)
	 *    - non-image file→ saved to <workDir>/.iris/attachments and referenced as a
	 *                       { type:"resource_link", uri:"file://...", ... } block
	 * (Hermes resolves the file itself, mirroring buildPiPrompt's "save + reference"
	 *  intent but using Hermes' own resource_link reader).
	 *
	 * If the session is not yet ready the prompt is queued and flushed once the
	 * initialize→new_session handshake completes.
	 */
	send(prompt: string, attachments: Attachment[] = []): void {
		if (!this.ready) {
			this.promptQueue.push({ prompt, attachments });
			return;
		}
		this.sendPrompt(prompt, attachments);
	}

	private sendPrompt(prompt: string, attachments: Attachment[]): void {
		const content: unknown[] = [];
		if (prompt) content.push({ type: "text", text: prompt });

		for (const att of attachments) {
			if (att.mimeType.startsWith("image/")) {
				content.push({
					type: "image",
					data: att.data.toString("base64"),
					mime_type: att.mimeType,
				});
				continue;
			}
			const path = this.saveAttachment(att);
			content.push({
				type: "resource_link",
				uri: `file://${path}`,
				name: att.name,
				mime_type: att.mimeType,
			});
		}
		if (content.length === 0 && attachments.length > 0) {
			content.push({
				type: "text",
				text: "Please analyze the attached file(s).",
			});
		}

		this.sendJson({
			jsonrpc: "2.0",
			id: this.nextReqId++,
			method: "session/prompt",
			params: {
				sessionId: this.sessionId,
				prompt: content,
				cwd: this.workDir,
			},
		});
	}

	/**
	 * Respond to a surfaced permission request. Allow → `allow_once` (a one-shot
	 * grant for this call, matching the manual "allow" button); deny → `deny`.
	 * The ACP outcome is `{ outcome: { outcome:"selected", option_id } }`.
	 */
	respondPermission(
		requestId: string,
		behavior: "allow" | "deny",
		_input?: Record<string, unknown>,
		_denyMessage?: string,
	): void {
		const optionId = behavior === "allow" ? "allow_once" : "deny";
		this.sendJson({
			jsonrpc: "2.0",
			id: requestId,
			result: {
				outcome: {
					outcome: "selected",
					option_id: optionId,
				},
			},
		});
	}

	/** Terminate the process tree. */
	close(): void {
		if (!this.alive) return;
		this.ready = false;
		const proc = this.proc;
		if (!proc) return;
		try {
			proc.stdin.end();
		} catch {
			/* ignore */
		}
		const pid = proc.pid;
		if (pid !== undefined) {
			try {
				process.kill(-pid, "SIGTERM");
			} catch {
				try {
					proc.kill("SIGTERM");
				} catch {
					/* already gone */
				}
			}
		}
	}

	// ── internal ─────────────────────────────────────────────────────────────

	private async handshake(): Promise<void> {
		try {
			await this.request("initialize", {
				protocolVersion: 1,
				clientCapabilities: {
					loadSession: true,
					resumeSession: true,
					session: { resume: {}, fork: {} },
				},
				clientInfo: { name: "iris", version: "1" },
			});
			if (this.opts.resume) {
				this.sessionId = this.opts.resume;
				await this.request("session/resume", {
					sessionId: this.opts.resume,
					cwd: this.workDir,
					mcpServers: [],
				});
			} else {
				const result = (await this.request("session/new", {
					cwd: this.workDir,
					mcpServers: [],
				})) as { sessionId?: string } | undefined;
				if (result?.sessionId) this.setSessionId(result.sessionId);
			}
			this.ready = true;
			this.flushQueue();
		} catch (err) {
			this.emit("error", err instanceof Error ? err : new Error(String(err)));
		}
	}

	/** Correlated JSON-RPC request; resolves with the matching response result. */
	private request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextReqId++;
		return new Promise((resolve, reject) => {
			this.pending.set(String(id), { resolve, reject });
			this.sendJson({ jsonrpc: "2.0", id, method, params });
			setTimeout(() => {
				if (this.pending.has(String(id))) {
					this.pending.delete(String(id));
					reject(new Error(`hermes request '${method}' timed out`));
				}
			}, 90_000).unref?.();
		});
	}

	private flushQueue(): void {
		while (this.promptQueue.length > 0) {
			const q = this.promptQueue.shift();
			if (!q) break;
			this.sendPrompt(q.prompt, q.attachments);
		}
	}

	private setupHermesHome(opts: AgentOptions): string | undefined {
		if (!opts.sessionKey) return undefined;
		const home = hermesHomeFor(opts.sessionKey);
		try {
			mkdirSync(home, { recursive: true });
			// Inherit shared config from the base HERMES_HOME (default ~/.hermes,
			// overridable via HERMES_BASE_HOME) so the per-session home knows which
			// model/provider to use. Only copied on first creation so per-session
			// state (sessions/, state.db, memories/) stays isolated and grows in
			// place on later turns.
			const base = process.env.HERMES_BASE_HOME || join(homedir(), ".hermes");
			for (const f of HERMES_SHARED_FILES) {
				const src = join(base, f);
				const dst = join(home, f);
				if (existsSync(src) && !existsSync(dst)) {
					copyFileSync(src, dst);
				}
			}
			// The outbox contract + outbox path are injected via SOUL.md, which
			// Hermes auto-loads from HERMES_HOME. The appendSystemPrompt already
			// carries the outbox convention + concrete outbox path (<workDir>/.iris/
			// outbox/<session>) resolved in SessionManager#ensure.
			const soul = opts.appendSystemPrompt?.trim() ?? "";
			writeFileSync(join(home, "SOUL.md"), soul, "utf8");
		} catch (err) {
			// A failure to set up the home is non-fatal for the agent; the outbox
			// injection simply won't take effect. Surface for debugging.
			this.emit(
				"stderr",
				`hermes-home setup failed: ${(err as Error).message}`,
			);
			return undefined;
		}
		return home;
	}

	private saveAttachment(att: Attachment): string {
		const attachDir = join(this.workDir, ".iris", "attachments");
		mkdirSync(attachDir, { recursive: true });
		const safe = att.name.replace(/[^\w.-]/g, "_") || "file";
		const token = randomInt(0, 0x1000000).toString(36);
		const fpath = join(attachDir, `${Date.now()}_${token}_${safe}`);
		writeFileSync(fpath, att.data);
		return fpath;
	}

	private sendJson(v: unknown): void {
		if (!this.alive || !this.proc) return;
		try {
			this.proc.stdin.write(`${JSON.stringify(v)}\n`);
		} catch (err) {
			this.emit("error", err as Error);
		}
	}

	private handleLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return; // non-JSON noise
		}
		if (typeof parsed !== "object" || parsed === null) return;
		const raw = parsed as Record<string, unknown>;

		// agent → client JSON-RPC request: a permission request we must answer.
		// (parseHermesLine deliberately ignores requests; we own the response here.)
		if (raw["method"] === "session/request_permission") {
			this.handlePermissionRequest(raw);
			return;
		}

		// A JSON-RPC RESPONSE we initiated (id in pending): resolve it and, for a
		// new_session / resume, capture the session id.
		const idKey =
			raw["id"] !== undefined && raw["id"] !== null
				? String(raw["id"])
				: undefined;
		if (idKey !== undefined) {
			const p = this.pending.get(idKey);
			if (p) {
				this.pending.delete(idKey);
				if (raw["error"]) {
					p.reject(
						new Error(`hermes request failed: ${JSON.stringify(raw["error"])}`),
					);
					return;
				}
				p.resolve(raw["result"]);
				this.maybeCaptureSession(raw["result"]);
				return;
			}
		}

		// notifications (session/update) and any un-matched response are mapped to
		// stream events by the pure parser.
		for (const ev of parseHermesLine(line)) {
			this.dispatchEvent(ev);
		}
	}

	private handlePermissionRequest(raw: Record<string, unknown>): void {
		const params = raw["params"] as Record<string, unknown> | undefined;
		if (!params) return;

		const permId =
			raw["id"] !== undefined ? String(raw["id"]) : `perm-${Date.now()}`;
		const toolCall = params["tool_call"] as Record<string, unknown> | undefined;
		const options = Array.isArray(params["options"]) ? params["options"] : [];
		// Guard against non-object / null option entries so a malformed
		// request_permission never throws on `o.option_id`.
		const offered = options
			.filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
			.map((o) => o.option_id)
			.filter((id): id is string => typeof id === "string" && !!id);
		const isEdit = toolCall?.kind === "edit";

		// #84 policy: auto-resolve where the mode allows, else surface two buttons.
		const decision = resolvePermissionOption(this.mode, offered, isEdit);
		if (decision.action === "resolve") {
			this.respondPermission(permId, "allow");
			return;
		}

		// Tool name for the Slack prompt: prefer the tool_call title (e.g. the
		// command description / target), falling back to "tool".
		const toolName =
			typeof toolCall?.["title"] === "string" && toolCall.title
				? toolCall.title
				: "tool";
		const input = (toolCall?.["raw_input"] ??
			toolCall?.["content"] ?? { kind: toolCall?.["kind"] }) as Record<
			string,
			unknown
		>;
		const req: PermissionRequest = {
			requestId: permId,
			toolName,
			input,
		};
		this.emit("permission", req);
	}

	private maybeCaptureSession(result: unknown): void {
		const sid = (result as { sessionId?: unknown } | undefined)?.sessionId;
		if (typeof sid === "string" && sid) this.setSessionId(sid);
	}

	private setSessionId(sid: string): void {
		if (sid !== this.sessionId) {
			this.sessionId = sid;
			this.emit("session", sid);
		}
	}

	private dispatchEvent(ev: ParsedEvent): void {
		switch (ev.kind) {
			case "session":
				this.setSessionId(ev.sessionId);
				break;
			case "text":
				this.emit("text", ev.text);
				break;
			case "thinking":
				this.emit("thinking", ev.text);
				break;
			case "tool_use":
				this.emit("tool_use", ev.toolName, ev.input);
				break;
			case "result":
				this.emit("result", ev.raw, ev.usage);
				break;
			// "permission" is never produced by the parser (requests are handled
			// explicitly in handleLine); nothing to do here.
			default:
				break;
		}
	}
}

/** Factory: create a HermesProcess for use with SessionManager. */
export function createHermesProcess(
	opts: AgentOptions,
	mode: PermissionMode,
): AgentProcess {
	return new HermesProcess(opts, mode);
}

// Referenced so the recovery string is part of the module (used by smoke too).
export { HERMES_ACP_RECOVERY };

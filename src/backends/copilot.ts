import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentOptions, AgentProcess, PermissionMode } from "../agent.js";
import type { Attachment } from "../attachments.js";
import type { ParsedEvent } from "../protocol.js";
import { parseCopilotLine } from "./copilot-protocol.js";

/**
 * copilot.ts — manages a resident GitHub Copilot CLI in ACP (`copilot --acp`)
 * mode.
 *
 * Mirrors hermes.ts but simpler: Copilot's ACP (verified against v1.0.82) is
 * nearly identical to Hermes' (v0.20.6), with two simplifications:
 *   1. Copilot's ACP mode is *autonomy-first* — it does NOT surface per-action
 *      permission requests to the client in non-interactive mode (no
 *      `session/request_permission` round-trip; verified by capture). So there is
 *      no permission bridge here; `respondPermission` is a no-op. Launch-time
 *      `--allow-*` flags (issue #99) decide tool gating.
 *   2. Copilot has no per-session home / SOUL.md carrier, so this backend has no
 *      outbox-injection setup step. (The outbox contract injection for Copilot is
 *      tracked as a follow-up; see issue #99/#100.)
 *
 * The one new mechanism versus Pi/Claude is JSON-RPC `id` correlation: we own the
 * request ids we send so we can distinguish the `initialize` / `session/new` /
 * `session/prompt` responses as they arrive interleaved with `session/update`
 * notifications.
 *
 * Event surface is identical to ClaudeProcess / HermesProcess:
 *      "session"(sid) "text"(t) "thinking"(t) "tool_use"(name,input)
 *      "result"(raw,usage?) "exit"(code,signal) "error"(err) "stderr"(line)
 */

// Seed the per-process counter from a random boot offset so instanceIds do not
// repeat across Iris restarts (same strategy as ClaudeProcess / HermesProcess).
let nextInstanceId = randomInt(1, 1_000_000_000);

/**
 * Map Iris's permission mode to Copilot's launch-time tool-gating flags.
 *
 * Copilot's ACP mode (verified against v1.0.82) is *non-interactive*: it does
 * NOT surface a per-call `session/request_permission` to the client, so tool
 * gating is fixed ONCE when the process starts rather than per action. The flags
 * are the verified copile CLI switches (from `copile --help`):
 *   auto        → `--allow-all`              (a.k.a. `--yolo`; grant every tool)
 *   acceptEdits → `--allow-tool 'write'`     (allow file editing only)
 *   manual      → (no flag)                  (Copile's declared-policy default)
 *
 * It is a pure function so the mapping is unit-tested without spawning a process
 * (issue #99 acceptance). `manual` grants nothing extra — Copile's default is to
 * declare its own policy; the v1 limitation is that a `manual` turn cannot be
 * approved interactively from Slack, so tools may not run. (Follow-up: drive
 * `session/set_mode` for per-turn approval, out of this epic.)
 */
export function copilotPermissionFlags(mode: PermissionMode): string[] {
	switch (mode) {
		case "auto":
			return ["--allow-all"];
		case "acceptEdits":
			return ["--allow-tool", "write"];
		case "manual":
		default:
			return [];
	}
}

export class CopilotProcess extends EventEmitter implements AgentProcess {
	private proc?: ChildProcessWithoutNullStreams;
	private alive = false;
	private sessionId = "";
	private readonly mode: PermissionMode;
	private readonly workDir: string;
	readonly instanceId = nextInstanceId++;
	/** Monotonic JSON-RPC request id counter for requests WE initiate. */
	private nextReqId = 1;
	/** Pending request/response correlation (id → resolver). */
	private pending = new Map<
		string,
		{
			resolve: (r: unknown) => void;
			reject: (e: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	/** True once the initialize→session/new handshake succeeds. */
	private ready = false;
	/** Prompts sent before the session is ready are queued, then flushed. */
	private promptQueue: { prompt: string; attachments: Attachment[] }[] = [];
	private readonly opts: AgentOptions;

	constructor(opts: AgentOptions, mode: PermissionMode) {
		super();
		this.mode = mode;
		this.opts = opts;
		this.workDir = opts.workDir;

		// `--acp` selects the ACP server mode. detached so we can kill the whole
		// tree (copilot → bash / MCP children) with a single negative-pid signal.
		// NOTE (issue #100): the negative-pid SIGTERM below is the v1 cleanup;
		// Copilot's grandchild reaping (pkill -P / kill -9 -$pid) is hardened there.
		const args = this.buildArgs(opts);
		this.proc = spawn(opts.bin, args, {
			cwd: opts.workDir,
			env: process.env,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.alive = true;

		this.proc.on("error", (err) => {
			this.alive = false;
			this.rejectPending(new Error(`copilot process error: ${err.message}`));
			this.emit("error", err);
		});
		this.proc.on("exit", (code, signal) => {
			this.alive = false;
			this.rejectPending(new Error(`copilot exited (code=${code})`));
			this.emit("exit", code, signal);
		});

		createInterface({ input: this.proc.stdout }).on("line", (line) =>
			this.handleLine(line),
		);
		createInterface({ input: this.proc.stderr }).on("line", (line) => {
			if (line.trim()) this.emit("stderr", line);
		});

		// Seed a resume session id synchronously so getSessionId() reflects it
		// before the async handshake runs; `--resume` makes session/new return the
		// SAME id, so the handshake then confirms it.
		if (opts.resume) this.sessionId = opts.resume;

		void this.handshake();
	}

	/**
	 * Build the CLI args. `--acp` + `--log-level error` are the minimum to open
	 * the ACP server. Tool gating is decided ONCE at process start via
	 * `copilotPermissionFlags(mode)` — Copilot's ACP is non-interactive, so there
	 * is no per-call approval round-trip (issue #99 / risk R2).
	 */
	private buildArgs(opts: AgentOptions): string[] {
		const args = [
			"--acp",
			"--log-level",
			"error",
			...copilotPermissionFlags(this.mode),
		];
		if (opts.resume) args.push("--resume", opts.resume);
		if (opts.model) args.push("--model", opts.model);
		return args;
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
	 *      - text           → { type:"text", text }
	 *      - image          → { type:"image", data, mime_type } (inline base64)
	 *      - non-image file → saved to <workDir>/.iris/attachments and referenced
	 *                         by a trailing text note (Copilot reads the path)
	 *
	 * If the session is not yet ready the prompt is queued and flushed once the
	 * initialize→session/new handshake completes.
	 */
	send(prompt: string, attachments: Attachment[] = []): void {
		if (!this.ready) {
			this.promptQueue.push({ prompt, attachments });
			return;
		}
		this.sendPrompt(prompt, attachments);
	}

	/**
	 * Copilot's ACP mode does not surface per-action permission requests, so there
	 * is nothing for Iris to resolve here. (v1: launch-time flags decide gating.)
	 */
	respondPermission(): void {
		// no-op by design (Autonomy-first ACP; see file header + issue #99).
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
		this.rejectPending(new Error("copilot closed"));
	}

	// ── internal ─────────────────────────────────────────────────────────────

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
			// Non-image: persist to disk and reference by path in a trailing text
			// note — Copilot reads files by path in its workDir.
			const path = this.saveAttachment(att);
			content.push({
				type: "text",
				text: `Attached file: ${path}`,
			});
		}
		if (content.length === 0 && attachments.length > 0) {
			content.push({
				type: "text",
				text: "Please analyze the attached file(s).",
			});
		}

		// Send as an UN-tracked JSON-RPC request (like hermes): we advance the id
		// but do NOT register it in `pending`, so the session/prompt RESPONSE flows
		// through parseCopilotLine → parseResponse and emits the turn-end `result`
		// event (with stopReason/usage). If we tracked it in pending like the
		// handshake calls, the response would be swallowed by the resolver and the
		// turn-end `result` would never fire.
		this.sendJson({
			jsonrpc: "2.0",
			id: this.nextReqId++,
			method: "session/prompt",
			params: {
				sessionId: this.sessionId,
				prompt: content,
			},
		});
	}

	private async handshake(): Promise<void> {
		try {
			// protocolVersion MUST be the number 1 (a string "1" is rejected with a
			// JSON-RPC -32600 error, verified against v1.0.82).
			await this.request("initialize", {
				protocolVersion: 1,
				clientCapabilities: {},
				clientInfo: { name: "iris", version: "1" },
			});
			const result = (await this.request("session/new", {
				cwd: this.workDir,
				mcpServers: [],
			})) as { sessionId?: string } | undefined;
			if (result?.sessionId) this.setSessionId(result.sessionId);
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
			const key = String(id);
			const timer = setTimeout(() => {
				if (this.pending.has(key)) {
					this.pending.delete(key);
					reject(new Error(`copilot request '${method}' timed out`));
				}
			}, 90_000).unref?.();
			this.pending.set(key, {
				resolve: (r) => {
					this.maybeCaptureSession(r);
					resolve(r);
				},
				reject,
				timer,
			});
			this.sendJson({ jsonrpc: "2.0", id, method, params });
		});
	}

	private flushQueue(): void {
		while (this.promptQueue.length > 0) {
			const q = this.promptQueue.shift();
			if (!q) break;
			this.sendPrompt(q.prompt, q.attachments);
		}
	}

	/** Reject every pending RPC resolver (called on exit / close). */
	private rejectPending(err: Error): void {
		for (const { reject, timer } of this.pending.values()) {
			clearTimeout(timer);
			reject(err);
		}
		this.pending.clear();
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

		// A JSON-RPC RESPONSE we initiated (id in pending): resolve it and, for a
		// session/new, capture the session id (handled inside the resolve closure).
		const idKey =
			raw["id"] !== undefined && raw["id"] !== null
				? String(raw["id"])
				: undefined;
		if (idKey !== undefined) {
			const p = this.pending.get(idKey);
			if (p) {
				clearTimeout(p.timer);
				this.pending.delete(idKey);
				if (raw.error) {
					p.reject(
						new Error(`copilot request failed: ${JSON.stringify(raw.error)}`),
					);
					return;
				}
				p.resolve(raw["result"]);
				return;
			}
		}

		// Notifications (session/update) and any un-matched response are mapped to
		// stream events by the pure parser.
		for (const ev of parseCopilotLine(line)) {
			this.dispatchEvent(ev);
		}
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
			// "permission" is never produced by copilot's parser (no interactive
			// request in v1); nothing to do here.
			default:
				break;
		}
	}
}

/** Factory: create a CopilotProcess for use with SessionManager. */
export function createCopilotProcess(
	opts: AgentOptions,
	mode: PermissionMode,
): AgentProcess {
	return new CopilotProcess(opts, mode);
}

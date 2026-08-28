import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { AgentOptions, AgentProcess, PermissionMode } from "../agent.js";
import { type Attachment, buildContent } from "../attachments.js";
import type { ParsedEvent, PermissionRequest } from "../protocol.js";
import { parsePiLine } from "./pi-protocol.js";

/**
 * pi.ts — manages a long-running Pi coding-agent process in RPC mode.
 *
 * Spawns `pi --mode rpc` and communicates via newline-delimited JSON on
 * stdin/stdout. stdout lines are routed by `type`:
 *    - "response"              → internal command responses (session id, etc.)
 *    - "extension_ui_request"  → permission bridge (confirm → Slack buttons)
 *    - anything else           → parsePiLine() emits stream events
 *
 * The backend-agnostic contract (AgentProcess) lives in agent.ts;
 * PiProcess implements that contract so SessionManager can substitute it
 * via SessionConfig.createProcess.
 */

/** The fixed toolName for Pi confirm requests surfaced as permission events. */
const CONFIRM_TOOL = "(confirm)";

/**
 * Events emitted (same surface as ClaudeProcess):
 *    "session"     (sessionId: string)
 *    "text"        (text: string)
 *    "thinking"    (text: string)
 *    "tool_use"    (toolName: string, input)
 *    "permission"  (req: PermissionRequest)
 *    "result"      (raw: Record<string,unknown>)
 *    "exit"        (code, signal)
 *    "error"       (err: Error)
 *    "stderr"      (line: string)
 */

// Seed the per-process counter from a random boot offset so instanceIds do not
// repeat across Iris restarts (same strategy as ClaudeProcess).
let nextInstanceId = randomInt(1, 1_000_000_000);

export class PiProcess extends EventEmitter implements AgentProcess {
	private proc: ChildProcessWithoutNullStreams;
	private alive = false;
	private sessionId = "";
	private readonly mode: PermissionMode;
	private readonly workDir: string;
	/** Unique per spawned process; used to reject stale permission clicks. */
	readonly instanceId = nextInstanceId++;

	constructor(opts: AgentOptions, mode: PermissionMode) {
		super();
		this.mode = mode;
		this.workDir = opts.workDir;

		const args = ["--mode", "rpc"];
		// Session resume via CLI arg (preferred path). If Pi does not support
		// --session the switch_session fallback is sent after spawn.
		if (opts.resume) args.push("--session", opts.resume);

		// detached: own process group so we can kill the whole tree with a
		// single negative-pid signal.
		this.proc = spawn(opts.bin, args, {
			cwd: opts.workDir,
			env: process.env,
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

		const rl = createInterface({ input: this.proc.stdout });
		rl.on("line", (line) => this.handleLine(line));

		// Surface stderr for debugging without crashing.
		createInterface({ input: this.proc.stderr }).on("line", (line) => {
			if (line.trim()) this.emit("stderr", line);
		});

		// Post-spawn setup: send model configuration.
		if (opts.model) {
			this.writeJSON({ type: "set_model", model: opts.model });
		}

		// Query the session id. Unlike Claude Code (which auto-emits a session id
		// in a system event), Pi does NOT surface its session id on its own. We
		// pull it via the get_state RPC right after spawn so SessionManager can
		// resume the same conversation (--session) after a killSession / idle reap.
		this.writeJSON({ type: "get_state" });
	}

	isAlive(): boolean {
		return this.alive;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getPid(): number | undefined {
		return this.proc.pid;
	}

	/**
	 * Send a user prompt to Pi in RPC mode.
	 * With no attachments the message is a plain string;
	 * with attachments it becomes a multimodal content array
	 * (images inline as base64, other files saved to disk and
	 * referenced by path).
	 */
	send(prompt: string, attachments: Attachment[] = []): void {
		if (attachments.length === 0) {
			this.writeJSON({ type: "prompt", message: prompt });
			return;
		}
		const content = buildContent(prompt, attachments, this.workDir, Date.now());
		this.writeJSON({ type: "prompt", message: content });
	}

	/**
	 * Respond to a pending permission (confirm) request.
	 * Writes an extension_ui_response with the confirmed flag.
	 */
	respondPermission(
		requestId: string,
		behavior: "allow" | "deny",
		_input?: Record<string, unknown>,
		_denyMessage?: string,
	): void {
		this.writeJSON({
			type: "extension_ui_response",
			id: requestId,
			confirmed: behavior === "allow",
		});
	}

	/** Terminate the process tree. */
	close(): void {
		if (!this.alive) return;
		try {
			this.proc.stdin.end();
		} catch {
			/* ignore */
		}
		const pid = this.proc.pid;
		if (pid !== undefined) {
			try {
				process.kill(-pid, "SIGTERM");
			} catch {
				try {
					this.proc.kill("SIGTERM");
				} catch {
					/* already gone */
				}
			}
		}
	}

	private writeJSON(v: unknown): void {
		if (!this.alive) return;
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

		const type = raw.type;

		// Command response (e.g. session id capture, init confirmation)
		if (type === "response") {
			this.handleResponse(raw);
			return;
		}

		// Extension UI dialog
		if (type === "extension_ui_request") {
			this.handleExtensionUiRequest(raw);
			return;
		}

		// Everything else → stream events via parsePiLine
		for (const ev of parsePiLine(line)) {
			this.dispatchEvent(ev);
		}
	}

	/**
	 * Dispatch a parsed stream event to the appropriate emit call.
	 */
	private dispatchEvent(ev: ParsedEvent): void {
		switch (ev.kind) {
			case "session":
				if (ev.sessionId !== this.sessionId) {
					this.sessionId = ev.sessionId;
					this.emit("session", ev.sessionId);
				}
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
			case "permission":
				this.handlePermission(ev.request);
				break;
		}
	}

	/**
	 * Handle a command response from Pi (e.g. session id, init confirmation).
	 * The get_state RPC supplies the session id via `data.sessionId` (Pi does
	 * not auto-emit one); a fallback also reads `result.sessionId` / `session_id`.
	 * Emits a "session" event if the id changed.
	 */
	private handleResponse(raw: Record<string, unknown>): void {
		// get_state RPC (sent post-spawn): Pi returns the live session id in
		// data.sessionId. This is the reliable capture path — Pi never emits a
		// session id on its own, so without it resume would silently fail.
		if (raw.command === "get_state" && raw.success === true) {
			const data = raw.data as Record<string, unknown> | undefined;
			const sid = typeof data?.sessionId === "string" ? data.sessionId : "";
			if (sid && sid !== this.sessionId) {
				this.sessionId = sid;
				this.emit("session", sid);
			}
			return;
		}

		// Generic init/response carrying a session id in the result payload.
		const result = raw.result as Record<string, unknown> | undefined;
		if (!result) return;

		const sid = result.sessionId ?? result.session_id;
		if (typeof sid === "string" && sid && sid !== this.sessionId) {
			this.sessionId = sid;
			this.emit("session", sid);
		}
	}

	/**
	 * Handle an extension_ui_request from Pi.
	 * - "confirm" → bridge to Slack permission buttons via emit("permission")
	 * - everything else (select, input, editor, etc.) → auto-cancel
	 */
	private handleExtensionUiRequest(raw: Record<string, unknown>): void {
		// Extract the request id (try `id` then `requestId`).
		const id =
			typeof raw.id === "string"
				? raw.id
				: typeof raw.requestId === "string"
					? raw.requestId
					: "";
		if (!id) return;

		// Determine the dialog type (try `method` then `dialog`).
		const method =
			typeof raw.method === "string"
				? raw.method
				: typeof raw.dialog === "string"
					? raw.dialog
					: "";

		if (method === "confirm") {
			// Bridge to permission system: toolName = "(confirm)",
			// input carries {title, message} for the Slack block.
			const input: Record<string, unknown> = {};
			if (typeof raw.title === "string") input.title = raw.title;
			if (typeof raw.message === "string") input.message = raw.message;

			const req: PermissionRequest = {
				requestId: id,
				toolName: CONFIRM_TOOL,
				input,
			};
			this.handlePermission(req);
			return;
		}

		// Non-confirm UI: auto-cancel immediately.
		this.writeJSON({
			type: "extension_ui_response",
			id,
			cancelled: true,
		});
	}

	/**
	 * Apply server-side auto policy or surface the request to the platform.
	 * In "auto" mode all permissions are auto-allowed (including confirm).
	 * "acceptEdits" auto-allows edit tools but NOT confirm (it is not in
	 * the edit-tool set), so confirm always surfaces to Slack.
	 */
	private handlePermission(req: PermissionRequest): void {
		if (this.mode === "auto") {
			this.respondPermission(req.requestId, "allow");
			return;
		}
		this.emit("permission", req);
	}
}

/**
 * Factory: create a PiProcess for use with SessionManager.
 * Mirrors createClaudeProcess in agent.ts.
 */
export function createPiProcess(
	opts: AgentOptions,
	mode: PermissionMode,
): AgentProcess {
	return new PiProcess(opts, mode);
}

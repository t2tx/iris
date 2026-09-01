import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type {
	AgentOptions,
	AgentProcess,
	AvailableModel,
	PermissionMode,
} from "../agent.js";
import { type Attachment, buildPiPrompt } from "../attachments.js";
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
 * Split a configured model string "provider/id" into its provider and modelId
 * parts. Pi's set_model RPC needs them separately; the legacy "model" field was
 * never valid. Returns undefined when there is no provider part (bare id or
 * empty), so the caller can skip the malformed request instead of sending it.
 */
function splitModelId(
	model: string,
): { provider: string; modelId: string } | undefined {
	const idx = model.indexOf("/");
	if (idx <= 0 || idx === model.length - 1) return undefined;
	const provider = model.slice(0, idx);
	const modelId = model.slice(idx + 1);
	if (!provider || !modelId) return undefined;
	return { provider, modelId };
}

/**
 * Events emitted (same surface as ClaudeProcess):
 *    "session"     (sessionId: string)
 *    "text"        (text: string)
 *    "thinking"    (text: string)
 *    "tool_use"    (toolName: string, input)
 *    "permission"  (req: PermissionRequest)
 *     "result"              (raw: Record<string,unknown>)
 *     "model_error"         (msg: string)   set_model / get_available_models failure (logged + notice)
 *     "exit"                (code, signal)
 *     "error"               (err: Error)
 *     "stderr"              (line: string)
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

	/** The model Pi is currently using for this session, last seen via get_state / set_model response. */
	private trackedModel: AvailableModel | undefined;
	/**
	 * Single-shot resolvers awaiting a command response (e.g. listModels). Keyed by
	 * the request id Iris assigns; exactly one is in flight at a time, so this is a
	 * single-slot queue that still tolerates interleaved responses.
	 */
	private readonly pendingResponses = new Map<
		string,
		{
			resolve: (v: AvailableModel[]) => void;
			reject: (err: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	private nextRpcId = 0;

	constructor(opts: AgentOptions, mode: PermissionMode) {
		super();
		this.mode = mode;
		this.workDir = opts.workDir;

		const args = ["--mode", "rpc"];
		// Session resume via CLI arg (preferred path). If Pi does not support
		// --session the switch_session fallback is sent after spawn.
		if (opts.resume) args.push("--session", opts.resume);

		// Per-project session storage isolation. By default Pi stores session
		// files under a per-cwd subdir of ~/.pi/agent/sessions/, which is
		// world-visible via `ls` so a Pi's bash tool can read other
		// projects' histories. Overriding --session-dir scopes the --session
		// lookup to this project's directory, so a resumed session cannot
		// accidentally match another project's file. NOTE: this does NOT
		// sandbox bash — Pi's bash tool can still `ls` the dir — so this
		// is a scoping measure, not a filesystem boundary.
		if (opts.sessionDir) args.push("--session-dir", opts.sessionDir);

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
			this.rejectPendingResponses(new Error(`pi exited (code=${code})`));
			this.emit("exit", code, signal);
		});

		const rl = createInterface({ input: this.proc.stdout });
		rl.on("line", (line) => this.handleLine(line));

		// Surface stderr for debugging without crashing.
		createInterface({ input: this.proc.stderr }).on("line", (line) => {
			if (line.trim()) this.emit("stderr", line);
		});

		// Post-spawn setup: send the configured model (if any). Pi's set_model RPC
		// requires provider + modelId separately — the legacy {model:"..."} shape
		// from the Claude era was never valid and silently no-op'd, so Iris's
		// configured model was ignored and pi ran its own default. Split on the
		// first "/"; if it is not the "provider/id" shape we cannot send it, so
		// skip with a warning rather than send a malformed request.
		const split = opts.model ? splitModelId(opts.model) : undefined;
		if (split) {
			this.writeJSON({
				type: "set_model",
				provider: split.provider,
				modelId: split.modelId,
			});
		} else {
			console.error(
				`[pi] set_model skipped: model "${opts.model}" is not in "provider/id" form`,
			);
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
	 * Switch the model of the live session without respawning, keeping the
	 * conversation context. Pi applies it on the next LLM call. The success/failure
	 * of the resulting set_model response is tracked in currentModel / surfaced on
	 * the "model_error" event.
	 */
	setModel(provider: string, modelId: string): void {
		this.writeJSON({ type: "set_model", provider, modelId });
	}

	/** The model Pi last reported for this session (from get_state / set_model), if known. */
	currentModel(): AvailableModel | undefined {
		return this.trackedModel;
	}

	/**
	 * Ask Pi which models are available, via the get_available_models RPC. Single-slot:
	 * a request id is assigned for correlation; a 5s timeout guards a missing reply,
	 * and a process exit rejects the pending call. Backends that do not expose this
	 * capability simply are not given this method.
	 */
	listModels(): Promise<AvailableModel[]> {
		return new Promise<AvailableModel[]>((resolve, reject) => {
			const id = String(++this.nextRpcId);
			const timer = setTimeout(() => {
				this.pendingResponses.delete(id);
				reject(new Error("listModels timed out"));
			}, 5_000);
			this.pendingResponses.set(id, { resolve, reject, timer });
			this.writeJSON({ type: "get_available_models", id });
		});
	}

	/** Reject every pending RPC resolver (called on exit / close). */
	private rejectPendingResponses(err: Error): void {
		for (const { reject, timer } of this.pendingResponses.values()) {
			clearTimeout(timer);
			reject(err);
		}
		this.pendingResponses.clear();
	}

	/**
	 * Send a user prompt to Pi in RPC mode.
	 *
	 * Pi's `prompt` command requires a plain string `message`; its
	 * `session.prompt()` runs `text.startsWith("/")` on it, so a content
	 * array (as Claude expects) throws. Images therefore travel in a separate
	 * `images` field of Pi `ImageContent` parts, and non-image files are saved
	 * to <workDir>/.iris/attachments and referenced by path in the message.
	 * `streamingBehavior` controls where a prompt lands when the agent is busy.
	 * Pi only reads it while streaming; when idle it is ignored, so `steer`
	 * degrades to a normal immediate prompt. When a turn is in flight, `steer`
	 * injects the message after the current batch of tool calls and before the
	 * next LLM call (mid-run redirect), which also avoids the "Agent is already
	 * processing" rejection. (followUp would defer until the agent fully stops.)
	 */
	send(prompt: string, attachments: Attachment[] = []): void {
		const { message, images } = buildPiPrompt(
			prompt,
			attachments,
			this.workDir,
			Date.now(),
		);
		const body: Record<string, unknown> = {
			type: "prompt",
			message,
			streamingBehavior: "steer",
		};
		if (images.length > 0) body.images = images;
		this.writeJSON(body);
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
		this.rejectPendingResponses(new Error("pi closed"));
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
			// get_state also reports the model Pi is running; keep it as currentModel.
			this.trackedModel = this.extractModel(data?.model);
			return;
		}

		// get_available_models RPC (listModels): resolve the awaiting call by the
		// id Iris assigned when it sent the request.
		if (raw.command === "get_available_models") {
			const rid = typeof raw.id === "string" ? raw.id : undefined;
			const resolver = rid ? this.pendingResponses.get(rid) : undefined;
			if (resolver && rid) {
				clearTimeout(resolver.timer);
				this.pendingResponses.delete(rid);
				if (raw.success === true) {
					const data = raw.data as { models?: unknown } | undefined;
					const list = Array.isArray(data?.models) ? data.models : [];
					resolver.resolve(
						list
							.map((m) => this.extractModel(m))
							.filter((m): m is AvailableModel => m !== undefined),
					);
				} else {
					resolver.reject(
						new Error(
							`get_available_models failed: ${String(raw.error ?? "")}`,
						),
					);
				}
				return;
			}
		}

		// set_model RPC: Pi confirms the switch on success. Track the new model,
		// and surface a failure to avoid a user being misled about a switch that
		// never took effect.
		if (raw.command === "set_model") {
			if (raw.success === true) {
				this.trackedModel = this.extractModel(raw.data);
			} else {
				const msg = `[pi] set_model failed: ${String(raw.error ?? "unknown error")}`;
				console.error(msg);
				this.emit("model_error", msg);
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

	/** Project one of Pi's Model records to the minimal AvailableModel Iris needs. */
	private extractModel(raw: unknown): AvailableModel | undefined {
		if (!raw || typeof raw !== "object") return undefined;
		const m = raw as Record<string, unknown>;
		const provider = typeof m.provider === "string" ? m.provider : undefined;
		const id = typeof m.id === "string" ? m.id : undefined;
		if (!provider || !id) return undefined;
		const out: AvailableModel = { provider, id };
		if (typeof m.name === "string") out.name = m.name;
		if (typeof m.reasoning === "boolean") out.reasoning = m.reasoning;
		return out;
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

import type { EventEmitter } from "node:events";
import type { Attachment } from "./attachments.js";
import { ClaudeProcess } from "./backends/claude.js";

/**
 * agent.ts — the backend-agnostic contract a resident agent process must satisfy,
 * plus the option shape shared by all backends.
 *
 * SessionManager depends on AgentProcess (not on a concrete ClaudeProcess), so a
 * different agent backend (e.g. a Pi coding-agent) can be dropped in by
 * supplying a different `createProcess` factory in SessionConfig. Each backend
 * is an EventEmitter subclass that implements AgentProcess; abstract classes are
 * intentionally avoided so each backend owns its own event plumbing.
 */

/** How the backend gates tool use without a human round-trip. */
export type PermissionMode = "manual" | "acceptEdits" | "auto";

/** PermissionRequest is defined in protocol.ts (the pure parser); re-exported here
 * so agent consumers reach it from the contract module. */
export type { PermissionRequest } from "./protocol.js";

/** Backend-independent options for spawning a session. */
export interface AgentOptions {
	bin: string;
	workDir: string;
	model?: string;
	/** session id to --resume (omit for a fresh session) */
	resume?: string;
	/**
	 * The Slack session key (thread_ts) this process serves. Backends that store
	 * their own per-session files (e.g. Hermes' `HERMES_HOME`) use it to isolate
	 * storage by session so a session's state can't cross-read another's. Unused
	 * by backends that don't need a per-session home.
	 */
	sessionKey?: string;
	/** appended to --append-system-prompt */
	appendSystemPrompt?: string;
	/**
	 * Per-session storage directory for backends that support an explicit
	 * session dir (e.g. Pi's `--session-dir`). When set, session files are
	 * written here instead of the backend's default global location, so a
	 * resumed session is loaded only from this directory and other projects'
	 * sessions cannot be discovered by `--session` lookup. (Note: does NOT
	 * sandbox bash — Pi's bash can still `ls` the dir. For full isolation,
	 * use a per-session HOME.)
	 */
	sessionDir?: string;
}

/**
 * The contract a resident agent process satisfies. It is an EventEmitter so
 * SessionManager can subscribe to its stream; the emitted events are:
 *    "session"     (sessionId: string)             — captured from the init event
 *    "text"        (text: string)                  — assistant text content
 *    "thinking"    (text: string)
 *    "tool_use"    (toolName: string, input)       — progress signal
 *    "permission"  (req: PermissionRequest)        — needs allow/deny
 *    "result"      (raw: Record<string,unknown>, usage?) — turn finished
 *    "exit"        (code, signal)
 *    "error"       (err: Error)
 *    "stderr"      (line: string)
 *
 * `instanceId` is a per-process generation id; a stale permission click is
 * rejected if the live process's id no longer matches.
 */
/**
 * A model that a backend can run a session with. Minimal view of the backend's
 * own model record (Pi's `Model<any>`), projected to the fields Iris needs to
 * list, display, and switch models on a live session.
 */
export interface AvailableModel {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
}

export interface AgentProcess extends EventEmitter {
	/** Unique per spawned process; used to reject stale permission clicks. */
	readonly instanceId: number;
	/** Whether the process is still running. */
	isAlive(): boolean;
	/** The last captured session id (empty until the init event arrives). */
	getSessionId(): string;
	/** The OS pid, if the process is running. */
	getPid(): number | undefined;
	/** Send a user message (optionally with inline attachments). */
	send(prompt: string, attachments?: Attachment[]): void;
	/** Resolve a pending permission request raised by this process. */
	respondPermission(
		requestId: string,
		behavior: "allow" | "deny",
		input?: Record<string, unknown>,
		denyMessage?: string,
	): void;
	/** Terminate the process tree. */
	close(): void;

	/**
	 * Switch the model of a live session without respawning (keeps the
	 * conversation context). Only supported by backends that expose a runtime
	 * model-switch RPC (e.g. Pi). Absent on backends without runtime switching.
	 */
	setModel?(provider: string, modelId: string): void;
	/**
	 * List the models a backend can run a session with. Backends without runtime
	 * model discovery (e.g. Claude Code) do not implement this.
	 */
	listModels?(): Promise<AvailableModel[]>;
	/** The model a backend is currently using for this session, if known. */
	currentModel?(): AvailableModel | undefined;
}

/**
 * A factory that creates a resident agent process. The default wires the Claude
 * Code backend; a different backend is injected by passing another factory to
 * SessionManager (see SessionConfig.createProcess).
 */
export function createClaudeProcess(
	opts: AgentOptions,
	mode: PermissionMode,
): AgentProcess {
	return new ClaudeProcess(opts, mode);
}

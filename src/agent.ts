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
	/** appended to --append-system-prompt */
	appendSystemPrompt?: string;
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

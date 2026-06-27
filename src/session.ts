import {
  ClaudeProcess,
  type PermissionMode,
  type PermissionRequest,
} from './claude.js';
import type {UsageInfo} from './protocol.js';
import type {Attachment} from './attachments.js';

/**
 * session.ts — maps a Slack thread (thread_ts) to a long-running ClaudeProcess.
 *
 * One Slack thread == one Claude session == one resident process.
 * When a process dies, we keep its last session_id so the next message can
 * resume it with `--resume`.
 */

export interface SessionConfig {
  bin: string;
  workDir: string;
  model?: string;
  appendSystemPrompt?: string;
  mode: PermissionMode;
}

interface Entry {
  proc: ClaudeProcess;
  sessionId: string; // last known Claude session id (for resume after death)
}

/** Callbacks the manager invokes for a given thread. Wired by index.ts. */
export interface ThreadHandlers {
  onText(text: string): void | Promise<void>;
  onToolUse(toolName: string, input: unknown): void | Promise<void>;
  onPermission(
    req: {
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
    },
    instanceId: number,
  ): void | Promise<void>;
  onResult(
    raw: Record<string, unknown>,
    usage?: UsageInfo,
  ): void | Promise<void>;
  onError(err: Error): void | Promise<void>;
  /** Fired when the process exits, so callers can drop stale pending state. */
  onExit?(): void | Promise<void>;
}

export class SessionManager {
  private readonly cfg: SessionConfig;
  private readonly entries = new Map<string, Entry>();
  private readonly workDirOverrides = new Map<string, string>();
  // Pending --resume target set by /resume, applied on the next spawn.
  private readonly resumeOverrides = new Map<string, string>();

  constructor(cfg: SessionConfig) {
    this.cfg = cfg;
  }

  /**
   * Attach this thread to an existing Claude session id on its next message.
   * Used by /resume to reconnect after Iris restarts (which clears the
   * in-memory entries). Kills any live process so the next message respawns
   * with --resume.
   */
  setResumeId(sessionKey: string, sessionId: string): void {
    this.resumeOverrides.set(sessionKey, sessionId);
    const entry = this.entries.get(sessionKey);
    if (entry?.proc.isAlive()) entry.proc.close();
    this.entries.delete(sessionKey);
  }

  /** Override the working directory for a specific session (thread). */
  setWorkDirOverride(sessionKey: string, workDir: string): void {
    this.workDirOverrides.set(sessionKey, workDir);
  }

  /** Clear the working directory override, reverting to the default. */
  clearWorkDirOverride(sessionKey: string): void {
    this.workDirOverrides.delete(sessionKey);
  }

  /** Get the current working directory override (if any). */
  getWorkDirOverride(sessionKey: string): string | undefined {
    return this.workDirOverrides.get(sessionKey);
  }

  /** Get the effective working directory for a session. */
  getEffectiveWorkDir(sessionKey: string): string {
    return this.workDirOverrides.get(sessionKey) ?? this.cfg.workDir;
  }

  /** Get the live process for a thread, spawning (or resuming) as needed. */
  private ensure(threadTs: string, handlers: ThreadHandlers): ClaudeProcess {
    const existing = this.entries.get(threadTs);
    if (existing && existing.proc.isAlive()) return existing.proc;

    // Prefer a live entry's session id; otherwise a pending /resume target.
    const resume =
      existing?.sessionId || this.resumeOverrides.get(threadTs) || undefined;
    this.resumeOverrides.delete(threadTs);
    const workDir = this.workDirOverrides.get(threadTs) ?? this.cfg.workDir;
    const proc = new ClaudeProcess(
      {
        bin: this.cfg.bin,
        workDir,
        model: this.cfg.model,
        appendSystemPrompt: this.cfg.appendSystemPrompt,
        resume,
      },
      this.cfg.mode,
    );

    const entry: Entry = {proc, sessionId: resume ?? ''};
    this.entries.set(threadTs, entry);

    proc.on('session', (sid: string) => {
      entry.sessionId = sid;
    });
    proc.on('text', (t: string) => void handlers.onText(t));
    proc.on(
      'tool_use',
      (name: string, input: unknown) => void handlers.onToolUse(name, input),
    );
    proc.on(
      'permission',
      (req: PermissionRequest) =>
        void handlers.onPermission(req, proc.instanceId),
    );
    proc.on(
      'result',
      (raw: Record<string, unknown>, usage?: UsageInfo) =>
        void handlers.onResult(raw, usage),
    );
    proc.on('error', (err: Error) => void handlers.onError(err));
    proc.on('stderr', (line: string) =>
      console.error(`[claude:${threadTs}] ${line}`),
    );
    proc.on('exit', (code: number | null, signal: string | null) => {
      console.error(
        `[claude:${threadTs}] exited code=${code} signal=${signal}`,
      );
      void handlers.onExit?.();
    });

    return proc;
  }

  /** Send a user message to the thread's session (spawning if necessary). */
  send(
    threadTs: string,
    prompt: string,
    handlers: ThreadHandlers,
    attachments?: Attachment[],
  ): void {
    this.ensure(threadTs, handlers).send(prompt, attachments);
  }

  /**
   * Forward a permission decision to the thread's process.
   *
   * `expectInstanceId`, when given, must match the live process — this rejects
   * a stale Slack button click that would otherwise land on a respawned
   * process (which may reuse the same request_id).
   */
  respondPermission(
    threadTs: string,
    requestId: string,
    behavior: 'allow' | 'deny',
    input?: Record<string, unknown>,
    expectInstanceId?: number,
  ): boolean {
    const entry = this.entries.get(threadTs);
    if (!entry || !entry.proc.isAlive()) return false;
    if (
      expectInstanceId !== undefined &&
      entry.proc.instanceId !== expectInstanceId
    ) {
      return false; // stale click for a previous process generation
    }
    entry.proc.respondPermission(requestId, behavior, input);
    return true;
  }

  /** Get info about a specific session. */
  getSessionInfo(
    sessionKey: string,
  ): {pid: number | undefined; sessionId: string; alive: boolean} | null {
    const entry = this.entries.get(sessionKey);
    if (!entry) return null;
    return {
      pid: entry.proc.getPid(),
      sessionId: entry.sessionId,
      alive: entry.proc.isAlive(),
    };
  }

  /** List all tracked sessions. */
  listSessions(): Array<{
    sessionKey: string;
    pid: number | undefined;
    alive: boolean;
  }> {
    return [...this.entries.entries()].map(([key, entry]) => ({
      sessionKey: key,
      pid: entry.proc.getPid(),
      alive: entry.proc.isAlive(),
    }));
  }

  /**
   * Soft restart: kill the Claude process but keep the entry so the next
   * message resumes the same conversation (--resume). Returns true if killed.
   */
  killSession(sessionKey: string): boolean {
    const entry = this.entries.get(sessionKey);
    if (!entry || !entry.proc.isAlive()) return false;
    entry.proc.close();
    return true;
  }

  /**
   * Hard reset: kill the process AND forget the entry (including its stored
   * session id), so the next message starts a brand-new conversation with no
   * --resume. Returns true if there was an entry to clear.
   */
  clearSession(sessionKey: string): boolean {
    const entry = this.entries.get(sessionKey);
    if (!entry) return false;
    entry.proc.close();
    this.entries.delete(sessionKey);
    return true;
  }

  /** Tear down every session (called on shutdown). */
  closeAll(): void {
    for (const {proc} of this.entries.values()) proc.close();
    this.entries.clear();
  }
}

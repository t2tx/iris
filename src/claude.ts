import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {createInterface} from 'node:readline';
import {randomInt} from 'node:crypto';
import {parseLine, type PermissionRequest} from './protocol.js';
import {buildContent, type Attachment} from './attachments.js';

/**
 * claude.ts — manages a long-running Claude Code process using
 *   --input-format stream-json --output-format stream-json --permission-prompt-tool stdio
 *
 * We write newline-delimited JSON to stdin (user messages, permission responses)
 * and consume the parsed event stream from protocol.ts. Protocol shapes
 * verified against cc-connect's agent/claudecode/session.go.
 */

export type PermissionMode = 'manual' | 'acceptEdits' | 'auto';
export type {PermissionRequest} from './protocol.js';

export interface ClaudeOptions {
  bin: string;
  workDir: string;
  model?: string;
  /** session id to --resume (omit for a fresh session) */
  resume?: string;
  /** appended to --append-system-prompt */
  appendSystemPrompt?: string;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/**
 * Events emitted:
 *   "session"    (sessionId: string)           — captured from the system init event
 *   "text"       (text: string)                — assistant text content
 *   "thinking"   (text: string)
 *   "tool_use"   (toolName: string, input)     — progress signal
 *   "permission" (req: PermissionRequest)      — needs allow/deny
 *   "result"     (raw: Record<string,unknown>) — turn finished
 *   "exit"       (code, signal)
 *   "error"      (err: Error)
 */
// Seed the per-process counter from a random boot offset so instanceIds do not
// repeat across Iris restarts. A plain `1, 2, …` counter resets on restart,
// which would let a stale Slack permission button (whose action key embeds the
// old instanceId) collide with a new pending entry if Claude reused the same
// request_id. The random boot base makes such cross-restart collisions
// vanishingly unlikely while keeping ids monotonic within a single run.
let nextInstanceId = randomInt(1, 1_000_000_000);

export class ClaudeProcess extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams;
  private alive = false;
  private sessionId = '';
  private readonly mode: PermissionMode;
  private readonly workDir: string;
  /** Unique per spawned process; used to reject stale permission clicks. */
  readonly instanceId = nextInstanceId++;

  constructor(opts: ClaudeOptions, mode: PermissionMode) {
    super();
    this.mode = mode;
    this.workDir = opts.workDir;

    const args = [
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--permission-prompt-tool',
      'stdio',
      '--replay-user-messages',
      '--verbose',
    ];
    if (opts.resume) args.push('--resume', opts.resume);
    if (opts.appendSystemPrompt)
      args.push('--append-system-prompt', opts.appendSystemPrompt);
    if (opts.model) args.push('--model', opts.model);

    // detached: own process group so we can kill the whole tree (claude → MCP
    // bridges → ...) with a single signal to the negative pid.
    this.proc = spawn(opts.bin, args, {
      cwd: opts.workDir,
      env: process.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.alive = true;

    this.proc.on('error', (err) => {
      this.alive = false;
      this.emit('error', err);
    });
    this.proc.on('exit', (code, signal) => {
      this.alive = false;
      this.emit('exit', code, signal);
    });

    const rl = createInterface({input: this.proc.stdout});
    rl.on('line', (line) => this.handleLine(line));

    // surface stderr for debugging without crashing
    createInterface({input: this.proc.stderr}).on('line', (line) => {
      if (line.trim()) this.emit('stderr', line);
    });
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
   * Send a user message. With no attachments the content is a plain string;
   * with attachments it becomes a multimodal content array (images inline as
   * base64, other files saved to disk and referenced by path).
   */
  send(prompt: string, attachments: Attachment[] = []): void {
    if (attachments.length === 0) {
      this.writeJSON({
        type: 'user',
        message: {role: 'user', content: prompt},
      });
      return;
    }
    const content = buildContent(prompt, attachments, this.workDir, Date.now());
    this.writeJSON({
      type: 'user',
      message: {role: 'user', content},
    });
  }

  /** Respond to a control_request permission ask. */
  respondPermission(
    requestId: string,
    behavior: 'allow' | 'deny',
    input?: Record<string, unknown>,
    denyMessage?: string,
  ): void {
    const response =
      behavior === 'allow'
        ? {behavior: 'allow', updatedInput: input ?? {}}
        : {
            behavior: 'deny',
            message:
              denyMessage ||
              "The user denied this tool use. Stop and wait for the user's instructions.",
          };

    this.writeJSON({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response,
      },
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
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          this.proc.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      }
    }
  }

  private writeJSON(v: unknown): void {
    if (!this.alive) return;
    try {
      this.proc.stdin.write(JSON.stringify(v) + '\n');
    } catch (err) {
      this.emit('error', err);
    }
  }

  private handleLine(line: string): void {
    for (const ev of parseLine(line)) {
      switch (ev.kind) {
        case 'session':
          if (ev.sessionId !== this.sessionId) {
            this.sessionId = ev.sessionId;
            this.emit('session', ev.sessionId);
          }
          break;
        case 'text':
          this.emit('text', ev.text);
          break;
        case 'thinking':
          this.emit('thinking', ev.text);
          break;
        case 'tool_use':
          this.emit('tool_use', ev.toolName, ev.input);
          break;
        case 'result':
          this.emit('result', ev.raw, ev.usage);
          break;
        case 'permission':
          this.handlePermission(ev.request);
          break;
      }
    }
  }

  /** Apply server-side auto policy or surface the request to the platform. */
  private handlePermission(req: PermissionRequest): void {
    if (this.mode === 'auto') {
      this.respondPermission(req.requestId, 'allow', req.input);
      return;
    }
    if (this.mode === 'acceptEdits' && EDIT_TOOLS.has(req.toolName)) {
      this.respondPermission(req.requestId, 'allow', req.input);
      return;
    }
    this.emit('permission', req);
  }
}

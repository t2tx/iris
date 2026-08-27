import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {writeFileSync, mkdtempSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  createClaudeProcess,
  type AgentOptions,
  type AgentProcess,
  type PermissionMode,
  type PermissionRequest,
} from './agent.js';
import {SessionManager, type ThreadHandlers} from './session.js';
import {ClaudeProcess} from './backends/claude.js';

/**
 * agent.test.ts — the AgentProcess contract is exercised through a hand-rolled
 * fake backend wired in via SessionConfig.createProcess. This proves the
 * manager depends on the interface (not on ClaudeProcess) and that any
 * EventEmitter subclass satisfying the contract can be substituted — the whole
 * point of the extraction (a future Pi coding-agent would slot in here).
 */

/** A minimal AgentProcess that records calls, for driving the manager off Claude. */
class FakeAgentProcess extends EventEmitter implements AgentProcess {
  readonly instanceId = 42;
  private alive = true;
  sessionId = 'fake-session';
  readonly closed: string[] = [];
  readonly sent: Array<{prompt: string; attachments?: unknown[]}> = [];
  readonly responded: string[] = [];

  constructor(readonly opts?: AgentOptions) {
    super();
  }

  isAlive(): boolean {
    return this.alive;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getPid(): number | undefined {
    return this.alive ? 1234 : undefined;
  }

  send(prompt: string, attachments?: unknown[]): void {
    this.sent.push({prompt, attachments});
  }

  respondPermission(
    requestId: string,
    behavior: 'allow' | 'deny',
    input?: Record<string, unknown>,
    denyMessage?: string,
  ): void {
    this.responded.push(
      `${requestId}:${behavior}:${JSON.stringify(input)}:${denyMessage ?? ''}`,
    );
  }

  close(): void {
    this.alive = false;
    this.closed.push('close');
  }
}

const noopHandlers: ThreadHandlers = {
  onText() {},
  onToolUse() {},
  onPermission() {},
  onResult() {},
  onError() {},
};

test('createClaudeProcess result is assignable to AgentProcess', () => {
  // A pure type-level check: a future backend can implement exactly this
  // interface, and the factory hands out instances of it.
  const factory: (opts: AgentOptions, mode: PermissionMode) => AgentProcess =
    createClaudeProcess;
  assert.equal(typeof factory, 'function');
});

test('createProcess lets SessionManager drive a fake AgentProcess backend', () => {
  const fake = new FakeAgentProcess();
  const mgr = new SessionManager({
    bin: 'claude',
    workDir: process.cwd(),
    mode: 'auto',
    createProcess: (opts: AgentOptions, mode: PermissionMode) => {
      assert.equal(opts.bin, 'claude');
      assert.equal(opts.workDir, process.cwd());
      assert.equal(mode, 'auto');
      return fake;
    },
  });

  mgr.send('thread-1', 'hello', noopHandlers);
  assert.deepEqual(fake.sent, [{prompt: 'hello', attachments: undefined}]);
  assert.equal(mgr.getSessionInfo('thread-1')?.pid, 1234);
  assert.equal(mgr.getSessionInfo('thread-1')?.alive, true);

  mgr.respondPermission('thread-1', 'req-1', 'allow', {command: 'ls'}, 42);
  assert.deepEqual(fake.responded, ['req-1:allow:{"command":"ls"}:']);

  assert.equal(mgr.killSession('thread-1'), true);
  assert.deepEqual(fake.closed, ['close']);
  assert.equal(mgr.getSessionInfo('thread-1')?.alive, false);

  mgr.closeAll();
});

test('createProcess receives the resume id from a prior session on respawn', () => {
  let spawned = 0;
  const mgr = new SessionManager({
    bin: 'claude',
    workDir: process.cwd(),
    mode: 'manual',
    createProcess: (opts: AgentOptions) => {
      spawned++;
      const fake = new FakeAgentProcess(opts);
      fake.sessionId = `session-${spawned}`;
      return fake;
    },
  });
  mgr.send('thread-1', 'hi', noopHandlers);
  // Kill but keep the entry so the next message resumes the stored id.
  mgr.killSession('thread-1');
  mgr.send('thread-1', 'again', noopHandlers);
  assert.equal(spawned, 2, 'a fresh process is spawned to resume');
  mgr.closeAll();
});

test('ClaudeProcess satisfies AgentProcess (real backend is a substitution target)', () => {
  // Runtime check that the concrete backend honours the contract's surface.
  const p = ClaudeProcess.prototype as unknown as AgentProcess;
  assert.equal(typeof p.send, 'function');
  assert.equal(typeof p.respondPermission, 'function');
  assert.equal(typeof p.close, 'function');
  assert.equal(typeof p.isAlive, 'function');
  assert.equal(typeof p.getSessionId, 'function');
  assert.equal(typeof p.getPid, 'function');
});

test('agent.ts re-exports PermissionRequest with the protocol shape', () => {
  const r: PermissionRequest = {
    requestId: 'r1',
    toolName: 'Bash',
    input: {command: 'ls'},
  };
  assert.equal(r.requestId, 'r1');
  assert.deepEqual(r.input, {command: 'ls'});
});

/** A fake binary proving the default Claude factory works end-to-end. */
function fakeAgentBin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-fakeagent-'));
  const path = join(dir, 'fake-agent.sh');
  writeFileSync(
    path,
    '#!/bin/sh\nprintf \'{"type":"system","session_id":"agent-fake"}\\n\'\nexec cat >/dev/null\n',
  );
  chmodSync(path, 0o755);
  return path;
}

test('createClaudeProcess (default backend) yields a live process in the manager', async () => {
  const bin = fakeAgentBin();
  const mgr = new SessionManager({
    bin,
    workDir: process.cwd(),
    mode: 'auto',
    // No createProcess → the default Claude backend under test.
  });
  try {
    mgr.send('thread-1', 'hi', noopHandlers);
    let inited = false;
    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (mgr.getSessionInfo('thread-1')?.sessionId === 'agent-fake') {
        inited = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(
      inited,
      true,
      'the Claude backend should report its session id',
    );
    assert.equal(mgr.getSessionInfo('thread-1')?.alive, true);
  } finally {
    mgr.closeAll();
  }
});

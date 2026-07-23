import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync, mkdtempSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionManager, type ThreadHandlers} from './session.js';

/**
 * These tests use a real (harmless) long-lived child process as the "claude"
 * binary so that isAlive() is genuinely true, then drive the idle reaper with
 * an injected clock. We avoid asserting on wall-clock timing: the reaper scan
 * interval is min(60s, ttl), so with a tiny ttl it fires quickly, and we poll
 * getSessionInfo().alive until it flips.
 */

/**
 * A fake `claude` binary: ignores the flags SessionManager passes and blocks
 * on stdin forever, so it stays alive (like a resident claude process) until
 * the reaper closes its process group. `cat` won't do — it rejects the `--…`
 * flags and exits code 1.
 */
function fakeClaudeBin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-fakeclaude-'));
  const path = join(dir, 'fake-claude.sh');
  // Emit a `system` init line so SessionManager captures a session id (needed
  // to exercise the --resume path), then block on stdin to stay alive until
  // the reaper closes the process group.
  writeFileSync(
    path,
    '#!/bin/sh\nprintf \'{"type":"system","session_id":"sess-fake"}\\n\'\nexec cat >/dev/null\n',
  );
  chmodSync(path, 0o755);
  return path;
}

const FAKE_CLAUDE = fakeClaudeBin();

const noopHandlers: ThreadHandlers = {
  onText() {},
  onToolUse() {},
  onPermission() {},
  onResult() {},
  onError() {},
};

/** Handlers that record every onNotice() string, for asserting visibility. */
function capturingHandlers(): {handlers: ThreadHandlers; notices: string[]} {
  const notices: string[] = [];
  return {
    notices,
    handlers: {
      ...noopHandlers,
      onNotice(text) {
        notices.push(text);
      },
    },
  };
}

/** Poll a predicate until true or timeout; returns whether it became true. */
async function waitFor(
  pred: () => boolean,
  timeoutMs = 3000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

test('idle reaper closes a session idle longer than idleTtlMs', async () => {
  let clock = 1_000_000;
  const mgr = new SessionManager({
    bin: FAKE_CLAUDE,
    workDir: process.cwd(),
    mode: 'auto',
    idleTtlMs: 500, // 500 ms → scan interval is min(60s, 500ms) = 500ms
    now: () => clock,
  });
  try {
    mgr.send('thread-1', 'hi', noopHandlers);
    assert.equal(mgr.getSessionInfo('thread-1')?.alive, true);
    // Let the async session-init line land first; its bump() would otherwise
    // refresh lastActivityMs to the post-advance clock and defeat the reap.
    await waitFor(
      () => mgr.getSessionInfo('thread-1')?.sessionId === 'sess-fake',
    );

    // Advance the injected clock well past the TTL so the next scan reaps it.
    clock += 10_000;
    const reaped = await waitFor(
      () => mgr.getSessionInfo('thread-1')?.alive === false,
    );
    assert.equal(reaped, true, 'idle session should have been reaped');

    // The entry is kept (session id retained) so the next message can --resume.
    assert.notEqual(mgr.getSessionInfo('thread-1'), null);
  } finally {
    mgr.closeAll();
  }
});

test('idle reaper notifies the thread on pause and on resume', async () => {
  let clock = 1_000_000;
  const {handlers, notices} = capturingHandlers();
  const mgr = new SessionManager({
    bin: FAKE_CLAUDE,
    workDir: process.cwd(),
    mode: 'auto',
    idleTtlMs: 500,
    now: () => clock,
  });
  try {
    mgr.send('thread-1', 'hi', handlers);
    // Wait until the fake process reports its session id, so the later respawn
    // has something to --resume (and thus emits the resume notice).
    await waitFor(
      () => mgr.getSessionInfo('thread-1')?.sessionId === 'sess-fake',
    );

    // Reap it, and confirm a pause notice was posted to the thread.
    clock += 10_000;
    await waitFor(() => mgr.getSessionInfo('thread-1')?.alive === false);
    assert.equal(
      notices.some((n) => n.includes('一時停止')),
      true,
      'a pause notice should be posted when the reaper closes the session',
    );

    // The next message resumes it — and announces the resume exactly once.
    const before = notices.length;
    mgr.send('thread-1', 'still there?', handlers);
    assert.equal(mgr.getSessionInfo('thread-1')?.alive, true);
    assert.equal(
      notices.slice(before).some((n) => n.includes('再開')),
      true,
      'a resume notice should be posted when the paused session respawns',
    );
  } finally {
    mgr.closeAll();
  }
});

test('idle reaper leaves an active session alone', async () => {
  let clock = 1_000_000;
  const mgr = new SessionManager({
    bin: FAKE_CLAUDE,
    workDir: process.cwd(),
    mode: 'auto',
    idleTtlMs: 500,
    now: () => clock,
  });
  try {
    mgr.send('thread-1', 'hi', noopHandlers);

    // Keep touching the session (via send) as the clock advances, so it never
    // crosses the idle threshold relative to its last activity. The real-time
    // sleeps total > 500ms so the reaper's setInterval fires at least once
    // mid-loop — otherwise the assertion would pass even if activity tracking
    // (bump/touch) were broken, since no scan would ever run.
    for (let i = 0; i < 5; i++) {
      clock += 200; // less than the 500ms TTL between touches
      mgr.send('thread-1', 'again', noopHandlers);
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(
      mgr.getSessionInfo('thread-1')?.alive,
      true,
      'active session must not be reaped',
    );
  } finally {
    mgr.closeAll();
  }
});

test('idleTtlMs = 0 disables the reaper', async () => {
  let clock = 1_000_000;
  const mgr = new SessionManager({
    bin: FAKE_CLAUDE,
    workDir: process.cwd(),
    mode: 'auto',
    idleTtlMs: 0,
    now: () => clock,
  });
  try {
    mgr.send('thread-1', 'hi', noopHandlers);
    clock += 10_000_000;
    // Give any (nonexistent) reaper a chance to run, then confirm still alive.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(mgr.getSessionInfo('thread-1')?.alive, true);
  } finally {
    mgr.closeAll();
  }
});

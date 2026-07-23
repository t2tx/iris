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
  writeFileSync(path, '#!/bin/sh\nexec cat >/dev/null\n');
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

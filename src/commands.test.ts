import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  handleCommand,
  findDirectories,
  type CommandContext,
} from './commands.js';
import type {SessionManager} from './session.js';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {join, basename} from 'node:path';
import {tmpdir} from 'node:os';

function makeCtx(overrides?: Partial<CommandContext>): CommandContext {
  const mockManager = {
    getSessionInfo: () => ({pid: 123, sessionId: 'sid-abc', alive: true}),
    listSessions: () => [
      {sessionKey: 'thread-1', pid: 123, alive: true},
      {sessionKey: 'thread-2', pid: 456, alive: false},
    ],
    killSession: () => true,
    clearSession: () => true,
    getEffectiveWorkDir: () => '/mock/work',
    getWorkDirOverride: () => undefined,
    setWorkDirOverride: () => {},
    clearWorkDirOverride: () => {},
    setResumeId: () => {},
  } as unknown as SessionManager;

  return {
    sessionKey: 'thread-1',
    manager: mockManager,
    allManagers: new Map([['work', mockManager]]),
    projectName: 'work',
    baseWorkDir: '/mock/work',
    ...overrides,
  };
}

describe('handleCommand', () => {
  it('returns null for non-command messages', () => {
    assert.equal(handleCommand('hello world', makeCtx()), null);
    assert.equal(handleCommand('not a command', makeCtx()), null);
  });

  it('bare unknown /command returns an Unknown-command notice', () => {
    const result = handleCommand('/sessoins', makeCtx());
    assert.ok(result);
    assert.ok(result.text.includes('Unknown command'));
    assert.ok(result.text.includes('/sessoins'));
  });

  it('non-slash text and "/path with spaces" pass through to Claude', () => {
    assert.equal(handleCommand('!unknown', makeCtx()), null);
    // A slash token followed by more words is a normal prompt, not a command.
    assert.equal(handleCommand('/path/to/file を説明して', makeCtx()), null);
  });

  it('/help returns command list', () => {
    const result = handleCommand('/help', makeCtx());
    assert.ok(result);
    assert.ok(result.text.includes('/help'));
    assert.ok(result.text.includes('/status'));
  });

  it('!help is not a command (! prefix removed)', () => {
    assert.equal(handleCommand('!help', makeCtx()), null);
  });

  it('leading space + /help works (Slack DM workaround)', () => {
    const result = handleCommand('  /help', makeCtx());
    assert.ok(result);
    assert.ok(result.text.includes('/help'));
  });

  it('/status returns session info', () => {
    const result = handleCommand('/status', makeCtx());
    assert.ok(result);
    assert.ok(result.text.includes('123'));
    assert.ok(result.text.includes('sid-abc'));
  });

  it('/status with no session', () => {
    const ctx = makeCtx({
      manager: {
        getSessionInfo: () => null,
      } as unknown as SessionManager,
    });
    const result = handleCommand('/status', ctx);
    assert.ok(result);
    assert.ok(result.text.includes('No active session'));
  });

  it('/sessions lists all sessions', () => {
    const result = handleCommand('/sessions', makeCtx());
    assert.ok(result);
    assert.ok(result.text.includes('thread-1'));
    assert.ok(result.text.includes('thread-2'));
  });

  it('/restart restarts the process (resume)', () => {
    const result = handleCommand('/restart', makeCtx());
    assert.ok(result);
    assert.ok(result.text.toLowerCase().includes('resume'));
  });

  it('/clear resets the conversation', () => {
    const result = handleCommand('/clear', makeCtx());
    assert.ok(result);
    assert.ok(result.text.toLowerCase().includes('cleared'));
  });

  it('/new is an alias for /clear', () => {
    const result = handleCommand('/new', makeCtx());
    assert.ok(result);
    assert.ok(result.text.toLowerCase().includes('cleared'));
  });

  it('commands are case-insensitive', () => {
    assert.ok(handleCommand('/HELP', makeCtx()));
    assert.ok(handleCommand('/Status', makeCtx()));
  });

  it('/help includes /switch', () => {
    const result = handleCommand('/help', makeCtx());
    assert.ok(result);
    assert.ok(result.text.includes('/switch'));
  });

  it('/help includes /resume', () => {
    const result = handleCommand('/help', makeCtx());
    assert.ok(result);
    assert.ok(result.text.includes('/resume'));
  });
});

describe('/resume command', () => {
  it('no arg with no sessions reports none found', () => {
    const result = handleCommand('/resume', makeCtx());
    assert.ok(result);
    assert.ok(result.text.includes('No past Claude sessions'));
  });

  it('unknown id reports no match', () => {
    const result = handleCommand('/resume nonexistent-id', makeCtx());
    assert.ok(result);
    assert.ok(result.text.includes('No session matching'));
  });
});

describe('/switch command', () => {
  it('no arg shows current workDir (default)', () => {
    const result = handleCommand('/switch', makeCtx());
    assert.ok(result);
    assert.ok(result.text.includes('/mock/work'));
    assert.ok(result.text.includes('default'));
  });

  it('no arg shows (switched) when overridden', () => {
    const result = handleCommand(
      '/switch',
      makeCtx({
        manager: {
          ...makeCtx().manager,
          getEffectiveWorkDir: () => '/mock/work/argus',
          getWorkDirOverride: () => '/mock/work/argus',
        } as unknown as SessionManager,
      }),
    );
    assert.ok(result);
    assert.ok(result.text.includes('switched'));
  });

  it('/switch - when already at default', () => {
    const result = handleCommand('/switch -', makeCtx());
    assert.ok(result);
    assert.ok(result.text.includes('Already at default'));
  });

  it('/switch - reverts override and clears session (no resume)', () => {
    let overrideCleared = false;
    let sessionCleared = false;
    const result = handleCommand(
      '/switch -',
      makeCtx({
        manager: {
          ...makeCtx().manager,
          getWorkDirOverride: () => '/mock/work/argus',
          clearWorkDirOverride: () => {
            overrideCleared = true;
          },
          clearSession: () => {
            sessionCleared = true;
            return true;
          },
        } as unknown as SessionManager,
      }),
    );
    assert.ok(result);
    assert.ok(result.text.includes('default'));
    assert.ok(overrideCleared);
    assert.ok(sessionCleared);
  });

  it('no match returns not found', () => {
    const result = handleCommand('/switch nonexistent-xyz', makeCtx());
    assert.ok(result);
    assert.ok(result.text.includes('No directory matching'));
  });
});

describe('findDirectories', () => {
  let tmpDir: string;

  // Create a temp directory tree for testing
  function setup(): void {
    tmpDir = mkdtempSync(join(tmpdir(), 'iris-test-'));
    mkdirSync(join(tmpDir, 'mile-code-argus'));
    mkdirSync(join(tmpDir, 'mile', 'mile-service'), {recursive: true});
    mkdirSync(join(tmpDir, 'mile', 'mile-mobile'));
    mkdirSync(join(tmpDir, 'rd', 'iris'), {recursive: true});
    mkdirSync(join(tmpDir, 'node_modules', 'pkg'), {recursive: true});
    mkdirSync(join(tmpDir, '.git'));
  }

  function teardown(): void {
    rmSync(tmpDir, {recursive: true, force: true});
  }

  it('finds directory by partial name', () => {
    setup();
    try {
      const results = findDirectories(tmpDir, 'argus');
      assert.equal(results.length, 1);
      assert.ok(results[0]!.includes('mile-code-argus'));
    } finally {
      teardown();
    }
  });

  it('finds nested directory', () => {
    setup();
    try {
      const results = findDirectories(tmpDir, 'mile-service');
      assert.equal(results.length, 1);
      assert.ok(results[0]!.includes('mile-service'));
    } finally {
      teardown();
    }
  });

  it('prefers exact match over partial', () => {
    setup();
    try {
      // "mile" matches "mile" (exact) and "mile-code-argus", "mile-service", "mile-mobile" (partial)
      const results = findDirectories(tmpDir, 'mile');
      // Exact match: the "mile" directory itself
      assert.equal(results.length, 1);
      assert.equal(basename(results[0]!), 'mile');
    } finally {
      teardown();
    }
  });

  it('skips node_modules and .git', () => {
    setup();
    try {
      const nm = findDirectories(tmpDir, 'node_modules');
      assert.equal(nm.length, 0);
      const git = findDirectories(tmpDir, '.git');
      assert.equal(git.length, 0);
    } finally {
      teardown();
    }
  });

  it('returns empty for no match', () => {
    setup();
    try {
      const results = findDirectories(tmpDir, 'nonexistent');
      assert.equal(results.length, 0);
    } finally {
      teardown();
    }
  });

  it('case-insensitive search', () => {
    setup();
    try {
      const results = findDirectories(tmpDir, 'ARGUS');
      assert.equal(results.length, 1);
      assert.ok(results[0]!.includes('mile-code-argus'));
    } finally {
      teardown();
    }
  });
});

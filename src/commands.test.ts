import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {handleCommand, type CommandContext} from './commands.js';
import type {SessionManager} from './session.js';

function makeCtx(overrides?: Partial<CommandContext>): CommandContext {
  const mockManager = {
    getSessionInfo: () => ({pid: 123, sessionId: 'sid-abc', alive: true}),
    listSessions: () => [
      {sessionKey: 'thread-1', pid: 123, alive: true},
      {sessionKey: 'thread-2', pid: 456, alive: false},
    ],
    killSession: () => true,
    clearSession: () => true,
  } as unknown as SessionManager;

  return {
    sessionKey: 'thread-1',
    manager: mockManager,
    allManagers: new Map([['work', mockManager]]),
    projectName: 'work',
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
});

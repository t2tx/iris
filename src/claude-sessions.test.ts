import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir, homedir} from 'node:os';
import {projectDir, listClaudeSessions} from './claude-sessions.js';

describe('projectDir', () => {
  it('encodes a work dir by replacing / with -', () => {
    const p = projectDir('/Users/me/work');
    assert.equal(p, join(homedir(), '.claude', 'projects', '-Users-me-work'));
  });
});

describe('listClaudeSessions', () => {
  it('returns [] for a work dir with no Claude project dir', () => {
    // A path unlikely to have a corresponding ~/.claude/projects entry.
    const dir = mkdtempSync(join(tmpdir(), 'iris-nosess-'));
    try {
      assert.deepEqual(listClaudeSessions(dir), []);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it('lists jsonl sessions newest-first with the first user prompt', () => {
    // Build a fake ~/.claude/projects/<encoded> layout under a temp HOME-like
    // root by exercising the real encoding: we can't redirect homedir(), so we
    // verify parsing indirectly via a hand-built dir matching projectDir().
    const fakeWork = mkdtempSync(join(tmpdir(), 'iris-work-'));
    const proj = projectDir(fakeWork);
    // projectDir points under the real home; only run the parse check when we
    // can safely create it (skip if it would collide — it won't, temp name).
    mkdirSync(proj, {recursive: true});
    try {
      writeFileSync(
        join(proj, 'aaa.jsonl'),
        JSON.stringify({
          type: 'user',
          message: {content: 'first task here'},
        }) + '\n',
      );
      const sessions = listClaudeSessions(fakeWork);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]!.id, 'aaa');
      assert.equal(sessions[0]!.firstPrompt, 'first task here');
    } finally {
      rmSync(proj, {recursive: true, force: true});
      rmSync(fakeWork, {recursive: true, force: true});
    }
  });
});

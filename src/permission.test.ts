import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  PermissionRegistry,
  permissionBlocks,
  permissionActionKey,
  PermissionActionIds,
} from './permission.js';
import type {PermissionRequest} from './protocol.js';

const req = (requestId: string): PermissionRequest => ({
  requestId,
  toolName: 'Bash',
  input: {command: 'ls'},
});

test('register returns the action key and resolve returns the entry once', () => {
  const reg = new PermissionRegistry();
  const key = reg.register('C1', 'T1', req('r1'), 'T1', 'work', 1);
  assert.equal(key, permissionActionKey(1, 'r1'));

  const got = reg.resolve(key);
  assert.equal(got?.channel, 'C1');
  assert.equal(got?.sessionKey, 'T1');
  assert.equal(got?.threadTs, 'T1');
  assert.equal(got?.project, 'work');
  assert.equal(got?.requestId, 'r1');
  assert.deepEqual(got?.input, {command: 'ls'});

  // second resolve is empty (consumed)
  assert.equal(reg.resolve(key), undefined);
});

test('DM registration has no threadTs but a channel-id session key', () => {
  const reg = new PermissionRegistry();
  const key = reg.register('D1', 'D1', req('r2'), undefined, 'work', 7);

  const got = reg.resolve(key);
  assert.equal(got?.channel, 'D1');
  assert.equal(got?.sessionKey, 'D1');
  assert.equal(got?.threadTs, undefined);
  assert.equal(got?.project, 'work');
  assert.equal(got?.instanceId, 7);
});

test('resolve of unknown key returns undefined', () => {
  const reg = new PermissionRegistry();
  assert.equal(reg.resolve('nope'), undefined);
});

// Regression: keying by an opaque instanceId:requestId guards against a stale
// button. If a request_id is reused by a respawned process, the old button
// (carrying the old generation's key) must NOT resolve the new pending entry.
test('a stale button cannot resolve a new entry that reused the request id', () => {
  const reg = new PermissionRegistry();
  const oldKey = reg.register('C1', 'T1', req('dup'), 'T1', 'work', 1);
  reg.resolve(oldKey); // old request handled/expired
  // New process generation reuses the same request_id.
  const newKey = reg.register('C1', 'T1', req('dup'), 'T1', 'work', 2);
  assert.notEqual(oldKey, newKey);
  // Clicking the stale button (oldKey) finds nothing.
  assert.equal(reg.resolve(oldKey), undefined);
  // The current button still works.
  assert.equal(reg.resolve(newKey)?.instanceId, 2);
});

test('drainSession removes only that session', () => {
  const reg = new PermissionRegistry();
  const a = reg.register('C1', 'T1', req('a'), 'T1', 'work', 1);
  reg.register('C1', 'T1', req('b'), 'T1', 'work', 1);
  const c = reg.register('C1', 'T2', req('c'), 'T2', 'work', 2);

  const drained = reg.drainSession('T1');
  assert.equal(drained.length, 2);
  assert.deepEqual(drained.map((d) => d.requestId).sort(), ['a', 'b']);

  // T2 still resolvable, T1 ids gone
  assert.equal(reg.resolve(a), undefined);
  assert.equal(reg.resolve(c)?.requestId, 'c');
});

test('drainSession with an instanceId drains only that generation', () => {
  const reg = new PermissionRegistry();
  // Same session key, two process generations (e.g. old proc + respawn).
  const oldKey = reg.register('C1', 'T1', req('old'), 'T1', 'work', 1);
  const newKey = reg.register('C1', 'T1', req('new'), 'T1', 'work', 2);

  // A delayed exit from the old process must not drop the new one's request.
  const drained = reg.drainSession('T1', 1);
  assert.deepEqual(
    drained.map((d) => d.requestId),
    ['old'],
  );
  assert.equal(reg.has(oldKey), false);
  assert.equal(reg.has(newKey), true);
});

test('has reflects registration and is cleared by resolve/drain', () => {
  const reg = new PermissionRegistry();
  const key = reg.register('C1', 'T1', req('x'), 'T1', 'work', 1);
  assert.equal(reg.has(key), true);
  reg.resolve(key);
  assert.equal(reg.has(key), false);
});

test('permissionBlocks embeds the action key in both button values', () => {
  const key = permissionActionKey(3, 'r9');
  const blocks = permissionBlocks(req('r9'), key);
  const actions = blocks.find((b) => b['type'] === 'actions') as {
    elements: Array<{action_id: string; value: string}>;
  };
  const byAction = new Map(actions.elements.map((e) => [e.action_id, e.value]));
  assert.equal(byAction.get(PermissionActionIds.allow), key);
  assert.equal(byAction.get(PermissionActionIds.deny), key);
});

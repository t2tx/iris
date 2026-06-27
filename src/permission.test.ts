import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  PermissionRegistry,
  permissionBlocks,
  PermissionActionIds,
} from './permission.js';
import type {PermissionRequest} from './protocol.js';

const req = (requestId: string): PermissionRequest => ({
  requestId,
  toolName: 'Bash',
  input: {command: 'ls'},
});

test('register then resolve returns the pending entry once (channel)', () => {
  const reg = new PermissionRegistry();
  reg.register('C1', 'T1', req('r1'), 'T1', 'work', 1);

  const got = reg.resolve('r1');
  assert.equal(got?.channel, 'C1');
  assert.equal(got?.sessionKey, 'T1');
  assert.equal(got?.threadTs, 'T1');
  assert.equal(got?.project, 'work');
  assert.deepEqual(got?.input, {command: 'ls'});

  // second resolve is empty (consumed)
  assert.equal(reg.resolve('r1'), undefined);
});

test('DM registration has no threadTs but a channel-id session key', () => {
  const reg = new PermissionRegistry();
  reg.register('D1', 'D1', req('r2'), undefined, 'work', 7); // threadTs omitted

  const got = reg.resolve('r2');
  assert.equal(got?.channel, 'D1');
  assert.equal(got?.sessionKey, 'D1');
  assert.equal(got?.threadTs, undefined);
  assert.equal(got?.project, 'work');
  assert.equal(got?.instanceId, 7);
});

test('resolve of unknown id returns undefined', () => {
  const reg = new PermissionRegistry();
  assert.equal(reg.resolve('nope'), undefined);
});

test('drainSession removes only that session', () => {
  const reg = new PermissionRegistry();
  reg.register('C1', 'T1', req('a'), 'T1', 'work', 1);
  reg.register('C1', 'T1', req('b'), 'T1', 'work', 1);
  reg.register('C1', 'T2', req('c'), 'T2', 'work', 2);

  const drained = reg.drainSession('T1');
  assert.equal(drained.length, 2);
  assert.deepEqual(drained.map((d) => d.requestId).sort(), ['a', 'b']);

  // T2 still resolvable, T1 ids gone
  assert.equal(reg.resolve('a'), undefined);
  assert.equal(reg.resolve('c')?.requestId, 'c');
});

test('permissionBlocks embeds requestId in both button values', () => {
  const blocks = permissionBlocks(req('r9'));
  const actions = blocks.find((b) => b['type'] === 'actions') as {
    elements: Array<{action_id: string; value: string}>;
  };
  const byAction = new Map(actions.elements.map((e) => [e.action_id, e.value]));
  assert.equal(byAction.get(PermissionActionIds.allow), 'r9');
  assert.equal(byAction.get(PermissionActionIds.deny), 'r9');
});

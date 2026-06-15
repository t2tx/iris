import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  applyNoReply,
  toSlackMrkdwn,
  toolProgressLine,
  usageFooter,
} from './format.js';

test('applyNoReply: whole reply is the marker → null', () => {
  assert.equal(applyNoReply('NO_REPLY'), null);
  assert.equal(applyNoReply('no_reply'), null); // case-insensitive
  assert.equal(applyNoReply('  NO_REPLY  '), null);
});

test('applyNoReply: reasoning before marker is preserved', () => {
  assert.equal(applyNoReply('Looks fine.\nNO_REPLY'), 'Looks fine.');
  assert.equal(applyNoReply('Done.\n\n  NO_REPLY'), 'Done.');
});

test('applyNoReply: no marker → unchanged (trimmed)', () => {
  assert.equal(applyNoReply('hello world'), 'hello world');
  assert.equal(applyNoReply('  spaced  '), 'spaced');
});

test('applyNoReply: only a marker mid-text is NOT stripped (must be trailing)', () => {
  assert.equal(
    applyNoReply('NO_REPLY but actually reply'),
    'NO_REPLY but actually reply',
  );
});

test('toSlackMrkdwn: bold and headings', () => {
  assert.equal(toSlackMrkdwn('**bold**'), '*bold*');
  assert.equal(toSlackMrkdwn('# Heading'), '*Heading*');
  assert.equal(toSlackMrkdwn('### Sub'), '*Sub*');
});

test('toSlackMrkdwn: plain text untouched', () => {
  assert.equal(toSlackMrkdwn('just text'), 'just text');
});

test('toolProgressLine: summarizes known tools', () => {
  assert.match(toolProgressLine('Bash', {command: 'ls -la'}), /Bash — ls -la/);
  assert.match(
    toolProgressLine('Read', {file_path: '/x/y.ts'}),
    /Read — \/x\/y\.ts/,
  );
});

test('toolProgressLine: unknown tool has no detail', () => {
  assert.equal(toolProgressLine('Mystery', {}).includes('—'), false);
});

test('toolProgressLine: long detail is clipped', () => {
  const long = 'a'.repeat(300);
  const line = toolProgressLine('Bash', {command: long});
  assert.ok(line.length < 200);
  assert.ok(line.endsWith('…'));
});

test('usageFooter: formats token counts and cost', () => {
  const line = usageFooter({
    inputTokens: 8500,
    outputTokens: 250,
    cacheReadTokens: 5000,
    costUSD: 0.0048,
    durationMs: 3200,
  });
  assert.ok(line.includes('in:8.5k'));
  assert.ok(line.includes('out:250'));
  assert.ok(line.includes('cache:5.0k'));
  assert.ok(line.includes('$0.0048'));
  assert.ok(line.includes('3.2s'));
  // wrapped in italic
  assert.ok(line.startsWith('_'));
  assert.ok(line.endsWith('_'));
});

test('usageFooter: omits cache and cost when zero', () => {
  const line = usageFooter({
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    costUSD: 0,
    durationMs: 0,
  });
  assert.ok(!line.includes('cache'));
  assert.ok(!line.includes('$'));
  assert.ok(line.includes('in:100'));
});

test('usageFooter: returns empty string for a no-op turn', () => {
  const line = usageFooter({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUSD: 0,
    durationMs: 0,
  });
  assert.equal(line, '');
});

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

test('toolProgressLine: unknown tool with no usable input has no detail', () => {
  assert.equal(toolProgressLine('Mystery', {}).includes('—'), false);
});

test('toolProgressLine: unknown/MCP tool surfaces a representative field', () => {
  // A generic tool: pull a known-ish key…
  assert.match(
    toolProgressLine('mcp__foo__bar', {query: 'find widgets'}),
    /mcp__foo__bar — find widgets/,
  );
  // …or fall back to the first non-empty string value.
  assert.match(toolProgressLine('Weird', {thing: 'hello'}), /Weird — hello/);
});

test('toolProgressLine: summarizes more built-in tools', () => {
  assert.match(
    toolProgressLine('Task', {subagent_type: 'Explore', description: 'scan'}),
    /Task — Explore — scan/,
  );
  assert.match(
    toolProgressLine('WebFetch', {url: 'https://x'}),
    /WebFetch — https:\/\/x/,
  );
  assert.match(
    toolProgressLine('TodoWrite', {todos: [1, 2, 3]}),
    /TodoWrite — 3 item\(s\)/,
  );
});

test('toolProgressLine: Bash allows long commands, clips only very long ones', () => {
  // A 300-char command is now shown in full (Bash limit raised).
  const cmd = 'echo ' + 'x'.repeat(295);
  assert.ok(!toolProgressLine('Bash', {command: cmd}).endsWith('…'));
  // But an extreme command is still clipped to keep the line bounded.
  const huge = 'a'.repeat(2000);
  const line = toolProgressLine('Bash', {command: huge});
  assert.ok(line.endsWith('…'));
  assert.ok(line.length < 900);
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

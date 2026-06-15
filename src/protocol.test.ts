import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseLine} from './protocol.js';

test('ignores blank and non-JSON lines', () => {
  assert.deepEqual(parseLine(''), []);
  assert.deepEqual(parseLine('   '), []);
  assert.deepEqual(parseLine('not json'), []);
  assert.deepEqual(parseLine('42'), []); // valid JSON but not an object
});

test('ignores unknown and replayed-user events', () => {
  assert.deepEqual(parseLine(JSON.stringify({type: 'user', message: {}})), []);
  assert.deepEqual(parseLine(JSON.stringify({type: 'whatever'})), []);
});

test('system event yields a session id', () => {
  const out = parseLine(JSON.stringify({type: 'system', session_id: 'abc123'}));
  assert.deepEqual(out, [{kind: 'session', sessionId: 'abc123'}]);
});

test('system event without session_id yields nothing', () => {
  assert.deepEqual(parseLine(JSON.stringify({type: 'system', model: 'x'})), []);
});

test('assistant text and thinking parts', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {type: 'text', text: 'hello'},
        {type: 'thinking', thinking: 'hmm'},
        {type: 'text', text: ''}, // empty — skipped
      ],
    },
  });
  assert.deepEqual(parseLine(line), [
    {kind: 'text', text: 'hello'},
    {kind: 'thinking', text: 'hmm'},
  ]);
});

test('assistant tool_use, skipping AskUserQuestion', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {type: 'tool_use', name: 'Bash', input: {command: 'ls'}},
        {type: 'tool_use', name: 'AskUserQuestion', input: {}},
      ],
    },
  });
  assert.deepEqual(parseLine(line), [
    {kind: 'tool_use', toolName: 'Bash', input: {command: 'ls'}},
  ]);
});

test('control_request can_use_tool becomes a permission event', () => {
  const line = JSON.stringify({
    type: 'control_request',
    request_id: 'req-1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Write',
      input: {file_path: '/a'},
    },
  });
  assert.deepEqual(parseLine(line), [
    {
      kind: 'permission',
      request: {
        requestId: 'req-1',
        toolName: 'Write',
        input: {file_path: '/a'},
      },
    },
  ]);
});

test('control_request with other subtype is ignored', () => {
  const line = JSON.stringify({
    type: 'control_request',
    request_id: 'req-2',
    request: {subtype: 'something_else'},
  });
  assert.deepEqual(parseLine(line), []);
});

test('control_request missing request_id is ignored', () => {
  const line = JSON.stringify({
    type: 'control_request',
    request: {subtype: 'can_use_tool', tool_name: 'Bash'},
  });
  assert.deepEqual(parseLine(line), []);
});

test('result event carries the raw payload', () => {
  const raw = {type: 'result', subtype: 'success', total_cost_usd: 0.01};
  const events = parseLine(JSON.stringify(raw));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'result');
  assert.deepEqual((events[0] as {raw: Record<string, unknown>}).raw, raw);
});

test('result event extracts usage info', () => {
  const raw = {
    type: 'result',
    subtype: 'success',
    total_cost_usd: 0.005,
    duration_ms: 2000,
    num_turns: 1,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 0,
    },
  };
  const events = parseLine(JSON.stringify(raw));
  const ev = events[0] as {usage?: {inputTokens: number; costUSD: number}};
  assert.ok(ev.usage);
  assert.equal(ev.usage.inputTokens, 100);
  assert.equal(ev.usage.costUSD, 0.005);
});

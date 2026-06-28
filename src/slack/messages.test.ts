import {test} from 'node:test';
import assert from 'node:assert/strict';
import {acceptMessage} from './messages.js';
import {SeenSet} from '../dedup.js';

const NOW = 1000;

test('accepts a DM with text', () => {
  const seen = new SeenSet();
  const r = acceptMessage(
    {channel_type: 'im', channel: 'D1', ts: '1.1', text: 'hello'},
    seen,
    NOW,
  );
  assert.deepEqual(r, {
    m: {channel_type: 'im', channel: 'D1', ts: '1.1', text: 'hello'},
    prompt: 'hello',
  });
});

test('accepts a threaded channel message', () => {
  const seen = new SeenSet();
  const r = acceptMessage(
    {
      channel_type: 'group',
      channel: 'C1',
      ts: '2.2',
      thread_ts: '1.0',
      text: 'hi',
    },
    seen,
    NOW,
  );
  assert.equal(r?.prompt, 'hi');
});

test('ignores bot messages (including our own)', () => {
  const seen = new SeenSet();
  assert.equal(
    acceptMessage(
      {channel: 'C1', ts: '1.1', bot_id: 'B1', text: 'x'},
      seen,
      NOW,
    ),
    null,
  );
});

test('ignores unsupported subtypes but allows file_share', () => {
  const seen = new SeenSet();
  assert.equal(
    acceptMessage(
      {subtype: 'message_changed', channel: 'C1', ts: '1.1'},
      seen,
      NOW,
    ),
    null,
  );
  const ok = acceptMessage(
    {
      subtype: 'file_share',
      channel_type: 'im',
      channel: 'D1',
      ts: '1.1',
      files: [{name: 'a.pdf'}],
    },
    seen,
    NOW,
  );
  assert.ok(ok); // file-only message is accepted
});

test('ignores empty text with no files', () => {
  const seen = new SeenSet();
  assert.equal(
    acceptMessage(
      {channel_type: 'im', channel: 'D1', ts: '1.1', text: '   '},
      seen,
      NOW,
    ),
    null,
  );
});

// Regression: a top-level channel post (no thread_ts) is handled by the
// app_mention handler, not here. acceptMessage must return BEFORE touching the
// shared SeenSet — otherwise it consumes the client_msg_id and the matching
// app_mention event (same id) is then wrongly rejected as a duplicate, leaving
// the mention unanswered.
test('top-level channel message is dropped WITHOUT consuming the seen-id', () => {
  const seen = new SeenSet();
  const id = 'cmid-1';
  const topLevel = {
    channel_type: 'group',
    channel: 'C1',
    ts: '3.3',
    client_msg_id: id,
    text: '<@U1> test',
  };
  // Dropped (no thread_ts, not a DM).
  assert.equal(acceptMessage(topLevel, seen, NOW), null);
  // Crucially, the id was NOT marked seen: the app_mention handler can still
  // claim it as fresh.
  assert.equal(seen.check(id, NOW), true);
});

test('threaded channel message DOES consume the seen-id (dedup active)', () => {
  const seen = new SeenSet();
  const id = 'cmid-2';
  const threaded = {
    channel_type: 'group',
    channel: 'C1',
    ts: '4.4',
    thread_ts: '1.0',
    client_msg_id: id,
    text: 'follow up',
  };
  assert.ok(acceptMessage(threaded, seen, NOW));
  // The id is now seen, so a retry of the same message is rejected.
  assert.equal(seen.check(id, NOW), false);
});

test('at-least-once duplicate of an accepted message is dropped', () => {
  const seen = new SeenSet();
  const dm = {
    channel_type: 'im',
    channel: 'D1',
    ts: '5.5',
    client_msg_id: 'cmid-3',
    text: 'once',
  };
  assert.ok(acceptMessage(dm, seen, NOW)); // first delivery accepted
  assert.equal(acceptMessage(dm, seen, NOW), null); // retry dropped
});

test('falls back to channel:ts as dedup key when client_msg_id is absent', () => {
  const seen = new SeenSet();
  const dm = {channel_type: 'im', channel: 'D1', ts: '6.6', text: 'no id'};
  assert.ok(acceptMessage(dm, seen, NOW));
  assert.equal(acceptMessage(dm, seen, NOW), null); // same channel:ts → duplicate
});

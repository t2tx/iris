import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {StreamBuffer, type SlackPoster} from './stream-buffer.js';

function makePoster() {
  const calls: Array<{method: string; args: unknown[]}> = [];
  const poster: SlackPoster = {
    post: async (text: string) => {
      calls.push({method: 'post', args: [text]});
      return 'msg-ts-1';
    },
    update: async (ts: string, text: string) => {
      calls.push({method: 'update', args: [ts, text]});
    },
  };
  return {poster, calls};
}

const identity = (s: string) => s;

describe('StreamBuffer', () => {
  it('flush posts a new message on first call', async () => {
    const {poster, calls} = makePoster();
    const buf = new StreamBuffer(poster, identity);
    buf.append('Hello');
    await buf.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, 'post');
    assert.equal(calls[0]!.args[0], 'Hello');
  });

  it('flush updates the same message on second call', async () => {
    const {poster, calls} = makePoster();
    const buf = new StreamBuffer(poster, identity);
    buf.append('Hello');
    await buf.flush();
    buf.append(' world');
    await buf.flush();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.method, 'update');
    assert.equal(calls[1]!.args[0], 'msg-ts-1');
    assert.equal(calls[1]!.args[1], 'Hello world');
  });

  it('flush is a no-op when buffer is empty', async () => {
    const {poster, calls} = makePoster();
    const buf = new StreamBuffer(poster, identity);
    await buf.flush();
    assert.equal(calls.length, 0);
  });

  it('applies format function', async () => {
    const {poster, calls} = makePoster();
    const buf = new StreamBuffer(poster, (s) => s.toUpperCase());
    buf.append('hello');
    await buf.flush();
    assert.equal(calls[0]!.args[0], 'HELLO');
  });

  it('accumulates multiple appends before flush', async () => {
    const {poster, calls} = makePoster();
    const buf = new StreamBuffer(poster, identity);
    buf.append('a');
    buf.append('b');
    buf.append('c');
    await buf.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.args[0], 'abc');
  });

  it('getMessageTs returns null before first post', () => {
    const {poster} = makePoster();
    const buf = new StreamBuffer(poster, identity);
    assert.equal(buf.getMessageTs(), null);
  });

  it('getMessageTs returns ts after first post', async () => {
    const {poster} = makePoster();
    const buf = new StreamBuffer(poster, identity);
    buf.append('x');
    await buf.flush();
    assert.equal(buf.getMessageTs(), 'msg-ts-1');
  });
});

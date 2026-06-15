import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isLogLevel, setLogLevel, log} from './log.js';

test('isLogLevel accepts valid levels, rejects others', () => {
  assert.ok(isLogLevel('debug'));
  assert.ok(isLogLevel('info'));
  assert.ok(isLogLevel('warn'));
  assert.ok(isLogLevel('error'));
  assert.equal(isLogLevel('verbose'), false);
  assert.equal(isLogLevel(''), false);
});

/** Capture console.log/error output during fn(). */
function capture(fn: () => void): {out: string[]; err: string[]} {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (m?: unknown) => out.push(String(m));
  console.error = (m?: unknown) => err.push(String(m));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return {out, err};
}

test('level filtering: warn level drops debug/info', () => {
  setLogLevel('warn');
  const {out, err} = capture(() => {
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
  });
  // debug/info suppressed; warn/error go to stderr.
  assert.equal(out.length, 0);
  assert.equal(err.length, 2);
  assert.ok(err[0]!.includes('WARN w'));
  assert.ok(err[1]!.includes('ERROR e'));
  setLogLevel('info'); // restore default
});

test('level filtering: debug level shows everything', () => {
  setLogLevel('debug');
  const {out, err} = capture(() => {
    log.debug('d');
    log.info('i');
  });
  assert.equal(out.length, 2);
  assert.equal(err.length, 0);
  assert.ok(out[0]!.includes('DEBUG d'));
  setLogLevel('info');
});

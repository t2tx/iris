import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SeenSet} from './dedup.js';

test('first sighting is fresh, immediate repeat is a duplicate', () => {
  const s = new SeenSet();
  assert.equal(s.check('a', 1000), true);
  assert.equal(s.check('a', 1001), false);
  assert.equal(s.check('a', 1002), false);
});

test('distinct ids are independent', () => {
  const s = new SeenSet();
  assert.equal(s.check('a', 1000), true);
  assert.equal(s.check('b', 1000), true);
  assert.equal(s.check('a', 1000), false);
});

test('an id seen again after the TTL (with no intervening hit) is fresh again', () => {
  const s = new SeenSet(1000); // 1s TTL
  assert.equal(s.check('a', 0), true);
  // No check within the window, so the timestamp stays at 0.
  assert.equal(s.check('a', 1000), true); // TTL elapsed → fresh again
  assert.equal(s.check('a', 1001), false); // immediate repeat → duplicate
});

test('a burst of retries keeps extending the dedup window', () => {
  const s = new SeenSet(1000);
  assert.equal(s.check('a', 0), true);
  assert.equal(s.check('a', 800), false); // refreshes timestamp to 800
  assert.equal(s.check('a', 1500), false); // 1500-800 < 1000 → still duplicate
});

test('empty/undefined ids are always treated as fresh', () => {
  const s = new SeenSet();
  assert.equal(s.check(undefined, 1), true);
  assert.equal(s.check(undefined, 1), true);
  assert.equal(s.check('', 1), true);
  assert.equal(s.check('', 1), true);
});

test('size is capped (old entries evicted)', () => {
  const s = new SeenSet(10 * 60 * 1000, 3); // max 3
  s.check('a', 0);
  s.check('b', 0);
  s.check('c', 0);
  s.check('d', 0); // triggers eviction of oldest ('a')
  // 'a' was evicted → treated as fresh again
  assert.equal(s.check('a', 0), true);
  // 'd' is still remembered
  assert.equal(s.check('d', 0), false);
});

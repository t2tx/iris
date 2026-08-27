import { expect, test } from "vitest";

import { SeenSet } from "./dedup.js";

test("first sighting is fresh, immediate repeat is a duplicate", () => {
	const s = new SeenSet();
	expect(s.check("a", 1000)).toBe(true);
	expect(s.check("a", 1001)).toBe(false);
	expect(s.check("a", 1002)).toBe(false);
});

test("distinct ids are independent", () => {
	const s = new SeenSet();
	expect(s.check("a", 1000)).toBe(true);
	expect(s.check("b", 1000)).toBe(true);
	expect(s.check("a", 1000)).toBe(false);
});

test("an id seen again after the TTL (with no intervening hit) is fresh again", () => {
	const s = new SeenSet(1000); // 1s TTL
	expect(s.check("a", 0)).toBe(true);
	// No check within the window, so the timestamp stays at 0.
	expect(s.check("a", 1000)).toBe(true); // TTL elapsed → fresh again
	expect(s.check("a", 1001)).toBe(false); // immediate repeat → duplicate
});

test("a burst of retries keeps extending the dedup window", () => {
	const s = new SeenSet(1000);
	expect(s.check("a", 0)).toBe(true);
	expect(s.check("a", 800)).toBe(false); // refreshes timestamp to 800
	expect(s.check("a", 1500)).toBe(false); // 1500-800 < 1000 → still duplicate
});

test("empty/undefined ids are always treated as fresh", () => {
	const s = new SeenSet();
	expect(s.check(undefined, 1)).toBe(true);
	expect(s.check(undefined, 1)).toBe(true);
	expect(s.check("", 1)).toBe(true);
	expect(s.check("", 1)).toBe(true);
});

test("size is capped (old entries evicted)", () => {
	const s = new SeenSet(10 * 60 * 1000, 3); // max 3
	s.check("a", 0);
	s.check("b", 0);
	s.check("c", 0);
	s.check("d", 0); // triggers eviction of oldest ('a')
	// 'a' was evicted → treated as fresh again
	expect(s.check("a", 0)).toBe(true);
	// 'd' is still remembered
	expect(s.check("d", 0)).toBe(false);
});

test("a refreshed id survives capacity eviction (moved to newest)", () => {
	const s = new SeenSet(10 * 60 * 1000, 3); // max 3
	s.check("a", 0);
	s.check("b", 0);
	s.check("c", 0);
	s.check("a", 1); // duplicate hit for 'a' → re-inserted as the newest entry
	s.check("d", 1); // overflow → evicts the now-oldest, which is 'b' (not 'a')
	expect(s.check("a", 2)).toBe(false); // 'a' survived
	expect(s.check("b", 2)).toBe(true); // 'b' was evicted → fresh again
});

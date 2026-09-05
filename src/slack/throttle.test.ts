import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackThrottle } from "./throttle.js";

describe("SlackThrottle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves immediately on first call", async () => {
		const throttle = new SlackThrottle(3_000);
		const p = throttle.enqueue("ch1");
		await vi.advanceTimersByTimeAsync(0);
		await expect(p).resolves.toBeUndefined();
	});

	it("delays subsequent calls by minIntervalMs", async () => {
		const throttle = new SlackThrottle(3_000);

		// First call — immediate.
		const p1 = throttle.enqueue("ch1");
		await vi.advanceTimersByTimeAsync(0);
		await p1;

		// Second call — should wait ~3 000 ms.
		let resolved = false;
		const p2 = throttle.enqueue("ch1").then(() => {
			resolved = true;
		});

		// Not yet after 2 999 ms.
		await vi.advanceTimersByTimeAsync(2_999);
		expect(resolved).toBe(false);

		// Resolved after 3 000 ms.
		await vi.advanceTimersByTimeAsync(1);
		await p2;
		expect(resolved).toBe(true);
	});

	it("does not delay calls on different keys", async () => {
		const throttle = new SlackThrottle(3_000);

		const p1 = throttle.enqueue("ch1");
		await vi.advanceTimersByTimeAsync(0);
		await p1;

		// Different key — should resolve immediately.
		const p2 = throttle.enqueue("ch2");
		await vi.advanceTimersByTimeAsync(0);
		await expect(p2).resolves.toBeUndefined();
	});

	it("serialises concurrent enqueues on the same key", async () => {
		const throttle = new SlackThrottle(3_000);

		const order: number[] = [];

		const p1 = throttle.enqueue("ch1").then(() => order.push(1));
		const p2 = throttle.enqueue("ch1").then(() => order.push(2));
		const p3 = throttle.enqueue("ch1").then(() => order.push(3));

		// 0 ms: first resolves
		await vi.advanceTimersByTimeAsync(0);
		await p1;
		expect(order).toEqual([1]);

		// 3 000 ms: second resolves
		await vi.advanceTimersByTimeAsync(3_000);
		await p2;
		expect(order).toEqual([1, 2]);

		// 6 000 ms: third resolves
		await vi.advanceTimersByTimeAsync(3_000);
		await p3;
		expect(order).toEqual([1, 2, 3]);
	});

	it("does not break the chain when a caller rejects", async () => {
		const throttle = new SlackThrottle(3_000);

		// First enqueue resolves normally.
		const p1 = throttle.enqueue("ch1");
		await vi.advanceTimersByTimeAsync(0);
		await p1;

		// Simulate: enqueue resolves, but the caller's follow-up throws.
		// Attach a no-op catch so Node doesn't treat it as unhandled.
		const p2 = throttle.enqueue("ch1").then(() => {
			throw new Error("boom");
		});
		p2.catch(() => {}); // prevent unhandled rejection warning
		await vi.advanceTimersByTimeAsync(3_000);
		await expect(p2).rejects.toThrow("boom");

		// Third enqueue should still resolve.
		const p3 = throttle.enqueue("ch1");
		await vi.advanceTimersByTimeAsync(3_000);
		await expect(p3).resolves.toBeUndefined();
	});
});

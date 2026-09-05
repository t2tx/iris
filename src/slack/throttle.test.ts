import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackThrottle } from "./throttle.js";

describe("SlackThrottle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const noop = async () => {};

	it("resolves immediately on first call", async () => {
		const throttle = new SlackThrottle(3_000);
		const p = throttle.enqueue("ch1", noop);
		await vi.advanceTimersByTimeAsync(0);
		await expect(p).resolves.toBeUndefined();
	});

	it("returns the operation result", async () => {
		const throttle = new SlackThrottle(3_000);
		const p = throttle.enqueue("ch1", async () => "hello");
		await vi.advanceTimersByTimeAsync(0);
		await expect(p).resolves.toBe("hello");
	});

	it("delays subsequent calls by minIntervalMs", async () => {
		const throttle = new SlackThrottle(3_000);

		const p1 = throttle.enqueue("ch1", noop);
		await vi.advanceTimersByTimeAsync(0);
		await p1;

		let resolved = false;
		const p2 = throttle.enqueue("ch1", noop).then(() => {
			resolved = true;
		});

		await vi.advanceTimersByTimeAsync(2_999);
		expect(resolved).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		await p2;
		expect(resolved).toBe(true);
	});

	it("does not delay calls on different keys", async () => {
		const throttle = new SlackThrottle(3_000);

		const p1 = throttle.enqueue("ch1", noop);
		await vi.advanceTimersByTimeAsync(0);
		await p1;

		const p2 = throttle.enqueue("ch2", noop);
		await vi.advanceTimersByTimeAsync(0);
		await expect(p2).resolves.toBeUndefined();
	});

	it("serialises concurrent enqueues on the same key", async () => {
		const throttle = new SlackThrottle(3_000);

		const order: number[] = [];

		const p1 = throttle.enqueue("ch1", async () => {
			order.push(1);
		});
		const p2 = throttle.enqueue("ch1", async () => {
			order.push(2);
		});
		const p3 = throttle.enqueue("ch1", async () => {
			order.push(3);
		});

		await vi.advanceTimersByTimeAsync(0);
		await p1;
		expect(order).toEqual([1]);

		await vi.advanceTimersByTimeAsync(3_000);
		await p2;
		expect(order).toEqual([1, 2]);

		await vi.advanceTimersByTimeAsync(3_000);
		await p3;
		expect(order).toEqual([1, 2, 3]);
	});

	it("waits for operation to settle before starting next", async () => {
		const throttle = new SlackThrottle(3_000);
		const events: string[] = [];

		// First op takes 5 000 ms (longer than the interval).
		const p1 = throttle.enqueue("ch1", async () => {
			events.push("op1:start");
			await new Promise((r) => setTimeout(r, 5_000));
			events.push("op1:end");
		});

		// Second op enqueued immediately.
		const p2 = throttle.enqueue("ch1", async () => {
			events.push("op2:start");
		});

		// t=0: op1 starts
		await vi.advanceTimersByTimeAsync(0);
		expect(events).toEqual(["op1:start"]);

		// t=3000: interval elapsed but op1 still running — op2 must NOT start.
		await vi.advanceTimersByTimeAsync(3_000);
		expect(events).toEqual(["op1:start"]);

		// t=5000: op1 settles
		await vi.advanceTimersByTimeAsync(2_000);
		await p1;
		expect(events).toEqual(["op1:start", "op1:end"]);

		// t=8000: 3 000 ms interval after op1 settled → op2 starts.
		await vi.advanceTimersByTimeAsync(3_000);
		await p2;
		expect(events).toEqual(["op1:start", "op1:end", "op2:start"]);
	});

	it("does not break the chain when an operation rejects", async () => {
		const throttle = new SlackThrottle(3_000);

		const p1 = throttle.enqueue("ch1", noop);
		await vi.advanceTimersByTimeAsync(0);
		await p1;

		const p2 = throttle.enqueue("ch1", async () => {
			throw new Error("boom");
		});
		p2.catch(() => {}); // prevent unhandled rejection warning
		await vi.advanceTimersByTimeAsync(3_000);
		await expect(p2).rejects.toThrow("boom");

		// Third enqueue should still resolve after the interval.
		const p3 = throttle.enqueue("ch1", noop);
		await vi.advanceTimersByTimeAsync(3_000);
		await expect(p3).resolves.toBeUndefined();
	});
});

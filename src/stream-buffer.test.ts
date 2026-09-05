import { describe, expect, it } from "vitest";

import { type SlackPoster, StreamBuffer } from "./stream-buffer.js";

function makePoster() {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const poster: SlackPoster = {
		post: async (text: string) => {
			calls.push({ method: "post", args: [text] });
			return "msg-ts-1";
		},
		update: async (ts: string, text: string) => {
			calls.push({ method: "update", args: [ts, text] });
		},
	};
	return { poster, calls };
}

const identity = (s: string) => s;

// A poster whose post/update both reject — models a transient Slack failure.
const failingPoster: SlackPoster = {
	post: async () => {
		throw new Error("failed to fetch");
	},
	update: async () => {
		throw new Error("failed to fetch");
	},
};

describe("StreamBuffer", () => {
	it("flush posts a new message on first call", async () => {
		const { poster, calls } = makePoster();
		const buf = new StreamBuffer(poster, identity);
		buf.append("Hello");
		await buf.flush();
		expect(calls.length).toBe(1);
		expect(calls[0]!.method).toBe("post");
		expect(calls[0]!.args[0]).toBe("Hello");
	});

	it("flush updates the same message on second call", async () => {
		const { poster, calls } = makePoster();
		const buf = new StreamBuffer(poster, identity);
		buf.append("Hello");
		await buf.flush();
		buf.append(" world");
		await buf.flush();
		expect(calls.length).toBe(2);
		expect(calls[1]!.method).toBe("update");
		expect(calls[1]!.args[0]).toBe("msg-ts-1");
		expect(calls[1]!.args[1]).toBe("Hello world");
	});

	it("flush is a no-op when buffer is empty", async () => {
		const { poster, calls } = makePoster();
		const buf = new StreamBuffer(poster, identity);
		await buf.flush();
		expect(calls.length).toBe(0);
	});

	it("applies format function", async () => {
		const { poster, calls } = makePoster();
		const buf = new StreamBuffer(poster, (s) => s.toUpperCase());
		buf.append("hello");
		await buf.flush();
		expect(calls[0]!.args[0]).toBe("HELLO");
	});

	it("accumulates multiple appends before flush", async () => {
		const { poster, calls } = makePoster();
		const buf = new StreamBuffer(poster, identity);
		buf.append("a");
		buf.append("b");
		buf.append("c");
		await buf.flush();
		expect(calls.length).toBe(1);
		expect(calls[0]!.args[0]).toBe("abc");
	});

	it("getMessageTs returns null before first post", () => {
		const { poster } = makePoster();
		const buf = new StreamBuffer(poster, identity);
		expect(buf.getMessageTs()).toBe(null);
	});

	it("getMessageTs returns ts after first post", async () => {
		const { poster } = makePoster();
		const buf = new StreamBuffer(poster, identity);
		buf.append("x");
		await buf.flush();
		expect(buf.getMessageTs()).toBe("msg-ts-1");
	});

	it("raw chunk accumulation preserves inter-word spaces (Pi text_delta)", async () => {
		// Token-level deltas carry surrounding spaces; appending RAW must keep
		// them. The streaming path must NOT trim per chunk (that clobbered
		// inter-word spaces for token streams such as Pi's text_delta).
		const { poster, calls } = makePoster();
		const buf = new StreamBuffer(poster, identity);
		for (const c of ["I'm", " ready", " to", " help"]) buf.append(c);
		await buf.flush();
		expect(calls[0]!.args[0]).toBe("I'm ready to help");
		expect(buf.getFullText()).toBe("I'm ready to help");
	});

	// Issue #65 (fire-and-forget flood): a rejecting poster must NOT make
	// flush() reject, or the fire-and-forget callers (onText via append and the
	// scheduleUpdate timer's `void pushToSlack`) would each surface an unhandled
	// promise rejection. pushToSlack now catches-and-logs instead.
	it("flush swallows a rejecting poster (no unhandled rejection)", async () => {
		const buf = new StreamBuffer(failingPoster, identity);
		buf.append("hello");
		// Must resolve (not reject) even though the underlying post fails.
		await expect(buf.flush()).resolves.toBeUndefined();
		expect(buf.getFullText()).toBe("hello");
		// A second flush is also safe.
		await expect(buf.flush()).resolves.toBeUndefined();
	});

	// Regression: a streaming update (timer-fired `pushToSlack(true)`) that is still
	// in flight when the turn ends must NOT swallow the terminal full-text flush. The
	// old `if (this.flushing) return;` guard silently dropped the final `flush()`
	// update, leaving the bubble at a stale partial frame with the ✍️ typing
	// indicator stuck (Slack: ":writing_hand:") — the symptom seen when Copilot
	// streamed a short answer followed by rapid messages. The terminal flush must
	// always land the FULL accumulated text without the typing indicator.
	it("terminal flush lands full text even when a streaming update is in-flight", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		const { poster, calls } = makePoster();
		// Gate the second update so it stays parked mid-stream like a slow Slack
		// `chat.update` call; the first POST (messageTs allocation) stays instant.
		const gatedPoster: SlackPoster = {
			post: (t) => poster.post(t),
			update: async (ts: string, text: string) => {
				calls.push({ method: "update", args: [ts, text] });
				await gate; // park the in-flight streaming update
			},
		};
		const buf = new StreamBuffer(gatedPoster, identity);
		const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

		// 1st timer tick → POST "Hello ✍️" (first message, no update yet).
		buf.append("Hello");
		await wait(600);
		// 2nd timer tick → update("…", "Hello world ✍️") — gated, in flight.
		buf.append(" world");
		await wait(600);
		// While the streaming update is parked, the turn ends: more text + flush().
		// flush() is non-blocking: it registers the terminal update as pendingFinal.
		buf.append(" again");
		void buf.flush(); // schedules the full-text terminal update (re-queued)
		// Release the parked update; its finally re-runs the pending terminal flush
		// with the FULL text and the typing indicator off.
		release();
		await gate;
		await wait(50); // let the re-fired terminal update land

		const updates = calls.filter((c) => c.method === "update");
		const last = updates[updates.length - 1]!;
		expect(last.args[1]).toBe("Hello world again");
	});
});

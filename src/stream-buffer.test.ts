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
});

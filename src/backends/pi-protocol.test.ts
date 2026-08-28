import { expect, test } from "vitest";

import { parsePiLine } from "./pi-protocol.js";

test("ignores blank and non-JSON lines", () => {
	expect(parsePiLine("")).toEqual([]);
	expect(parsePiLine("   ")).toEqual([]);
	expect(parsePiLine("not json")).toEqual([]);
	expect(parsePiLine("42")).toEqual([]); // valid JSON but not an object
	expect(parsePiLine("null")).toEqual([]); // JSON null → ignored
});

test("ignores out-of-scope event types", () => {
	// "response" — command response, handled by PiProcess
	expect(
		parsePiLine(JSON.stringify({ type: "response", id: "cmd-1", result: {} })),
	).toEqual([]);
	// "extension_ui_request" — UI dialog, handled by PiProcess
	expect(
		parsePiLine(
			JSON.stringify({ type: "extension_ui_request", dialog: "confirm" }),
		),
	).toEqual([]);
	// Unknown future type
	expect(parsePiLine(JSON.stringify({ type: "whatever_future" }))).toEqual([]);
});

// ── message_update: text_delta ──────────────────────────────────────────

test("message_update text_delta yields a text event", () => {
	const line = JSON.stringify({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "hello world" },
	});
	expect(parsePiLine(line)).toEqual([{ kind: "text", text: "hello world" }]);
});

test("message_update text_delta falls back to 'text' field", () => {
	const line = JSON.stringify({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", text: "fallback" },
	});
	expect(parsePiLine(line)).toEqual([{ kind: "text", text: "fallback" }]);
});

test("message_update text_delta with empty delta is skipped", () => {
	const line = JSON.stringify({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "" },
	});
	expect(parsePiLine(line)).toEqual([]);
});

test("message_update text_delta with non-string delta is skipped", () => {
	const line = JSON.stringify({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: 123 },
	});
	expect(parsePiLine(line)).toEqual([]);
});

// ── message_update: thinking_delta ──────────────────────────────────────

test("message_update thinking_delta yields a thinking event", () => {
	const line = JSON.stringify({
		type: "message_update",
		assistantMessageEvent: {
			type: "thinking_delta",
			delta: "hmm let me think",
		},
	});
	expect(parsePiLine(line)).toEqual([
		{ kind: "thinking", text: "hmm let me think" },
	]);
});

test("message_update thinking_delta falls back to 'text' field", () => {
	const line = JSON.stringify({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", text: "fall" },
	});
	expect(parsePiLine(line)).toEqual([{ kind: "thinking", text: "fall" }]);
});

test("message_update thinking_delta with empty delta is skipped", () => {
	const line = JSON.stringify({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "" },
	});
	expect(parsePiLine(line)).toEqual([]);
});

// ── message_update: toolcall_start ──────────────────────────────────────

test("message_update toolcall_start yields a tool_use event", () => {
	const line = JSON.stringify({
		type: "message_update",
		assistantMessageEvent: {
			type: "toolcall_start",
			toolName: "Bash",
			input: { command: "ls -la" },
		},
	});
	expect(parsePiLine(line)).toEqual([
		{ kind: "tool_use", toolName: "Bash", input: { command: "ls -la" } },
	]);
});

test("message_update toolcall_start falls back to 'arguments' field", () => {
	const line = JSON.stringify({
		type: "message_update",
		assistantMessageEvent: {
			type: "toolcall_start",
			toolName: "Edit",
			arguments: { path: "/tmp/x" },
		},
	});
	expect(parsePiLine(line)).toEqual([
		{ kind: "tool_use", toolName: "Edit", input: { path: "/tmp/x" } },
	]);
});

test("message_update toolcall_start with no toolName defaults to 'tool'", () => {
	const line = JSON.stringify({
		type: "message_update",
		assistantMessageEvent: {
			type: "toolcall_start",
			input: {},
		},
	});
	expect(parsePiLine(line)).toEqual([
		{ kind: "tool_use", toolName: "tool", input: {} },
	]);
});

test("message_update toolcall_start with no input or arguments defaults to {}", () => {
	const line = JSON.stringify({
		type: "message_update",
		assistantMessageEvent: {
			type: "toolcall_start",
			toolName: "Read",
		},
	});
	expect(parsePiLine(line)).toEqual([
		{ kind: "tool_use", toolName: "Read", input: {} },
	]);
});

// ── message_update: message_start ───────────────────────────────────────

test("message_update message_start with sessionId yields a session event", () => {
	const line = JSON.stringify({
		type: "message_update",
		assistantMessageEvent: {
			type: "message_start",
			sessionId: "sess-abc-123",
		},
	});
	expect(parsePiLine(line)).toEqual([
		{ kind: "session", sessionId: "sess-abc-123" },
	]);
});

test("message_update message_start without sessionId yields nothing", () => {
	const line = JSON.stringify({
		type: "message_update",
		assistantMessageEvent: {
			type: "message_start",
		},
	});
	expect(parsePiLine(line)).toEqual([]);
});

// ── message_update: unknown subtype ─────────────────────────────────────

test("message_update with unknown assistantMessageEvent type is ignored", () => {
	const line = JSON.stringify({
		type: "message_update",
		assistantMessageEvent: { type: "unknown_sub", foo: "bar" },
	});
	expect(parsePiLine(line)).toEqual([]);
});

test("message_update with missing assistantMessageEvent yields nothing", () => {
	expect(parsePiLine(JSON.stringify({ type: "message_update" }))).toEqual([]);
});

test("message_update with non-object assistantMessageEvent yields nothing", () => {
	expect(
		parsePiLine(
			JSON.stringify({ type: "message_update", assistantMessageEvent: 42 }),
		),
	).toEqual([]);
});

// ── agent_settled ───────────────────────────────────────────────────────

test("agent_settled yields a result event with raw passthrough and undefined usage", () => {
	const raw = {
		type: "agent_settled",
		status: "completed",
		duration: 1234,
		turns: 2,
		extra: { foo: "bar" },
	};
	const events = parsePiLine(JSON.stringify(raw));
	expect(events.length).toBe(1);
	expect(events[0]?.kind).toBe("result");
	// raw must be the full original JSON
	expect((events[0] as { raw: Record<string, unknown> }).raw).toEqual(raw);
	// usage must be undefined (WBS-3 will add usage extraction)
	expect((events[0] as { usage?: unknown }).usage).toBeUndefined();
});

test("agent_settled with empty object still yields a result", () => {
	const raw = { type: "agent_settled" };
	const events = parsePiLine(JSON.stringify(raw));
	expect(events.length).toBe(1);
	expect(events[0]?.kind).toBe("result");
	expect((events[0] as { raw: Record<string, unknown> }).raw).toEqual(raw);
	expect((events[0] as { usage?: unknown }).usage).toBeUndefined();
});

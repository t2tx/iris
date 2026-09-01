import { expect, test } from "vitest";

import { parseHermesLine } from "./hermes-protocol.js";

/**
 * hermes-protocol.ts — pure parser for Hermes ACP (`hermes acp`) stdout.
 * Shapes verified against a real `hermes acp` capture (v0.20.6).
 */

// ── non-JSON / out-of-scope ──────────────────────────────────────────────

test("ignores blank and non-JSON lines", () => {
	expect(parseHermesLine("")).toEqual([]);
	expect(parseHermesLine("    ")).toEqual([]);
	expect(parseHermesLine("not json")).toEqual([]);
	expect(parseHermesLine("42")).toEqual([]); // valid JSON but not an object
	expect(parseHermesLine("null")).toEqual([]); // JSON null → ignored
});

test("ignores agent→client JSON-RPC requests (handled by hermes.ts)", () => {
	// session/request_permission is a JSON-RPC request to the client; the
	// permission bridge (WBS-6) owns it, not the pure stream parser.
	expect(
		parseHermesLine(
			JSON.stringify({
				jsonrpc: "2.0",
				id: "perm-1",
				method: "session/request_permission",
				params: { session_id: "s", options: [], tool_call: {} },
			}),
		),
	).toEqual([]);
	// Unknown future method → ignored.
	expect(
		parseHermesLine(JSON.stringify({ jsonrpc: "2.0", method: "future_thing" })),
	).toEqual([]);
});

test("ignores out-of-scope session/update subtypes", () => {
	// usage_update
	expect(
		parseHermesLine(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "session/update",
				params: {
					sessionId: "s",
					update: {
						sessionUpdate: "usage_update",
						size: 262144,
						used: 8118,
					},
				},
			}),
		),
	).toEqual([]);
	// available_commands_update
	expect(
		parseHermesLine(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "session/update",
				params: {
					sessionId: "s",
					update: { sessionUpdate: "available_commands_update" },
				},
			}),
		),
	).toEqual([]);
	// session_info_update
	expect(
		parseHermesLine(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "session/update",
				params: {
					sessionId: "s",
					update: {
						sessionUpdate: "session_info_update",
						title: "foo",
					},
				},
			}),
		),
	).toEqual([]);
	// Unknown future subtype
	expect(
		parseHermesLine(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "session/update",
				params: {
					sessionId: "s",
					update: { sessionUpdate: "whatever_future" },
				},
			}),
		),
	).toEqual([]);
});

test("session/update with missing update yields nothing", () => {
	expect(parseHermesLine(JSON.stringify({ method: "session/update" }))).toEqual(
		[],
	);
	expect(
		parseHermesLine(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "session/update",
				params: {},
			}),
		),
	).toEqual([]);
});

// ── session/update: agent_message_chunk ───────────────────────────────────

test("agent_message_chunk yields a text event", () => {
	const line = JSON.stringify({
		jsonrpc: "2.0",
		method: "session/update",
		params: {
			sessionId: "s",
			update: {
				content: { text: "hello world", type: "text" },
				sessionUpdate: "agent_message_chunk",
			},
		},
	});
	expect(parseHermesLine(line)).toEqual([
		{ kind: "text", text: "hello world" },
	]);
});

test("agent_message_chunk with empty text is skipped", () => {
	const line = JSON.stringify({
		jsonrpc: "2.0",
		method: "session/update",
		params: {
			sessionId: "s",
			update: {
				content: { text: "", type: "text" },
				sessionUpdate: "agent_message_chunk",
			},
		},
	});
	expect(parseHermesLine(line)).toEqual([]);
});

test("agent_message_chunk with non-string text is skipped", () => {
	const line = JSON.stringify({
		jsonrpc: "2.0",
		method: "session/update",
		params: {
			sessionId: "s",
			update: {
				content: { text: 123, type: "text" },
				sessionUpdate: "agent_message_chunk",
			},
		},
	});
	expect(parseHermesLine(line)).toEqual([]);
});

test("agent_message_chunk with missing content is skipped", () => {
	const line = JSON.stringify({
		jsonrpc: "2.0",
		method: "session/update",
		params: {
			sessionId: "s",
			update: { sessionUpdate: "agent_message_chunk" },
		},
	});
	expect(parseHermesLine(line)).toEqual([]);
});

// ── session/update: agent_thought_chunk ───────────────────────────────────

test("agent_thought_chunk yields a thinking event", () => {
	const line = JSON.stringify({
		jsonrpc: "2.0",
		method: "session/update",
		params: {
			sessionId: "s",
			update: {
				content: { text: "hmm, let me think", type: "text" },
				sessionUpdate: "agent_thought_chunk",
			},
		},
	});
	expect(parseHermesLine(line)).toEqual([
		{ kind: "thinking", text: "hmm, let me think" },
	]);
});

test("agent_thought_chunk with empty text is skipped", () => {
	const line = JSON.stringify({
		jsonrpc: "2.0",
		method: "session/update",
		params: {
			sessionId: "s",
			update: {
				content: { text: "", type: "text" },
				sessionUpdate: "agent_thought_chunk",
			},
		},
	});
	expect(parseHermesLine(line)).toEqual([]);
});

// ── session/update: tool_call ──────────────────────────────────────────────

test("tool_call yields a tool_use event (toolName from title, input from content)", () => {
	const content = [
		{
			content: { text: "Memory replace (memory)\nPreview: ...", type: "text" },
			type: "content",
		},
	];
	const line = JSON.stringify({
		jsonrpc: "2.0",
		method: "session/update",
		params: {
			sessionId: "s",
			update: {
				toolCallId: "tc-bb46d7200d0b",
				title: "memory replace: memory",
				kind: "other",
				locations: [],
				content,
				sessionUpdate: "tool_call",
			},
		},
	});
	expect(parseHermesLine(line)).toEqual([
		{ kind: "tool_use", toolName: "memory replace: memory", input: content },
	]);
});

test("tool_call with no title defaults to 'tool'", () => {
	const line = JSON.stringify({
		jsonrpc: "2.0",
		method: "session/update",
		params: {
			sessionId: "s",
			update: {
				toolCallId: "tc-1",
				kind: "execute",
				sessionUpdate: "tool_call",
			},
		},
	});
	expect(parseHermesLine(line)).toEqual([
		{ kind: "tool_use", toolName: "tool", input: {} },
	]);
});

// ── JSON-RPC responses ──────────────────────────────────────────────────

test("session/new response with sessionId yields a session event", () => {
	const line = JSON.stringify({
		jsonrpc: "2.0",
		id: 2,
		result: {
			sessionId: "5a25801a-ce80-4c41-8c58-532b02ef0ddc",
			models: [{ id: "m" }],
			modes: { availableModes: ["default"], currentModeId: "default" },
		},
	});
	expect(parseHermesLine(line)).toEqual([
		{ kind: "session", sessionId: "5a25801a-ce80-4c41-8c58-532b02ef0ddc" },
	]);
});

test("session/new response without sessionId yields nothing", () => {
	const line = JSON.stringify({
		jsonrpc: "2.0",
		id: 2,
		result: { models: [], modes: {} },
	});
	expect(parseHermesLine(line)).toEqual([]);
});

test("initialize response (agentCapabilities only, no sessionId) is ignored", () => {
	const line = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		result: {
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { image: true },
				sessionCapabilities: { fork: {}, list: {}, resume: {} },
			},
			agentInfo: { name: "hermes-agent", version: "0.20.6" },
			protocolVersion: 1,
		},
	});
	expect(parseHermesLine(line)).toEqual([]);
});

test("session/prompt result with stopReason yields a result event with usage", () => {
	const raw = {
		jsonrpc: "2.0",
		id: 3,
		result: {
			stopReason: "end_turn",
			usage: {
				cachedReadTokens: 0,
				inputTokens: 26993,
				outputTokens: 689,
				thoughtTokens: 0,
				totalTokens: 27682,
			},
		},
	};
	const events = parseHermesLine(JSON.stringify(raw));
	expect(events.length).toBe(1);
	expect(events[0]?.kind).toBe("result");
	const ev = events[0] as { raw: Record<string, unknown>; usage?: unknown };
	// raw is the full original JSON
	expect(ev.raw).toEqual(raw);
	// usage is mapped from Hermes' payload; absent fields default to 0
	expect(ev.usage).toEqual({
		inputTokens: 26993,
		outputTokens: 689,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		costUSD: 0,
		durationMs: 0,
		numTurns: 0,
	});
});

test("session/prompt result without usage yields a result with undefined usage", () => {
	const raw = { jsonrpc: "2.0", id: 3, result: { stopReason: "max_tokens" } };
	const events = parseHermesLine(JSON.stringify(raw));
	expect(events.length).toBe(1);
	expect(events[0]?.kind).toBe("result");
	expect((events[0] as { usage?: unknown }).usage).toBeUndefined();
});

test("response with only an error field is ignored", () => {
	const line = JSON.stringify({
		jsonrpc: "2.0",
		id: 3,
		error: { code: -32602, message: "Invalid params" },
	});
	expect(parseHermesLine(line)).toEqual([]);
});

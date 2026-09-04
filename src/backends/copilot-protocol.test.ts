import { expect, test } from "vitest";

import { parseCopilotLine } from "./copilot-protocol.js";

/**
 * copilot-protocol.ts — pure parser for Copilot ACP (`copilot --acp`) stdout.
 * Shapes verified against a real `copilot --acp` capture (v1.0.82).
 */

// ── non-JSON / out-of-scope ──────────────────────────────────────────────

test("ignores blank and non-JSON lines", () => {
	expect(parseCopilotLine("")).toEqual([]);
	expect(parseCopilotLine("     ")).toEqual([]);
	expect(parseCopilotLine("not json")).toEqual([]);
	expect(parseCopilotLine("42")).toEqual([]); // valid JSON but not an object
	expect(parseCopilotLine("null")).toEqual([]); // JSON null → ignored
});

test("ignores out-of-scope session/update subtypes", () => {
	// usage_update
	expect(
		parseCopilotLine(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "session/update",
				params: {
					sessionId: "s",
					update: {
						sessionUpdate: "usage_update",
						size: 200000,
						used: 15193,
					},
				},
			}),
		),
	).toEqual([]);
	// available_commands_update
	expect(
		parseCopilotLine(
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
		parseCopilotLine(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "session/update",
				params: {
					sessionId: "s",
					update: { sessionUpdate: "session_info_update", title: "foo" },
				},
			}),
		),
	).toEqual([]);
	// config_option_update (Copilot-only, not in Hermes)
	expect(
		parseCopilotLine(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "session/update",
				params: {
					sessionId: "s",
					update: { sessionUpdate: "config_option_update" },
				},
			}),
		),
	).toEqual([]);
	// Unknown future subtype
	expect(
		parseCopilotLine(
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
	expect(
		parseCopilotLine(JSON.stringify({ method: "session/update" })),
	).toEqual([]);
	expect(
		parseCopilotLine(
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
	expect(parseCopilotLine(line)).toEqual([
		{ kind: "text", text: "hello world" },
	]);
});

test("agent_message_chunk with single char (token stream) is kept", () => {
	// Real Copilot capture shows single-char chunks.
	const line = JSON.stringify({
		jsonrpc: "2.0",
		method: "session/update",
		params: {
			sessionId: "s",
			update: {
				content: { text: "O", type: "text" },
				sessionUpdate: "agent_message_chunk",
			},
		},
	});
	expect(parseCopilotLine(line)).toEqual([{ kind: "text", text: "O" }]);
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
	expect(parseCopilotLine(line)).toEqual([]);
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
	expect(parseCopilotLine(line)).toEqual([]);
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
	expect(parseCopilotLine(line)).toEqual([]);
});

// ── session/update: agent_thought_chunk ───────────────────────────────────

test("agent_thought_chunk yields a thinking event", () => {
	const line = JSON.stringify({
		jsonrpc: "2.0",
		method: "session/update",
		params: {
			sessionId: "s",
			update: {
				content: { text: "analyzing the codebase", type: "text" },
				sessionUpdate: "agent_thought_chunk",
			},
		},
	});
	expect(parseCopilotLine(line)).toEqual([
		{ kind: "thinking", text: "analyzing the codebase" },
	]);
});

// ── session/update: tool_call ──────────────────────────────────────────────

test("tool_call yields a tool_use event (toolName from title, input from rawInput)", () => {
	const line = JSON.stringify({
		jsonrpc: "2.0",
		method: "session/update",
		params: {
			sessionId: "s",
			update: {
				toolCallId: "tc-001",
				title: "Bash node scripts/foo.js",
				kind: "execute",
				rawInput: { command: "node scripts/foo.js", timeout_ms: 5000 },
				status: "pending",
				sessionUpdate: "tool_call",
			},
		},
	});
	expect(parseCopilotLine(line)).toEqual([
		{
			kind: "tool_use",
			toolName: "Bash node scripts/foo.js",
			input: { command: "node scripts/foo.js", timeout_ms: 5000 },
		},
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
				rawInput: { command: "ls" },
				sessionUpdate: "tool_call",
			},
		},
	});
	expect(parseCopilotLine(line)).toEqual([
		{ kind: "tool_use", toolName: "tool", input: { command: "ls" } },
	]);
});

test("tool_call with no rawInput yields empty input", () => {
	const line = JSON.stringify({
		jsonrpc: "2.0",
		method: "session/update",
		params: {
			sessionId: "s",
			update: {
				toolCallId: "tc-2",
				title: "write something",
				kind: "write",
				sessionUpdate: "tool_call",
			},
		},
	});
	expect(parseCopilotLine(line)).toEqual([
		{ kind: "tool_use", toolName: "write something", input: {} },
	]);
});

test("tool_call_update also yields a tool_use event", () => {
	const line = JSON.stringify({
		jsonrpc: "2.0",
		method: "session/update",
		params: {
			sessionId: "s",
			update: {
				toolCallId: "tc-3",
				title: "Bash ls",
				kind: "execute",
				status: "completed",
				sessionUpdate: "tool_call_update",
			},
		},
	});
	expect(parseCopilotLine(line)).toEqual([
		{ kind: "tool_use", toolName: "Bash ls", input: {} },
	]);
});

// ── JSON-RPC responses ──────────────────────────────────────────────────

test("session/new response with sessionId yields a session event", () => {
	const line = JSON.stringify({
		jsonrpc: "2.0",
		id: 2,
		result: {
			sessionId: "7f870730-6014-46e4-bccb-5fed2e26754e",
			models: { availableModels: [{ modelId: "auto" }] },
			modes: { availableModes: ["default"], currentModeId: "default" },
		},
	});
	expect(parseCopilotLine(line)).toEqual([
		{ kind: "session", sessionId: "7f870730-6014-46e4-bccb-5fed2e26754e" },
	]);
});

test("session/new response without sessionId yields nothing", () => {
	const line = JSON.stringify({
		jsonrpc: "2.0",
		id: 2,
		result: { models: { availableModels: [] }, modes: {} },
	});
	expect(parseCopilotLine(line)).toEqual([]);
});

test("initialize response (agentCapabilities only, no sessionId) is ignored", () => {
	const line = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		result: {
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { image: true },
				sessionCapabilities: { close: {}, list: {} },
			},
			agentInfo: { name: "Copilot", version: "1.0.82" },
			protocolVersion: 1,
		},
	});
	expect(parseCopilotLine(line)).toEqual([]);
});

test("session/prompt result with stopReason yields a result event with usage", () => {
	const raw = {
		jsonrpc: "2.0",
		id: 3,
		result: {
			stopReason: "end_turn",
			usage: {
				cachedReadTokens: 0,
				cachedWriteTokens: 20107,
				inputTokens: 20109,
				outputTokens: 4,
				thoughtTokens: 0,
				totalTokens: 20113,
			},
		},
	};
	const events = parseCopilotLine(JSON.stringify(raw));
	expect(events.length).toBe(1);
	expect(events[0]?.kind).toBe("result");
	const ev = events[0] as { raw: Record<string, unknown>; usage?: unknown };
	// raw is the full original JSON
	expect(ev.raw).toEqual(raw);
	// usage is mapped from Copilot's payload
	//    cachedReadTokens → cacheReadTokens, cachedWriteTokens → cacheCreationTokens
	expect(ev.usage).toEqual({
		inputTokens: 20109,
		outputTokens: 4,
		cacheReadTokens: 0,
		cacheCreationTokens: 20107, // cachedWriteTokens
		// totalTokens / thoughtTokens → dropped (no UsageInfo slot in v1)
		// costUSD / durationMs / numTurns → 0
		costUSD: 0,
		durationMs: 0,
		numTurns: 0,
	});
});

test("session/prompt result without usage yields a result with undefined usage", () => {
	const raw = { jsonrpc: "2.0", id: 3, result: { stopReason: "max_tokens" } };
	const events = parseCopilotLine(JSON.stringify(raw));
	expect(events.length).toBe(1);
	expect(events[0]?.kind).toBe("result");
	expect((events[0] as { usage?: unknown }).usage).toBeUndefined();
});

test("response with only an error field is ignored", () => {
	const line = JSON.stringify({
		jsonrpc: "2.0",
		id: 3,
		error: { code: -32601, message: "Method not found" },
	});
	expect(parseCopilotLine(line)).toEqual([]);
});

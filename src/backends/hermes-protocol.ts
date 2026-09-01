/**
 * hermes-protocol.ts — pure parsing of Hermes ACP (`hermes acp`) stdout lines.
 *
 * Kept free of process/IO concerns so it can be unit-tested directly. Follows the
 * same design pattern as protocol.ts (Claude Code stream-json) and pi-protocol.ts
 * (Pi RPC). The JSON-RPC `id` correlation layer lives in hermes.ts (WBS-6); this
 * module only maps each line by its content shape to a ParsedEvent[].
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio. A line is one of:
 *   - a JSON-RPC *request* (agent → client): has `method` + `id`
 *     (e.g. `session/request_permission`).
 *   - a JSON-RPC *notification* (agent → client): has `method`, no `id`
 *     (e.g. `session/update`).
 *   - a JSON-RPC *response* (agent → client, answering one of our calls):
 *     has `result` and/or `error` and an `id`, no `method`
 *     (e.g. initialize / session/new / session/prompt results).
 *
 * Mapping (verified against a real `hermes acp` capture, v0.20.6):
 *   session/update · agent_message_chunk   → { kind: "text", text }
 *   session/update · agent_thought_chunk   → { kind: "thinking", text }
 *   session/update · tool_call             → { kind: "tool_use", toolName, input }
 *   session/new result · sessionId          → { kind: "session", sessionId }
 *   session/prompt result · stopReason      → { kind: "result", raw, usage }
 *
 * Out of scope (handled by the hermes.ts correlation/permission layer, like Pi's
 * "response"/"extension_ui_request"): every JSON-RPC *request*
 * (`session/request_permission`, ...), and session/update subtypes
 * `usage_update` / `available_commands_update` / `session_info_update` and the
 * `initialize` (agentCapabilities) response — all yield an empty array.
 *
 * Hermes' usage payload is `{ inputTokens, outputTokens, cachedReadTokens,
 * thoughtTokens, totalTokens }`. It differs from Iris's UsageInfo, so we map the
 * available fields and default the missing ones (cacheCreationTokens / costUSD /
 * durationMs / numTurns) to 0 / drop `thoughtTokens` (no UsageInfo slot).
 */

import type { ParsedEvent, UsageInfo } from "../protocol.js";

/**
 * Parse a single newline-delimited JSON-RPC line from Hermes' stdout into zero or
 * more ParsedEvents. Non-JSON noise and out-of-scope line shapes yield [].
 */
export function parseHermesLine(line: string): ParsedEvent[] {
	const trimmed = line.trim();
	if (!trimmed) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return []; // non-JSON noise
	}
	if (typeof parsed !== "object" || parsed === null) return [];
	const raw = parsed as Record<string, unknown>;

	// Agent → client JSON-RPC request / notification: has a `method`.
	if (typeof raw["method"] === "string") {
		return parseMethod(raw);
	}

	// Agent → client JSON-RPC response to one of our calls: has a `result`/`error`
	// and an `id`, no `method`.
	if ("result" in raw || "error" in raw) {
		return parseResponse(raw);
	}

	return [];
}

/** Dispatch a JSON-RPC request/notification by its `method`. */
function parseMethod(raw: Record<string, unknown>): ParsedEvent[] {
	const method = raw["method"] as string;
	if (method === "session/update") {
		const params = raw["params"] as Record<string, unknown> | undefined;
		const update = params?.["update"] as Record<string, unknown> | undefined;
		return update ? parseSessionUpdate(update) : [];
	}
	// `session/request_permission` and every other agent→client request are handled
	// by the hermes.ts correlation/permission bridge (WBS-6), not the pure parser.
	return [];
}

/** Dispatch a `session/update` notification by its `update.sessionUpdate` subtype. */
function parseSessionUpdate(update: Record<string, unknown>): ParsedEvent[] {
	const sub = update["sessionUpdate"];
	if (sub === "agent_message_chunk") {
		return parseTextChunk(update);
	}
	if (sub === "agent_thought_chunk") {
		return parseThinkingChunk(update);
	}
	if (sub === "tool_call") {
		return parseToolCall(update);
	}
	// usage_update / available_commands_update / session_info_update / anything else
	// are out of scope for the stream events — handled or dropped by hermes.ts.
	return [];
}

function chunkText(update: Record<string, unknown>): string | undefined {
	// agent_message_chunk / agent_thought_chunk carry content as a single text
	// block: { content: { text, type }, sessionUpdate: "..." }.
	const content = update["content"];
	if (typeof content !== "object" || content === null) return undefined;
	const text = (content as Record<string, unknown>)["text"];
	return typeof text === "string" ? text : undefined;
}

function parseTextChunk(update: Record<string, unknown>): ParsedEvent[] {
	const text = chunkText(update);
	return text && text.length > 0 ? [{ kind: "text", text }] : [];
}

function parseThinkingChunk(update: Record<string, unknown>): ParsedEvent[] {
	const text = chunkText(update);
	return text && text.length > 0 ? [{ kind: "thinking", text }] : [];
}

/**
 * Agent → client JSON-RPC response. Dispatch by result shape:
 *   result with `sessionId`   → session (e.g. session/new)
 *   result with `stopReason`  → result  (e.g. session/prompt)
 *   otherwise (initialize's agentCapabilities, empty result, error) → []
 */
function parseResponse(raw: Record<string, unknown>): ParsedEvent[] {
	const result = raw["result"];
	if (typeof result !== "object" || result === null) return [];
	const r = result as Record<string, unknown>;

	const sessionId = r["sessionId"];
	if (typeof sessionId === "string" && sessionId) {
		return [{ kind: "session", sessionId }];
	}

	// `stopReason` marks a session/prompt completion.
	if (typeof r["stopReason"] === "string") {
		return [{ kind: "result", raw, usage: extractUsage(r) }];
	}

	return [];
}

/**
 * Map a tool_call update to a tool_use event. Hermes' tool progress update carries
 * `{ toolCallId, title, kind, content[] }` (no raw input args in this shape), so
 * toolName is taken from `title` (default "tool") and input is the content blocks.
 */
function parseToolCall(update: Record<string, unknown>): ParsedEvent[] {
	const rawTitle = update["title"];
	const toolName = typeof rawTitle === "string" && rawTitle ? rawTitle : "tool";
	const input = update["content"] ?? {};
	return [{ kind: "tool_use", toolName, input }];
}

/**
 * Map Hermes' usage payload to Iris's UsageInfo. Hermes reports
 * `{ inputTokens, outputTokens, cachedReadTokens, thoughtTokens, totalTokens }`;
 * the absent fields default to 0 and `thoughtTokens` has no UsageInfo slot.
 */
function extractUsage(result: Record<string, unknown>): UsageInfo | undefined {
	const usage = result["usage"];
	if (typeof usage !== "object" || usage === null) return undefined;
	const u = usage as Record<string, unknown>;

	const num = (v: unknown): number =>
		typeof v === "number" && Number.isFinite(v) ? v : 0;

	return {
		inputTokens: num(u["inputTokens"]),
		outputTokens: num(u["outputTokens"]),
		// Hermes names its cache-read field `cachedReadTokens`.
		cacheReadTokens: num(u["cachedReadTokens"]),
		cacheCreationTokens: 0,
		costUSD: 0,
		durationMs: 0,
		numTurns: 0,
	};
}

/**
 * copilot-protocol.ts — pure parsing of Copilot ACP (`copilot --acp`) stdout
 * lines.
 *
 * Mirrors hermes-protocol.ts almost verbatim; Copilot's ACP shapes (verified
 * against a real copilot v1.0.82 capture) are nearly identical to Hermes v0.20.6,
 * with one difference: Copilot's usage payload also carries `cachedWriteTokens`
 * (maps to `cacheCreationTokens` in UsageInfo).
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio. A line is one of:
 *    - a JSON-RPC *response* (agent → client, answering one of our calls):
 *      has `result` and/or `error` and an `id`, no `method`.
 *      e.g. initialize / session/new / session/prompt results.
 *    - a JSON-RPC *notification* (agent → client): has `method`, no `id`.
 *      e.g. `session/update`.
 *
 * Copilot does NOT emit JSON-RPC *requests* (agent → client) in its ACP mode —
 * permission is launch-flag-driven, not per-call interactive.  So this parser
 * only handles notifications and responses.
 *
 * Mapping (verified against a real `copilot --acp` capture, v1.0.82):
 *   session/update · agent_message_chunk  → { kind: "text", text }
 *   session/update · agent_thought_chunk  → { kind: "thinking", text }
 *   session/update · tool_call            → { kind: "tool_use", toolName, input }
 *   session/new result · sessionId         → { kind: "session", sessionId }
 *   session/prompt result · stopReason     → { kind: "result", raw, usage }
 *
 * Out of scope (yield []):
 *   - usage_update / available_commands_update / session_info_update /
 *     config_option_update (status / control updates, no user-visible events)
 *   - initialize response (agentCapabilities only, no sessionId)
 *   - non-JSON / malformed / out-of-scope line types
 *
 * Usage mapping: Copilot's result.usage =
 *   { inputTokens, outputTokens, totalTokens, thoughtTokens,
 *     cachedReadTokens, cachedWriteTokens }
 * mapped to UsageInfo:
 *   inputTokens           → inputTokens
 *   outputTokens          → outputTokens
 *   cachedReadTokens      → cacheReadTokens
 *   cachedWriteTokens     → cacheCreationTokens
 *   costUSD / durationMs  → 0 (not reported by Copilot in v1.0.82)
 *   numTurns              → 0
 *   totalTokens / thoughtTokens → dropped (no UsageInfo slot in v1)
 */

import type { ParsedEvent, UsageInfo } from "../protocol.js";

/**
 * Parse a single newline-delimited JSON-RPC line from Copilot's stdout into
 * zero or more ParsedEvents. Non-JSON noise and out-of-scope line shapes yield
 * [].
 */
export function parseCopilotLine(line: string): ParsedEvent[] {
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

	// Notifications: has a `method`.
	if (typeof raw["method"] === "string") {
		return parseMethod(raw);
	}

	// Responses to our calls: has a `result`/`error` and an `id`, no `method`.
	if ("result" in raw || "error" in raw) {
		return parseResponse(raw);
	}

	return [];
}

/** Dispatch a JSON-RPC notification by its `method`. */
function parseMethod(raw: Record<string, unknown>): ParsedEvent[] {
	const method = raw["method"] as string;
	if (method === "session/update") {
		const params = raw["params"] as Record<string, unknown> | undefined;
		const update = params?.["update"] as Record<string, unknown> | undefined;
		return update ? parseSessionUpdate(update) : [];
	}
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
	if (sub === "tool_call" || sub === "tool_call_update") {
		return parseToolCall(update);
	}
	// usage_update / available_commands_update / session_info_update /
	// config_option_update / anything else — out of scope for stream events.
	return [];
}

function chunkText(update: Record<string, unknown>): string | undefined {
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
 *   result with `sessionId`    → session (e.g. session/new, session/list)
 *   result with `stopReason`   → result  (e.g. session/prompt)
 *   otherwise (initialize, empty, error) → []
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
 * Map a tool_call update to a tool_use event. Copilot's tool_call carries
 * `{ toolCallId, title, kind, rawInput?, status }`.
 * toolName is taken from `title` (default "tool").
 * input is the rawInput object or an empty object.
 */
function parseToolCall(update: Record<string, unknown>): ParsedEvent[] {
	const rawTitle = update["title"];
	const toolName = typeof rawTitle === "string" && rawTitle ? rawTitle : "tool";
	const input =
		typeof update["rawInput"] === "object"
			? (update["rawInput"] as Record<string, unknown>)
			: {};
	return [{ kind: "tool_use", toolName, input }];
}

/**
 * Map Copilot's usage payload to Iris's UsageInfo.
 * Copilot reports { inputTokens, outputTokens, totalTokens, thoughtTokens,
 * cachedReadTokens, cachedWriteTokens }.
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
		// Copilot uses cachedReadTokens; cachedWriteTokens → cacheCreationTokens.
		cacheReadTokens: num(u["cachedReadTokens"]),
		cacheCreationTokens: num(u["cachedWriteTokens"]),
		costUSD: 0,
		durationMs: 0,
		numTurns: 0,
	};
}

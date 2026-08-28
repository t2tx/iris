/**
 * pi-protocol.ts — pure parsing of Pi's stdout JSON event lines.
 *
 * Kept free of process/IO concerns so it can be unit-tested directly.
 * Follows the same design pattern as protocol.ts (Claude Code stream-json).
 *
 * Scope: stream events only (message_update / agent_settled).
 * Command responses ("response") and UI dialogs ("extension_ui_request")
 * are handled by the PiProcess layer, not here.
 *
 * UsageInfo is always undefined in this phase (WBS-3 will add support
 * after confirming Pi's usage payload shape).
 */

import type { ParsedEvent } from "../protocol.js";

/**
 * Parse a single newline-delimited JSON line from Pi's stdout into
 * zero or more ParsedEvents. Non-JSON noise and out-of-scope event
 * types yield an empty array.
 */
export function parsePiLine(line: string): ParsedEvent[] {
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

	switch (raw.type) {
		case "message_update":
			return parseMessageUpdate(raw);
		case "agent_settled":
			// Pass through the raw JSON for debuggability; usage is
			// undefined until WBS-3 confirms Pi's usage format.
			return [{ kind: "result", raw, usage: undefined }];
		default:
			// "response", "extension_ui_request", and any future
			// out-of-scope types are handled by PiProcess.
			return [];
	}
}

function parseMessageUpdate(raw: Record<string, unknown>): ParsedEvent[] {
	const evt = raw.assistantMessageEvent as Record<string, unknown> | undefined;
	if (!evt || typeof evt !== "object") return [];
	return parseAssistantMessageEvent(evt);
}

/**
 * Branch on the assistantMessageEvent subtype.
 *
 *   text_delta      → { kind: "text", text }
 *   thinking_delta → { kind: "thinking", text }
 *   toolcall_start → { kind: "tool_use", toolName, input }
 *   message_start   → { kind: "session", sessionId }    (if sessionId present)
 */
function parseAssistantMessageEvent(
	evt: Record<string, unknown>,
): ParsedEvent[] {
	switch (evt.type) {
		case "text_delta":
			return parseTextDelta(evt);
		case "thinking_delta":
			return parseThinkingDelta(evt);
		case "toolcall_start":
			return parseToolcallStart(evt);
		case "message_start":
			return parseMessageStart(evt);
		default:
			return [];
	}
}

function parseTextDelta(evt: Record<string, unknown>): ParsedEvent[] {
	const text = evt.delta ?? evt.text;
	if (typeof text === "string" && text) return [{ kind: "text", text }];
	return [];
}

function parseThinkingDelta(evt: Record<string, unknown>): ParsedEvent[] {
	const text = evt.delta ?? evt.text;
	if (typeof text === "string" && text) return [{ kind: "thinking", text }];
	return [];
}

function parseToolcallStart(evt: Record<string, unknown>): ParsedEvent[] {
	const toolName = typeof evt.toolName === "string" ? evt.toolName : "tool";
	const input = evt.input ?? evt.arguments ?? {};
	return [{ kind: "tool_use", toolName, input }];
}

function parseMessageStart(evt: Record<string, unknown>): ParsedEvent[] {
	const sessionId =
		typeof evt.sessionId === "string" ? evt.sessionId : undefined;
	if (sessionId) return [{ kind: "session", sessionId }];
	return [];
}

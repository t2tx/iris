/**
 * protocol.ts — pure parsing of Claude Code's stream-json output lines.
 *
 * Kept free of process/IO concerns so it can be unit-tested directly.
 * Shapes verified against cc-connect's agent/claudecode/session.go.
 */

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
  durationMs: number;
  numTurns: number;
}

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** A normalized event extracted from one stdout line. */
export type ParsedEvent =
  | {kind: 'session'; sessionId: string}
  | {kind: 'text'; text: string}
  | {kind: 'thinking'; text: string}
  | {kind: 'tool_use'; toolName: string; input: unknown}
  | {kind: 'permission'; request: PermissionRequest}
  | {kind: 'result'; raw: Record<string, unknown>; usage?: UsageInfo};

/**
 * Parse a single newline-delimited JSON line into zero or more events.
 * Non-JSON noise and unknown types yield an empty array.
 */
export function parseLine(line: string): ParsedEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return []; // non-JSON noise
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const raw = parsed as Record<string, unknown>;

  switch (raw['type']) {
    case 'system':
      return parseSystem(raw);
    case 'assistant':
      return parseAssistant(raw);
    case 'control_request':
      return parseControlRequest(raw);
    case 'result':
      return [{kind: 'result', raw, usage: extractUsage(raw)}];
    default:
      return []; // "user" (replayed) and anything else — ignored
  }
}

function parseSystem(raw: Record<string, unknown>): ParsedEvent[] {
  const sid = raw['session_id'];
  if (typeof sid === 'string' && sid)
    return [{kind: 'session', sessionId: sid}];
  return [];
}

function parseAssistant(raw: Record<string, unknown>): ParsedEvent[] {
  const msg = raw['message'] as Record<string, unknown> | undefined;
  const content = msg?.['content'];
  if (!Array.isArray(content)) return [];

  const events: ParsedEvent[] = [];
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue;
    const ev = parseContentPart(item as Record<string, unknown>);
    if (ev) events.push(ev);
  }
  return events;
}

/** Parse one assistant content block into an event (or null to skip). */
function parseContentPart(part: Record<string, unknown>): ParsedEvent | null {
  switch (part['type']) {
    case 'text': {
      const text = part['text'];
      return typeof text === 'string' && text ? {kind: 'text', text} : null;
    }
    case 'thinking': {
      const text = part['thinking'];
      return typeof text === 'string' && text ? {kind: 'thinking', text} : null;
    }
    case 'tool_use': {
      const toolName = typeof part['name'] === 'string' ? part['name'] : 'tool';
      if (toolName === 'AskUserQuestion') return null;
      return {kind: 'tool_use', toolName, input: part['input']};
    }
    default:
      return null;
  }
}

function parseControlRequest(raw: Record<string, unknown>): ParsedEvent[] {
  const requestId =
    typeof raw['request_id'] === 'string' ? raw['request_id'] : '';
  const request = raw['request'] as Record<string, unknown> | undefined;
  if (!request || request['subtype'] !== 'can_use_tool' || !requestId)
    return [];

  const toolName =
    typeof request['tool_name'] === 'string' ? request['tool_name'] : '';
  const input = (request['input'] as Record<string, unknown>) ?? {};

  return [{kind: 'permission', request: {requestId, toolName, input}}];
}

function extractUsage(raw: Record<string, unknown>): UsageInfo | undefined {
  const usage = raw['usage'] as Record<string, unknown> | undefined;
  if (!usage) return undefined;

  const costUSD =
    typeof raw['total_cost_usd'] === 'number' ? raw['total_cost_usd'] : 0;
  const durationMs =
    typeof raw['duration_ms'] === 'number' ? raw['duration_ms'] : 0;
  const numTurns = typeof raw['num_turns'] === 'number' ? raw['num_turns'] : 0;

  return {
    inputTokens: num(usage['input_tokens']),
    outputTokens: num(usage['output_tokens']),
    cacheReadTokens: num(usage['cache_read_input_tokens']),
    cacheCreationTokens: num(usage['cache_creation_input_tokens']),
    costUSD,
    durationMs,
    numTurns,
  };
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

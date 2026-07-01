/**
 * format.ts — Claude output → Slack mrkdwn, plus the NO_REPLY silence marker.
 */

/**
 * Strips a trailing `NO_REPLY` marker (case-insensitive, own line).
 * Returns the text to deliver, or null if nothing should be sent.
 * Mirrors cc-connect's NO_REPLY behavior: if the whole reply is just the
 * marker (or becomes empty after stripping), deliver nothing.
 */
export function applyNoReply(text: string): string | null {
  const stripped = text.replace(/\n?\s*NO_REPLY\s*$/i, '').trim();
  if (stripped === '') return null;
  return stripped;
}

/**
 * Convert Claude's GitHub-flavored markdown to Slack mrkdwn.
 * Minimal pass: Slack uses *bold* (single asterisk) and _italic_, and renders
 * fenced code blocks natively. We mainly fix bold and headings.
 */
export function toSlackMrkdwn(md: string): string {
  let out = md;
  // **bold** → *bold*  (do before single-asterisk handling)
  out = out.replace(/\*\*(.+?)\*\*/g, '*$1*');
  // markdown headings (#, ##, ...) → bold line
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  return out;
}

/** Default max chars of a Bash command in the progress line (overridable). */
export const DEFAULT_BASH_MAX = 800;

/**
 * Short, human label for a tool-use progress line. `bashMax` caps the Bash
 * command detail (Bash commands are the main thing worth reading in the feed;
 * they may be multi-line `a && b` chains). Other details are short by nature.
 */
export function toolProgressLine(
  toolName: string,
  input: unknown,
  bashMax: number = DEFAULT_BASH_MAX,
): string {
  const detail = summarizeInput(toolName, input, bashMax);
  return detail ? `🛠️ ${toolName} — ${detail}` : `🛠️ ${toolName}`;
}

// Per-tool extractors for the most useful field(s) of a tool's input.
const EXTRACTORS: Record<string, (o: Record<string, unknown>) => string> = {
  Read: (o) => str(o['file_path']),
  Edit: (o) => str(o['file_path']),
  Write: (o) => str(o['file_path']),
  MultiEdit: (o) => str(o['file_path']),
  NotebookEdit: (o) => str(o['notebook_path']),
  Grep: (o) => joinParts(str(o['pattern']), str(o['path'])),
  Glob: (o) => joinParts(str(o['pattern']), str(o['path'])),
  Task: (o) => joinParts(str(o['subagent_type']), str(o['description'])),
  WebFetch: (o) => str(o['url']),
  WebSearch: (o) => str(o['query']),
  TodoWrite: (o) =>
    Array.isArray(o['todos']) ? `${o['todos'].length} item(s)` : '',
};

function summarizeInput(
  toolName: string,
  input: unknown,
  bashMax: number,
): string {
  if (typeof input !== 'object' || input === null) return '';
  const obj = input as Record<string, unknown>;
  // Bash gets its own (larger) limit; everything else uses the default clip.
  if (toolName === 'Bash') return clip(str(obj['command']), bashMax);
  const extract = EXTRACTORS[toolName];
  // Unknown tools (incl. MCP): surface the most useful field we can find so the
  // line isn't just a bare tool name.
  return clip(extract ? extract(obj) : genericDetail(obj));
}

/** Pull a representative field out of an unknown tool's input. */
function genericDetail(obj: Record<string, unknown>): string {
  const keys = [
    'command',
    'file_path',
    'path',
    'query',
    'pattern',
    'url',
    'prompt',
    'description',
    'name',
  ];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  // No unrestricted fallback: an unknown tool's non-allowlisted fields may hold
  // tokens or file contents (esp. MCP, whose schemas are arbitrary). Surfacing
  // them verbatim in the Slack progress line would leak secrets — show only the
  // bare tool name instead. (See .coderabbit.yaml: never log tokens/contents.)
  return '';
}

/** Join non-empty parts with a separator, dropping blanks. */
function joinParts(...parts: string[]): string {
  return parts.filter(Boolean).join(' — ');
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Format a usage footer line for Slack. */
export function usageFooter(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUSD: number;
  durationMs: number;
}): string {
  // Nothing meaningful happened (e.g. an empty/no-op turn) — emit no footer.
  if (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cacheReadTokens === 0
  ) {
    return '';
  }
  const tokens = `in:${fmtNum(usage.inputTokens)} out:${fmtNum(usage.outputTokens)}`;
  const cache =
    usage.cacheReadTokens > 0 ? ` cache:${fmtNum(usage.cacheReadTokens)}` : '';
  const cost = usage.costUSD > 0 ? ` $${usage.costUSD.toFixed(4)}` : '';
  const dur =
    usage.durationMs > 0 ? ` ${(usage.durationMs / 1000).toFixed(1)}s` : '';
  return `_${tokens}${cache}${cost}${dur}_`;
}

function fmtNum(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function clip(s: string, max = 120): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

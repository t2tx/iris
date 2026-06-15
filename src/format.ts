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

/** Short, human label for a tool-use progress line. */
export function toolProgressLine(toolName: string, input: unknown): string {
  const detail = summarizeInput(toolName, input);
  return detail
    ? `:hammer_and_wrench: ${toolName} — ${detail}`
    : `:hammer_and_wrench: ${toolName}`;
}

function summarizeInput(toolName: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const obj = input as Record<string, unknown>;
  switch (toolName) {
    case 'Bash':
      return clip(str(obj['command']));
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return clip(str(obj['file_path']));
    case 'Grep':
      return clip(str(obj['pattern']));
    case 'Glob':
      return clip(str(obj['pattern']));
    default:
      return '';
  }
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

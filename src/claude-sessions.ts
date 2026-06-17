/**
 * claude-sessions.ts — read Claude Code's persisted sessions for a work dir.
 *
 * Claude Code stores each session as a JSONL file under
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, where the cwd is
 * encoded by replacing every `/` with `-`. These files survive Iris
 * restarts, so /resume can list them and reconnect a thread to one.
 */

import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';

/** How many of the most-recent human prompts to keep for display. */
const RECENT_PROMPTS = 3;

export interface ClaudeSession {
  id: string; // session id (jsonl basename)
  mtimeMs: number; // last-modified, for sorting
  firstPrompt: string; // first human message, for display
  recentPrompts: string[]; // last up-to-3 human messages, oldest→newest
  turns: number; // number of human turns (a rough size signal)
}

/** Map a working directory to its Claude projects dir (… / → -). */
export function projectDir(workDir: string): string {
  const encoded = workDir.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', encoded);
}

/**
 * Replayed/system "user" entries whose text starts with one of these tags is
 * not a real prompt. We match known tags only — a bare `<` would also drop
 * legitimate prompts like Slack mentions (`<@U…>`) or `<div> について教えて`.
 */
const REPLAY_TAG =
  /^<(tool_result|task-notification|local-command-caveat|system-reminder|command-name|command-message|command-args)\b/;

/** Extract the text of a user message, or '' if it isn't a plain prompt. */
function userText(obj: Record<string, unknown>): string {
  if (obj['type'] !== 'user') return '';
  const msg = obj['message'] as {content?: unknown} | undefined;
  const c = msg?.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c))
    text = c
      .filter(
        (p): p is {type: string; text: string} =>
          typeof p === 'object' &&
          p !== null &&
          (p as {type?: string}).type === 'text',
      )
      .map((p) => p.text)
      .join(' ');
  text = text.trim();
  // Skip known replay/system tags only (not every `<`-prefixed prompt).
  return REPLAY_TAG.test(text) ? '' : text;
}

interface SessionSummary {
  first: string;
  recent: string[]; // last up-to-RECENT_PROMPTS prompts, oldest→newest
  turns: number;
}

/**
 * Single pass over a session JSONL: first human prompt, the last few human
 * prompts, and a count of human turns. Cheap (no LLM) — just enough to tell
 * sessions apart in a list.
 */
function summarizeSession(filePath: string): SessionSummary {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return {first: '', recent: [], turns: 0};
  }
  let first = '';
  const recent: string[] = []; // ring buffer of the last RECENT_PROMPTS
  let turns = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const text = userText(obj);
    if (!text) continue;
    if (!first) first = text;
    recent.push(text);
    if (recent.length > RECENT_PROMPTS) recent.shift();
    turns++;
  }
  return {first, recent, turns};
}

/**
 * List Claude sessions for a work dir, most-recently-modified first.
 * Returns up to `limit` entries.
 */
export function listClaudeSessions(
  workDir: string,
  limit = 10,
): ClaudeSession[] {
  const dir = projectDir(workDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  // Collect (id, mtime) first; only read the JSONL of the top `limit` newest.
  const metas: {id: string; full: string; mtimeMs: number}[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const full = join(dir, name);
    try {
      metas.push({
        id: name.slice(0, -'.jsonl'.length),
        full,
        mtimeMs: statSync(full).mtimeMs,
      });
    } catch {
      continue;
    }
  }
  metas.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return metas.slice(0, limit).map((m) => {
    const {first, recent, turns} = summarizeSession(m.full);
    return {
      id: m.id,
      mtimeMs: m.mtimeMs,
      firstPrompt: first,
      recentPrompts: recent,
      turns,
    };
  });
}

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

export interface ClaudeSession {
  id: string; // session id (jsonl basename)
  mtimeMs: number; // last-modified, for sorting
  firstPrompt: string; // first human message, for display
}

/** Map a working directory to its Claude projects dir (… / → -). */
export function projectDir(workDir: string): string {
  const encoded = workDir.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', encoded);
}

/** Extract the first human-readable user message from a session JSONL. */
function firstUserPrompt(filePath: string): string {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj['type'] !== 'user') continue;
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
    // Skip tool-result / system-ish replays that start with a tag.
    if (text && !text.startsWith('<')) return text;
  }
  return '';
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
  const sessions: ClaudeSession[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const full = join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    sessions.push({
      id: name.slice(0, -'.jsonl'.length),
      mtimeMs,
      firstPrompt: firstUserPrompt(full),
    });
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions.slice(0, limit);
}

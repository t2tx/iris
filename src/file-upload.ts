/**
 * file-upload.ts — detects local file paths in Claude's text output and
 * uploads them to Slack via files.uploadV2.
 *
 * Heuristic: look for absolute paths (starting with / or ~/) that point to an
 * existing regular file. Any file type is uploaded — source files (.ts, .py, …)
 * as well as documents/images — so "send me the file" just works. (Earlier this
 * had an extension allow-list that excluded source code, so Claude would write
 * a path expecting it to be uploaded, but nothing was attached.)
 */

import {existsSync, readFileSync, statSync} from 'node:fs';
import {basename, join} from 'node:path';
import {homedir} from 'node:os';

/**
 * Match local file paths in text: absolute (`/...`) or home-relative (`~/...`),
 * with or without an extension. Claude often writes the latter, so we accept
 * both and expand `~/` below.
 */
const PATH_PATTERN = /(?:^|\s|`)((?:~\/|\/)[\w./-]+)/gm;

/** Expand a leading `~/` to the user's home directory. */
function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

export interface DetectedFile {
  path: string;
  name: string;
}

/**
 * Scan text for local paths that point to an existing regular file. Any file
 * type is accepted. Returns a deduplicated list. Directories are skipped.
 */
export function detectFiles(text: string): DetectedFile[] {
  const seen = new Set<string>();
  const results: DetectedFile[] = [];

  for (const match of text.matchAll(PATH_PATTERN)) {
    // Trim a trailing backtick/punctuation the greedy class may have caught.
    const raw = match[1]!.replace(/[`.,)]+$/, '');
    const filePath = expandHome(raw);
    if (seen.has(filePath)) continue;
    seen.add(filePath);

    if (!existsSync(filePath)) continue;
    if (!statSync(filePath).isFile()) continue; // skip directories

    results.push({path: filePath, name: basename(filePath)});
  }

  return results;
}

/**
 * Upload a local file to a Slack channel/thread.
 */
export async function uploadFile(
  client: {
    filesUploadV2: (args: Record<string, unknown>) => Promise<unknown>;
  },
  file: DetectedFile,
  channel: string,
  threadTs?: string,
): Promise<void> {
  const content = readFileSync(file.path);
  const args: Record<string, unknown> = {
    channel_id: channel,
    file: content,
    filename: file.name,
    title: file.name,
  };
  if (threadTs) args['thread_ts'] = threadTs;
  await client.filesUploadV2(args);
}

/**
 * Build a timestamped filename for a long reply, e.g. `iris-reply-20260630-2015.md`.
 * Uses local time so the name matches when the user saw the message. `now` is
 * injected for testability.
 */
export function replyFilename(now: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `iris-reply-${stamp}.md`;
}

/**
 * Upload an in-memory string as a file to a Slack channel/thread. Used for long
 * replies that would be truncated (or fail with msg_too_long) if posted as a
 * normal message — sending the full text as a snippet keeps nothing hidden.
 */
export async function uploadText(
  client: {
    filesUploadV2: (args: Record<string, unknown>) => Promise<unknown>;
  },
  text: string,
  filename: string,
  channel: string,
  threadTs?: string,
): Promise<void> {
  const args: Record<string, unknown> = {
    channel_id: channel,
    // Pass an explicit UTF-8 buffer, not the `content` string: with `content`,
    // Slack mis-decodes multibyte text (Japanese came back mojibake). A Buffer
    // is uploaded verbatim and rendered as UTF-8.
    file: Buffer.from(text, 'utf-8'),
    filename,
    title: filename,
  };
  if (threadTs) args['thread_ts'] = threadTs;
  await client.filesUploadV2(args);
}

/**
 * file-upload.ts — detects local file paths in Claude's text output and
 * uploads them to Slack via files.uploadV2.
 *
 * Heuristic: look for absolute paths (starting with / or ~/) that point to
 * existing files with known extensions (images, PDFs, etc.).
 */

import {existsSync, readFileSync} from 'node:fs';
import {basename, extname, join} from 'node:path';
import {homedir} from 'node:os';

/** File extensions we'll auto-upload to Slack. */
const UPLOADABLE_EXTS = new Set([
  // images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  // documents
  '.pdf',
  '.csv',
  '.json',
  '.txt',
  '.md',
  '.html',
  // archives
  '.zip',
  '.tar',
  '.gz',
]);

/**
 * Match local file paths in text: absolute (`/...`) or home-relative (`~/...`).
 * Claude often writes the latter, so we accept both and expand `~/` below.
 */
const PATH_PATTERN = /(?:^|\s|`)((?:~\/|\/)[\w./-]+\.[\w]+)/gm;

/** Expand a leading `~/` to the user's home directory. */
function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

export interface DetectedFile {
  path: string;
  name: string;
}

/**
 * Scan text for local file paths that exist and have uploadable extensions.
 * Returns deduplicated list.
 */
export function detectFiles(text: string): DetectedFile[] {
  const seen = new Set<string>();
  const results: DetectedFile[] = [];

  for (const match of text.matchAll(PATH_PATTERN)) {
    const raw = match[1]!;
    const filePath = expandHome(raw);
    if (seen.has(filePath)) continue;
    seen.add(filePath);

    const ext = extname(filePath).toLowerCase();
    if (!UPLOADABLE_EXTS.has(ext)) continue;
    if (!existsSync(filePath)) continue;

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

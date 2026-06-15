/**
 * file-upload.ts — detects local file paths in Claude's text output and
 * uploads them to Slack via files.uploadV2.
 *
 * Heuristic: look for absolute paths (starting with /) that point to
 * existing files with known extensions (images, PDFs, etc.).
 */

import {existsSync, readFileSync} from 'node:fs';
import {basename, extname} from 'node:path';

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

/** Match absolute file paths in text (common Claude output patterns). */
const PATH_PATTERN = /(?:^|\s|`)(\/[\w./-]+\.[\w]+)/gm;

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
    const filePath = match[1]!;
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

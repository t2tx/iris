/**
 * file-upload.ts — uploads the files an agent placed in its outbox to Slack via
 * files.uploadV2.
 *
 * Outbound file delivery is an EXPLICIT contract, not a heuristic: to send a file
 * to the user, an agent writes it under <workDir>/.iris/outbox/ (see
 * attachments.outboxDir / APPEND_SYSTEM_PROMPT). Iris uploads every existing file
 * found there and then deletes it (a one-shot queue). This is the only transfer
 * path — there is no longer any scanning of the reply text for paths.
 *
 * Scanning reply text (the old detectFiles) misbehaved on every backend: a coding
 * agent that dumps a file's CONTENT into its reply would (a) miss the requested
 * file when its own path never appears in prose, and (b) auto-attach every
 * unrelated absolute path that happened to appear inside the dumped content. Both
 * are gone now: only the outbox is transferred.
 */

import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";

export interface DetectedFile {
	path: string;
	name: string;
}

/**
 * Enumerate the outbox for a working directory: <workDir>/.iris/outbox.
 * The inbound inbox (<workDir>/.iris/attachments, see #77) is a different
 * directory, so the two never collide. Returns [] when the outbox is absent.
 */
export function listOutbox(workDir: string): DetectedFile[] {
	const outboxDir = join(workDir, ".iris", "outbox");
	if (!existsSync(outboxDir)) return [];
	const out: DetectedFile[] = [];
	for (const entry of readdirSync(outboxDir, { withFileTypes: true })) {
		if (!entry.isFile()) continue; // skip subdirectories
		const path = join(outboxDir, entry.name);
		// Guard against a race between readdir and stat.
		if (existsSync(path) && statSync(path).isFile()) {
			out.push({ path, name: entry.name });
		}
	}
	return out;
}

/** Remove a freshly-uploaded outbox file (the outbox is a one-shot queue). */
export function deleteOutboxFile(path: string): void {
	try {
		rmSync(path);
	} catch {
		// A vanished file (already removed) or a transient error must not abort
		// the rest of the queue's uploads.
	}
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
	if (threadTs) args["thread_ts"] = threadTs;
	await client.filesUploadV2(args);
}

/**
 * Build a timestamped filename for a long reply, e.g. `iris-reply-20260630-2015.md`.
 * Uses local time so the name matches when the user saw the message. `now` is
 * injected for testability.
 */
export function replyFilename(now: Date): string {
	const p = (n: number, w = 2): string => String(n).padStart(w, "0");
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
		file: Buffer.from(text, "utf-8"),
		filename,
		title: filename,
	};
	if (threadTs) args["thread_ts"] = threadTs;
	await client.filesUploadV2(args);
}

/**
 * file-upload.ts — uploads the files an agent placed in its outbox to Slack via
 * files.uploadV2.
 *
 * Outbound file delivery is an EXPLICIT contract, not a heuristic: to send a file
 * to the user, an agent writes it under its session's outbox (
 * <workDir>/.iris/outbox/<session>, see attachments.outboxDir / the prompt
 * builder in index.ts). Iris uploads every existing file found there and then
 * deletes it (a one-shot queue). This is the only transfer path — there is no
 * longer any scanning of the reply text for paths.
 *
 * The outbox is scoped per Slack session so two sessions on the same work_dir
 * cannot drain each other's files, and the old reply-text scan (detectFiles)
 * had two failure modes that the outbox removes: (a) missing a requested file
 * when its path never appears in prose, and (b) auto-attaching unrelated absolute
 * paths that happened to appear inside dumped file content.
 */

import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { safeSessionKey } from "./attachments.js";

export interface DetectedFile {
	path: string;
	name: string;
}

/**
 * Outcome of removing a drained outbox file. `ok: true` covers both a successful
 * deletion and an already-gone file (ENOENT — a TOCTOU race or a second drain),
 * which are both benign. `ok: false` is a real deletion failure, left for the
 * caller to log because it means the file may be delivered again on a later turn.
 */
export type DeleteResult = { ok: true } | { ok: false; error: Error };

/**
 * Enumerate a session's outbox: <workDir>/.iris/outbox/<session>. Files belong to
 * the completing session only, so two sessions on the same work_dir cannot drain
 * each other. The inbound inbox (<workDir>/.iris/attachments, see #77) is a
 * different directory, so the three never collide. Returns [] when the session
 * outbox is absent.
 */
export function listOutbox(
	workDir: string,
	sessionKey: string,
): DetectedFile[] {
	const outboxBase = join(
		workDir,
		".iris",
		"outbox",
		safeSessionKey(sessionKey),
	);
	if (!existsSync(outboxBase)) return [];
	const out: DetectedFile[] = [];
	for (const entry of readdirSync(outboxBase, { withFileTypes: true })) {
		if (!entry.isFile()) continue; // skip subdirectories
		const path = join(outboxBase, entry.name);
		// Guard against a race between readdir and stat.
		if (existsSync(path) && statSync(path).isFile()) {
			out.push({ path, name: entry.name });
		}
	}
	return out;
}

/**
 * Remove a freshly-uploaded outbox file. The outbox is a one-shot queue, so a
 * successful upload is followed by a deletion. An ENOENT is the already-removed
 * case and is reported as `ok` (a second drain, or a race, must not look like a
 * failure); any *other* error is returned so the caller can log it — a stranded
 * file would otherwise be re-delivered on the next turn.
 */
export function deleteOutboxFile(path: string): DeleteResult {
	try {
		rmSync(path);
		return { ok: true };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true };
		return {
			ok: false,
			error: err instanceof Error ? err : new Error(String(err)),
		};
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

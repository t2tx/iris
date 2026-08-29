import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * attachments.ts — inbound file/image handling (user → Claude).
 *
 * Slack messages may carry files. Images are sent to Claude as base64 in the
 * multimodal content array (Claude "sees" them); other files are saved to disk
 * and referenced by path so Claude can Read them. Mirrors cc-connect's
 * agent/claudecode/session.go Send().
 */

export interface Attachment {
	name: string;
	mimeType: string;
	data: Buffer;
}

/** A stream-json user-message content part. */
export type ContentPart =
	| { type: "text"; text: string }
	| {
			type: "image";
			source: { type: "base64"; media_type: string; data: string };
	  };

function isImage(mimeType: string): boolean {
	return mimeType.startsWith("image/");
}

function extFromMime(mime: string): string {
	switch (mime) {
		case "image/jpeg":
			return ".jpg";
		case "image/gif":
			return ".gif";
		case "image/webp":
			return ".webp";
		case "image/png":
			return ".png";
		default:
			return "";
	}
}

/**
 * Build the stream-json `content` array for a user message with attachments.
 * Images become base64 image parts; non-image files are written under
 * <workDir>/.iris/attachments and referenced by path in the trailing text part.
 *
 * `now` and a per-message index keep filenames unique without Math.random/Date
 * (which are unavailable in some sandboxes); callers pass a timestamp.
 */
export function buildContent(
	prompt: string,
	attachments: Attachment[],
	workDir: string,
	now: number,
): ContentPart[] {
	const parts: ContentPart[] = [];
	const savedFilePaths: string[] = [];

	let attachDir = "";
	const ensureDir = (): string => {
		if (!attachDir) {
			attachDir = join(workDir, ".iris", "attachments");
			mkdirSync(attachDir, { recursive: true });
		}
		return attachDir;
	};

	attachments.forEach((att, i) => {
		if (isImage(att.mimeType)) {
			parts.push({
				type: "image",
				source: {
					type: "base64",
					media_type: att.mimeType,
					data: att.data.toString("base64"),
				},
			});
			return;
		}
		// Non-image: persist to disk and reference by path.
		const safe = att.name.replace(/[^\w.-]/g, "_") || `file_${now}_${i}`;
		const fpath = join(ensureDir(), `${now}_${i}_${safe}${suffix(att, safe)}`);
		writeFileSync(fpath, att.data);
		savedFilePaths.push(fpath);
	});

	let text = prompt;
	if (!text && parts.length > 0) text = "Please analyze the attached image(s).";
	else if (!text && savedFilePaths.length > 0)
		text = "Please analyze the attached file(s).";
	if (savedFilePaths.length > 0) {
		text += `\n\n(Files saved locally, please read them: ${savedFilePaths.join(", ")})`;
	}
	parts.push({ type: "text", text });
	return parts;
}

/**
 * A Pi `prompt` command image part. Pi keeps images in a separate `images`
 * field (never inside the `message` string) and uses its own shape — base64
 * `data` plus `mimeType` — unlike Claude's `content` array.
 */
export interface PiImage {
	type: "image";
	data: string;
	mimeType: string;
}

/**
 * The prompt payload Pi's RPC `prompt` command expects.
 * `message` is a plain string (Pi's `session.prompt()` runs `text.startsWith("/")`
 * on it, so a content array breaks it); images travel in a separate `images`
 * field. Non-image files are saved to disk and referenced by path in `message`.
 */
export interface PiPrompt {
	message: string;
	images: PiImage[];
}

/**
 * Build the Pi RPC `prompt` payload for a user message with attachments.
 *
 * Pi's `prompt` takes a string `message` plus a separate `images` field of
 * `PiImage` (image) parts, which differs in both shape and location from Claude's
 * `buildContent` content array. Images become `PiImage` entries; non-image files
 * are written under <workDir>/.iris/attachments and referenced by path in the
 * trailing `message` text. Sharing the disk-save logic keeps both backends in
 * sync without changing `buildContent` (used by the Claude path).
 */
export function buildPiPrompt(
	prompt: string,
	attachments: Attachment[],
	workDir: string,
	now: number,
): PiPrompt {
	const images: PiImage[] = [];
	const savedFilePaths: string[] = [];

	let attachDir = "";
	const ensureDir = (): string => {
		if (!attachDir) {
			attachDir = join(workDir, ".iris", "attachments");
			mkdirSync(attachDir, { recursive: true });
		}
		return attachDir;
	};

	attachments.forEach((att, i) => {
		if (isImage(att.mimeType)) {
			images.push({
				type: "image",
				data: att.data.toString("base64"),
				mimeType: att.mimeType,
			});
			return;
		}
		// Non-image: persist to disk and reference by path.
		const safe = att.name.replace(/[^\w.-]/g, "_") || `file_${now}_${i}`;
		const fpath = join(ensureDir(), `${now}_${i}_${safe}${suffix(att, safe)}`);
		writeFileSync(fpath, att.data);
		savedFilePaths.push(fpath);
	});

	let message = prompt;
	if (!message && images.length > 0)
		message = "Please analyze the attached image(s).";
	else if (!message && savedFilePaths.length > 0)
		message = "Please analyze the attached file(s).";
	if (savedFilePaths.length > 0) {
		message += `\n\n(Files saved locally, please read them: ${savedFilePaths.join(", ")})`;
	}
	return { message, images };
}

/** Append a mime-derived extension only when the name lacks one. */
function suffix(att: Attachment, safeName: string): string {
	if (safeName.includes(".")) return "";
	return extFromMime(att.mimeType);
}

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type DetectedFile,
	deleteOutboxFile,
	listOutbox,
	replyFilename,
	uploadFile,
} from "./file-upload.js";

/** A fake Slack client that records the files it was asked to upload. */
function mockClient(): {
	uploads: Array<{ filename: string; channel_id: string; thread_ts?: string }>;
	client: {
		filesUploadV2: (args: Record<string, unknown>) => Promise<unknown>;
	};
} {
	const uploads: Array<{
		filename: string;
		channel_id: string;
		thread_ts?: string;
	}> = [];
	const client = {
		filesUploadV2: async (args: Record<string, unknown>) => {
			uploads.push({
				filename: String(args["filename"]),
				channel_id: String(args["channel_id"]),
				thread_ts: args["thread_ts"] as string | undefined,
			});
		},
	};
	return { uploads, client };
}

/** Drop a file into a temp dir's outbox and return its full path. */
function toOutbox(workDir: string, name: string, content: string): string {
	const dir = join(workDir, ".iris", "outbox");
	mkdirSync(dir, { recursive: true });
	const p = join(dir, name);
	writeFileSync(p, content);
	return p;
}

describe("listOutbox", () => {
	it("returns [] when the outbox does not exist", () => {
		const dir = mkdtempSync(join(tmpdir(), "iris-outbox-"));
		try {
			expect(listOutbox(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("lists only regular files, skipping subdirectories", () => {
		const dir = mkdtempSync(join(tmpdir(), "iris-outbox-"));
		try {
			toOutbox(dir, "a.md", "hello");
			toOutbox(dir, "b.txt", "world");
			// A subdirectory must not be listed.
			mkdirSync(join(dir, ".iris", "outbox", "nested"));
			writeFileSync(join(dir, ".iris", "outbox", "nested", "c.md"), "x");
			const files = listOutbox(dir);
			const names = files.map((f) => f.name).sort();
			expect(names).toEqual(["a.md", "b.txt"]);
			// name is the basename; path is absolute and points inside the outbox.
			const a = files.find((f) => f.name === "a.md");
			expect(a!.path.startsWith(dir)).toBeTruthy();
			expect(a!.path.endsWith("a.md")).toBeTruthy();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("deleteOutboxFile", () => {
	it("removes an outbox file", () => {
		const dir = mkdtempSync(join(tmpdir(), "iris-outbox-"));
		try {
			const p = toOutbox(dir, "gone.txt", "x");
			deleteOutboxFile(p);
			expect(listOutbox(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not throw when the file is already gone", () => {
		expect(() =>
			deleteOutboxFile("/nonexistent/path/does/not/exist"),
		).not.toThrow();
	});
});

describe("uploadFile", () => {
	it("uploads the file with its name, channel, and thread", async () => {
		const dir = mkdtempSync(join(tmpdir(), "iris-outbox-"));
		try {
			const p = toOutbox(dir, "report.pdf", "pdf-bytes");
			const { uploads, client } = mockClient();
			const file: DetectedFile = { path: p, name: "report.pdf" };
			await uploadFile(client, file, "C123", "1700.0001");
			expect(uploads).toHaveLength(1);
			expect(uploads[0]!.filename).toBe("report.pdf");
			expect(uploads[0]!.channel_id).toBe("C123");
			expect(uploads[0]!.thread_ts).toBe("1700.0001");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("outbox → upload → delete (the outbound transfer contract)", () => {
	it("uploads every existing outbox file and removes each after upload", async () => {
		const dir = mkdtempSync(join(tmpdir(), "iris-outbox-"));
		try {
			toOutbox(dir, "a.md", "alpha");
			toOutbox(dir, "b.txt", "beta");
			const { uploads, client } = mockClient();

			for (const file of listOutbox(dir)) {
				await uploadFile(client, file, "C999", "1700.0002");
				deleteOutboxFile(file.path);
			}

			const names = uploads.map((u) => u.filename).sort();
			expect(names).toEqual(["a.md", "b.txt"]);
			// After a full drain the outbox is empty.
			expect(listOutbox(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// The old `detectFiles(text)` text-scan is gone: a reply that *quotes* other
// files' absolute paths must NOT cause them to be uploaded. The only transfer
// path is the outbox, so an outbox-free turn uploads nothing.
describe("no text scanning (the auto-attach bug is gone)", () => {
	it("an outbox with the requested file uploaded but other paths never scanned", async () => {
		const dir = mkdtempSync(join(tmpdir(), "iris-outbox-"));
		try {
			// The agent is asked to "send X": X is placed in the outbox. Other
			// absolute paths may appear in the reply prose/content, but they are
			// on disk OUTSIDE the outbox and must be ignored.
			toOutbox(dir, "X.md", "requested");
			const stray = join(dir, "stray-cli.js");
			writeFileSync(stray, "node cli");

			const { uploads, client } = mockClient();
			for (const file of listOutbox(dir)) {
				await uploadFile(client, file, "C", undefined);
				deleteOutboxFile(file.path);
			}

			expect(uploads.map((u) => u.filename)).toEqual(["X.md"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("replyFilename", () => {
	it("builds a timestamped .md filename from local time", () => {
		// 2026-06-30 20:15:09 local
		const name = replyFilename(new Date(2026, 5, 30, 20, 15, 9));
		expect(name).toBe("iris-reply-20260630-201509.md");
	});

	it("zero-pads month, day, and time fields", () => {
		// 2026-01-05 09:03:07 local
		const name = replyFilename(new Date(2026, 0, 5, 9, 3, 7));
		expect(name).toBe("iris-reply-20260105-090307.md");
	});
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type DeleteResult,
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

/** Drop a file into a session's outbox and return its full path. */
function toOutbox(
	workDir: string,
	sessionKey: string,
	name: string,
	content: string,
): string {
	// Mirror attachments.safeSessionKey so the test writes to the session
	// subdirectory the code reads, exercising the same path layout end to end.
	const key = sessionKey.replace(/[^A-Za-z0-9_-]/g, "_") || "default";
	const dir = join(workDir, ".iris", "outbox", key);
	mkdirSync(dir, { recursive: true });
	const p = join(dir, name);
	writeFileSync(p, content);
	return p;
}

/** Drain a session's outbox the way index.uploadDetected does, and record it. */
async function drain(
	dir: string,
	sessionKey: string,
	channel: string,
	threadTs?: string,
): Promise<{
	uploads: Array<{ filename: string; channel_id: string; thread_ts?: string }>;
	errors: string[];
}> {
	const { uploads, client } = mockClient();
	const errors: string[] = [];
	for (const file of listOutbox(dir, sessionKey)) {
		await uploadFile(client, file, channel, threadTs);
		// deleteOutboxFile returns a status; only a *real* failure (not a benign
		// ENOENT) is an error the caller would surface.
		const result: DeleteResult = deleteOutboxFile(file.path);
		if (!result.ok) errors.push(result.error.message);
	}
	return { uploads, errors };
}

describe("listOutbox", () => {
	it("returns [] when the session outbox does not exist", () => {
		const dir = mkdtempSync(join(tmpdir(), "iris-outbox-"));
		try {
			expect(listOutbox(dir, "1700.0001")).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("lists only regular files, skipping subdirectories", () => {
		const dir = mkdtempSync(join(tmpdir(), "iris-outbox-"));
		try {
			toOutbox(dir, "1700.0001", "a.md", "hello");
			toOutbox(dir, "1700.0001", "b.txt", "world");
			// A subdirectory inside the session outbox must not be listed.
			mkdirSync(join(dir, ".iris", "outbox", "1700_0001", "nested"));
			writeFileSync(
				join(dir, ".iris", "outbox", "1700_0001", "nested", "c.md"),
				"x",
			);
			const files = listOutbox(dir, "1700.0001");
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

	it("sanitizes the session key into a safe path segment", () => {
		const dir = mkdtempSync(join(tmpdir(), "iris-outbox-"));
		try {
			// A thread_ts has a dot: 1700.0001 must map to the 1700_0001 subdir.
			toOutbox(dir, "1700.0001", "a.md", "hello");
			const files = listOutbox(dir, "1700.0001");
			expect(files.map((f) => f.name)).toEqual(["a.md"]);
			expect(files[0]!.path.includes("1700_0001")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("session isolation (the cross-session leak is gone)", () => {
	it("drains only the completing session's outbox, not a sibling session's", async () => {
		const dir = mkdtempSync(join(tmpdir(), "iris-outbox-"));
		try {
			// A different session on the SAME work_dir dropped a file.
			toOutbox(dir, "1700.2222", "theirs.md", "beta");
			// This session's own file.
			toOutbox(dir, "1700.0001", "mine.md", "alpha");

			const { uploads } = await drain(dir, "1700.0001", "C1", "1700.0001");

			// Only this session's file is drained; the sibling's is untouched.
			expect(uploads.map((u) => u.filename)).toEqual(["mine.md"]);
			expect(listOutbox(dir, "1700.2222").map((f) => f.name)).toEqual([
				"theirs.md",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("deleteOutboxFile", () => {
	it("removes an outbox file and reports ok", () => {
		const dir = mkdtempSync(join(tmpdir(), "iris-outbox-"));
		try {
			const p = toOutbox(dir, "1", "gone.txt", "x");
			expect(deleteOutboxFile(p)).toEqual({ ok: true });
			expect(listOutbox(dir, "1")).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("treats a vanished file (ENOENT) as success without throwing", () => {
		const res = deleteOutboxFile("/nonexistent/path/does/not/exist");
		expect(res).toEqual({ ok: true });
	});
});

describe("uploadFile", () => {
	it("uploads the file with its name, channel, and thread", async () => {
		const dir = mkdtempSync(join(tmpdir(), "iris-outbox-"));
		try {
			const p = toOutbox(dir, "1700.0001", "report.pdf", "pdf-bytes");
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
			toOutbox(dir, "1700.0001", "a.md", "alpha");
			toOutbox(dir, "1700.0001", "b.txt", "beta");
			const { uploads, errors } = await drain(
				dir,
				"1700.0001",
				"C999",
				"1700.0002",
			);

			const names = uploads.map((u) => u.filename).sort();
			expect(names).toEqual(["a.md", "b.txt"]);
			// A clean drain produces no deletion errors.
			expect(errors).toEqual([]);
			// After a full drain the session outbox is empty.
			expect(listOutbox(dir, "1700.0001")).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// The old `detectFiles(text)` text-scan is gone: a reply that *quotes* other
// files' absolute paths must NOT cause them to be uploaded. The only transfer
// path is the outbox, so an outbox-free turn uploads nothing.
describe("no text scanning (the auto-attach bug is gone)", () => {
	it("uploads only the outbox file even when other paths exist on disk", async () => {
		const dir = mkdtempSync(join(tmpdir(), "iris-outbox-"));
		try {
			// The agent is asked to "send X": X is placed in the outbox. Other
			// absolute paths (e.g. from dumped file content) live on disk OUTSIDE the
			// outbox and must be ignored.
			toOutbox(dir, "1700.0001", "X.md", "requested");
			writeFileSync(join(dir, "stray-cli.js"), "node cli");

			const { uploads } = await drain(dir, "1700.0001", "C", undefined);

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

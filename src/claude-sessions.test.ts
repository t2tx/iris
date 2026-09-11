import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listClaudeSessions, projectDir } from "./claude-sessions.js";

describe("projectDir", () => {
	const projects = (name: string): string =>
		join(homedir(), ".claude", "projects", name);

	it("encodes a work dir by replacing / with -", () => {
		expect(projectDir("/Users/me/work")).toBe(projects("-Users-me-work"));
	});

	// Claude Code collapses `.` and `_` to `-` as well. Encoding only `/` sent
	// /resume to a directory the CLI never writes, so it silently listed no
	// sessions for any work dir containing those characters (e.g. mile_service).
	it("collapses . and _ to - as well", () => {
		expect(projectDir("/Users/me/mile_service")).toBe(
			projects("-Users-me-mile-service"),
		);
		expect(projectDir("/Users/me/iris-oss.old")).toBe(
			projects("-Users-me-iris-oss-old"),
		);
		expect(projectDir("/Users/me/.worktrees/foo")).toBe(
			projects("-Users-me--worktrees-foo"),
		);
	});

	// The CLI resolves the cwd before encoding, so a symlinked work dir must
	// encode to its real path (on macOS /tmp is a symlink to /private/tmp).
	it("resolves symlinks before encoding", () => {
		const real = mkdtempSync(join(tmpdir(), "iris-real-"));
		const link = join(tmpdir(), `iris-link-${Date.now()}`);
		try {
			symlinkSync(real, link);
			expect(projectDir(link)).toBe(projectDir(realpathSync(real)));
		} finally {
			rmSync(link, { force: true });
			rmSync(real, { recursive: true, force: true });
		}
	});

	// A work dir that no longer exists cannot be resolved; fall back to the raw
	// path rather than throwing, so /resume degrades to "no sessions".
	it("falls back to the raw path when the dir does not exist", () => {
		expect(projectDir("/nonexistent-xyz/work")).toBe(
			projects("-nonexistent-xyz-work"),
		);
	});
});

describe("listClaudeSessions", () => {
	it("returns [] for a work dir with no Claude project dir", () => {
		// A path unlikely to have a corresponding ~/.claude/projects entry.
		const dir = mkdtempSync(join(tmpdir(), "iris-nosess-"));
		try {
			expect(listClaudeSessions(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("lists jsonl sessions newest-first with the first user prompt", () => {
		// Build a fake ~/.claude/projects/<encoded> layout under a temp HOME-like
		// root by exercising the real encoding: we can't redirect homedir(), so we
		// verify parsing indirectly via a hand-built dir matching projectDir().
		const fakeWork = mkdtempSync(join(tmpdir(), "iris-work-"));
		const proj = projectDir(fakeWork);
		// projectDir points under the real home; only run the parse check when we
		// can safely create it (skip if it would collide — it won't, temp name).
		mkdirSync(proj, { recursive: true });
		try {
			const u = (content: string): string =>
				JSON.stringify({ type: "user", message: { content } });
			const a = (text: string): string =>
				JSON.stringify({
					type: "assistant",
					message: { content: [{ type: "text", text }] },
				});
			// 2 human turns + a tool-result-style replay (starts with <, ignored).
			writeFileSync(
				join(proj, "aaa.jsonl"),
				[
					u("first task here"),
					a("working on it"),
					u("<tool_result>noise</tool_result>"),
					u("second and last task"),
					a("done"),
				].join("\n") + "\n",
			);
			const sessions = listClaudeSessions(fakeWork);
			expect(sessions.length).toBe(1);
			expect(sessions[0]!.id).toBe("aaa");
			expect(sessions[0]!.firstPrompt).toBe("first task here");
			expect(sessions[0]!.recentPrompts).toEqual([
				"first task here",
				"second and last task",
			]);
			expect(sessions[0]!.turns).toBe(2); // tag-prefixed replay excluded
		} finally {
			rmSync(proj, { recursive: true, force: true });
			rmSync(fakeWork, { recursive: true, force: true });
		}
	});

	it("keeps only the last 3 human prompts when there are more", () => {
		const fakeWork = mkdtempSync(join(tmpdir(), "iris-work-"));
		const proj = projectDir(fakeWork);
		mkdirSync(proj, { recursive: true });
		try {
			const u = (content: string): string =>
				JSON.stringify({ type: "user", message: { content } });
			writeFileSync(
				join(proj, "bbb.jsonl"),
				[u("t1"), u("t2"), u("t3"), u("t4"), u("t5")].join("\n") + "\n",
			);
			const s = listClaudeSessions(fakeWork)[0]!;
			expect(s.firstPrompt).toBe("t1");
			expect(s.recentPrompts).toEqual(["t3", "t4", "t5"]); // last 3 only
			expect(s.turns).toBe(5);
		} finally {
			rmSync(proj, { recursive: true, force: true });
			rmSync(fakeWork, { recursive: true, force: true });
		}
	});

	it("keeps <-prefixed prompts that are not replay tags (mentions, HTML)", () => {
		const fakeWork = mkdtempSync(join(tmpdir(), "iris-work-"));
		const proj = projectDir(fakeWork);
		mkdirSync(proj, { recursive: true });
		try {
			const u = (content: string): string =>
				JSON.stringify({ type: "user", message: { content } });
			writeFileSync(
				join(proj, "ccc.jsonl"),
				[
					u("<@U0BAHG46XKK> 調べて"), // Slack mention — a real prompt
					u("<task-notification>bg done</task-notification>"), // replay — dropped
					u("<div> について教えて"), // HTML-ish — a real prompt
				].join("\n") + "\n",
			);
			const s = listClaudeSessions(fakeWork)[0]!;
			expect(s.firstPrompt).toBe("<@U0BAHG46XKK> 調べて");
			expect(s.recentPrompts).toEqual([
				"<@U0BAHG46XKK> 調べて",
				"<div> について教えて",
			]);
			expect(s.turns).toBe(2); // only the replay tag is excluded
		} finally {
			rmSync(proj, { recursive: true, force: true });
			rmSync(fakeWork, { recursive: true, force: true });
		}
	});
});

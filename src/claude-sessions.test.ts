import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listClaudeSessions, projectDir } from "./claude-sessions.js";

describe("projectDir", () => {
	it("encodes a work dir by replacing / with -", () => {
		const p = projectDir("/Users/me/work");
		expect(p).toBe(join(homedir(), ".claude", "projects", "-Users-me-work"));
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

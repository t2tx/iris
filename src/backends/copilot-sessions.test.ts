import { expect, test } from "vitest";

import {
	formatCopilotSessions,
	parseCopilotSessionList,
} from "./copilot-sessions.js";

/**
 * copilot-sessions.ts — pure parser for a Copilot `session/list` response.
 * Shapes verified against a real `copilot --acp` v1.0.82 capture.
 */

// ── parseCopilotSessionList ───────────────────────────────────────────────

test("parses a real session/list result shape", () => {
	// Captured from `copilot --acp` v1.0.82 session/list{cwd} response.
	const result = {
		sessions: [
			{
				sessionId: "81d98227-5f6f-4b2a-9fed-ef11d8980880",
				cwd: "/work/foo",
				title: "report the exit code: rm -rf dummy.txt",
				updatedAt: "2026-09-04T03:50:46.730Z",
			},
		],
	};
	expect(parseCopilotSessionList(result)).toEqual([
		{
			id: "81d98227-5f6f-4b2a-9fed-ef11d8980880",
			cwd: "/work/foo",
			title: "report the exit code: rm -rf dummy.txt",
			updatedAt: "2026-09-04T03:50:46.730Z",
		},
	]);
});

test("returns [] for null/undefined/non-result input", () => {
	expect(parseCopilotSessionList(null)).toEqual([]);
	expect(parseCopilotSessionList(undefined)).toEqual([]);
	expect(parseCopilotSessionList("nope")).toEqual([]);
	expect(parseCopilotSessionList({})).toEqual([]);
	// A `error`-only response has no `sessions` key.
	expect(
		parseCopilotSessionList({ error: { code: -1, message: "x" } }),
	).toEqual([]);
});

test("drops malformed entries, defaults missing fields to ''", () => {
	const result = {
		sessions: [
			"not-an-object",
			{
				cwd: "/x",
				title: "t",
				updatedAt: "2026-01-01T00:00:00Z",
			}, // no sessionId
			{}, // empty
			null,
			{
				sessionId: "abc", // missing cwd/title/updatedAt
			},
		],
	};
	expect(parseCopilotSessionList(result)).toEqual([
		{ id: "abc", cwd: "", title: "", updatedAt: "" },
	]);
});

// ── formatCopilotSessions ─────────────────────────────────────────────────

test("formatCopilotSessions returns '' for an empty list", () => {
	expect(formatCopilotSessions([])).toBe("");
});

test("formatCopilotSessions renders newest-first with previewed titles", () => {
	const text = formatCopilotSessions([
		{
			id: "old",
			cwd: "/w",
			title: "an old prompt",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
		{
			id: "new",
			cwd: "/w",
			title: "a newer one here",
			updatedAt: "2026-01-02T00:00:00.000Z",
		},
	]);
	// "newest first": the newer session appears before the older one.
	expect(text.indexOf("new")).toBeLessThan(text.indexOf("old"));
	expect(text).toContain("a newer one");
	expect(text).toContain("/resume");
});

test("formatCopilotSessions shows (unknown) for an unparseable timestamp", () => {
	const text = formatCopilotSessions([
		{ id: "x", cwd: "/w", title: "t", updatedAt: "" },
	]);
	expect(text).toContain("(unknown)");
});

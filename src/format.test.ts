import { expect, test } from "vitest";

import {
	applyNoReply,
	toolProgressLine,
	toSlackMrkdwn,
	usageFooter,
} from "./format.js";

test("applyNoReply: whole reply is the marker → null", () => {
	expect(applyNoReply("NO_REPLY")).toBe(null);
	expect(applyNoReply("no_reply")).toBe(null); // case-insensitive
	expect(applyNoReply("  NO_REPLY  ")).toBe(null);
});

test("applyNoReply: reasoning before marker is preserved", () => {
	expect(applyNoReply("Looks fine.\nNO_REPLY")).toBe("Looks fine.");
	expect(applyNoReply("Done.\n\n  NO_REPLY")).toBe("Done.");
});

test("applyNoReply: no marker → unchanged (trimmed)", () => {
	expect(applyNoReply("hello world")).toBe("hello world");
	expect(applyNoReply("  spaced  ")).toBe("spaced");
});

test("applyNoReply: only a marker mid-text is NOT stripped (must be trailing)", () => {
	expect(applyNoReply("NO_REPLY but actually reply")).toBe(
		"NO_REPLY but actually reply",
	);
});

test("applyNoReply: NO_REPLY is judged on the FULL turn text, not per-delta", () => {
	// Token-level streams (e.g. Pi's text_delta) deliver words with surrounding
	// spaces. The correct pattern accumulates the RAW chunks, then trims /
	// strips NO_REPLY once. Per-delta calling of applyNoReply stripped the
	// inter-word spaces (the streaming-path bug this guards against).
	const chunks = ["I'm ", "ready ", "to ", "help "];
	const raw = chunks.join("");
	expect(applyNoReply(raw)).toBe("I'm ready to help"); // spaces preserved

	// The old per-delta pattern destroyed the spacing between words:
	const perDelta = chunks
		.map((c) => applyNoReply(c))
		.filter((s): s is string => s !== null)
		.join("");
	expect(perDelta).toBe("I'mreadytohelp"); // spaces lost -> regression
});

test("toSlackMrkdwn: bold and headings", () => {
	expect(toSlackMrkdwn("**bold**")).toBe("*bold*");
	expect(toSlackMrkdwn("# Heading")).toBe("*Heading*");
	expect(toSlackMrkdwn("### Sub")).toBe("*Sub*");
});

test("toSlackMrkdwn: plain text untouched", () => {
	expect(toSlackMrkdwn("just text")).toBe("just text");
});

test("toolProgressLine: summarizes known tools", () => {
	expect(toolProgressLine("Bash", { command: "ls -la" })).toMatch(
		/Bash — ls -la/,
	);
	expect(toolProgressLine("Read", { file_path: "/x/y.ts" })).toMatch(
		/Read — \/x\/y\.ts/,
	);
});

test("toolProgressLine: Pi's lowercase tools surface their path via `path`", () => {
	// Pi emits lowercase tool names AND names the file field `path` (not Claude's
	// `file_path`). The extractor prefers file_path (Claude) then falls back to
	// path (Pi), so the 🛠️ line must show the path for both backends.
	expect(toolProgressLine("read", { path: "/x/y.ts" })).toMatch(
		/read — \/x\/y\.ts/,
	);
	expect(toolProgressLine("write", { path: "/x/z.md" })).toMatch(
		/write — \/x\/z\.md/,
	);
	expect(toolProgressLine("edit", { path: "/x/e.ts" })).toMatch(
		/edit — \/x\/e\.ts/,
	);
});

test("toolProgressLine: Claude's `file_path` still wins when present", () => {
	// A file field under BOTH names resolves to the Claude `file_path` value
	// (it has precedence over the Pi `path` fallback).
	expect(
		toolProgressLine("Read", { file_path: "/claude/z.ts", path: "/pi/z.ts" }),
	).toMatch(/Read — \/claude\/z\.ts/);
});

test("toolProgressLine: unknown tool with no usable input has no detail", () => {
	expect(toolProgressLine("Mystery", {}).includes("—")).toBe(false);
});

test("toolProgressLine: unknown/MCP tool surfaces a representative field", () => {
	// A generic tool: pull an allowlisted key…
	expect(toolProgressLine("mcp__foo__bar", { query: "find widgets" })).toMatch(
		/mcp__foo__bar — find widgets/,
	);
	// …but a non-allowlisted field is NOT surfaced: it could hold a token or file
	// contents (MCP schemas are arbitrary), so only the bare tool name shows.
	expect(toolProgressLine("Weird", { thing: "hello" }).includes("—")).toBe(
		false,
	);
});

test("toolProgressLine: summarizes more built-in tools", () => {
	expect(
		toolProgressLine("Task", { subagent_type: "Explore", description: "scan" }),
	).toMatch(/Task — Explore — scan/);
	expect(toolProgressLine("WebFetch", { url: "https://x" })).toMatch(
		/WebFetch — https:\/\/x/,
	);
	expect(toolProgressLine("TodoWrite", { todos: [1, 2, 3] })).toMatch(
		/TodoWrite — 3 item\(s\)/,
	);
});

test("toolProgressLine: Bash allows long commands, clips only very long ones", () => {
	// A 300-char command is now shown in full (Bash limit raised).
	const cmd = "echo " + "x".repeat(295);
	expect(
		!toolProgressLine("Bash", { command: cmd }).endsWith("…"),
	).toBeTruthy();
	// But an extreme command is still clipped to keep the line bounded.
	const huge = "a".repeat(2000);
	const line = toolProgressLine("Bash", { command: huge });
	expect(line.endsWith("…")).toBeTruthy();
	expect(line.length < 900).toBeTruthy();
});

test("usageFooter: formats token counts and cost", () => {
	const line = usageFooter({
		inputTokens: 8500,
		outputTokens: 250,
		cacheReadTokens: 5000,
		costUSD: 0.0048,
		durationMs: 3200,
	});
	expect(line.includes("in:8.5k")).toBeTruthy();
	expect(line.includes("out:250")).toBeTruthy();
	expect(line.includes("cache:5.0k")).toBeTruthy();
	expect(line.includes("$0.0048")).toBeTruthy();
	expect(line.includes("3.2s")).toBeTruthy();
	// wrapped in italic
	expect(line.startsWith("_")).toBeTruthy();
	expect(line.endsWith("_")).toBeTruthy();
});

test("usageFooter: omits cache and cost when zero", () => {
	const line = usageFooter({
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 0,
		costUSD: 0,
		durationMs: 0,
	});
	expect(!line.includes("cache")).toBeTruthy();
	expect(!line.includes("$")).toBeTruthy();
	expect(line.includes("in:100")).toBeTruthy();
});

test("usageFooter: returns empty string for a no-op turn", () => {
	const line = usageFooter({
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		costUSD: 0,
		durationMs: 0,
	});
	expect(line).toBe("");
});

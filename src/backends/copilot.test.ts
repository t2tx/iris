import { expect, test } from "vitest";

import { copilotPermissionFlags } from "./copilot.js";

/**
 * copilot.ts — launch-time tool-gating flags.
 *
 * Copilot's ACP mode (verified against v1.0.82) is non-interactive: tool gating
 * is decided ONCE at process start (no per-call request). This tests the pure
 * mapping without spawning a process.
 */

test("auto → --allow-all", () => {
	expect(copilotPermissionFlags("auto")).toEqual(["--allow-all"]);
});

test("acceptEdits → --allow-tool 'write'", () => {
	expect(copilotPermissionFlags("acceptEdits")).toEqual([
		"--allow-tool",
		"write",
	]);
});

test("manual → no flags (Copilot's declared-policy default)", () => {
	expect(copilotPermissionFlags("manual")).toEqual([]);
});

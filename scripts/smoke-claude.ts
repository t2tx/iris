/**
 * smoke-claude.ts — E2E smoke test for the Claude Code backend.
 *
 * Spawns a real `claude --output-format stream-json` process via ClaudeProcess
 * and verifies the full lifecycle: spawn → session → prompt → text → result →
 * close. Mirrors scripts/smoke-pi.ts but drives Claude instead of Pi.
 *
 * Usage:
 *   pnpm exec tsx scripts/smoke-claude.ts
 *   CLAUDE_BIN=/path/to/claude pnpm exec tsx scripts/smoke-claude.ts
 *   SMOKE_TIMEOUT=30000 pnpm exec tsx scripts/smoke-claude.ts
 *
 * Exit code 0 = all PASS, 1 = any FAIL.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { AgentOptions, PermissionMode } from "../src/agent.js";
import { ClaudeProcess } from "../src/backends/claude.js";

// ── Configuration ──────────────────────────────────────────────────────────

const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT) || 120_000;

function findClaudeBin(): string {
	if (process.env.CLAUDE_BIN) {
		if (!existsSync(process.env.CLAUDE_BIN)) {
			die(`CLAUDE_BIN="${process.env.CLAUDE_BIN}" が見つかりません。`);
		}
		return process.env.CLAUDE_BIN;
	}
	try {
		const resolved = execFileSync("which", ["claude"], {
			encoding: "utf-8",
		}).trim();
		if (resolved) return resolved;
	} catch {}
	die(
		"Claude CLI が見つかりません。\n" +
			"   - `claude` を PATH に追加するか、\n" +
			"   - CLAUDE_BIN=/path/to/claude を指定してください。",
	);
}

function die(msg: string): never {
	console.error(`\n[SMOKE-CLAUDE] FAIL: ${msg}\n`);
	process.exit(1);
}

// ── Test harness ───────────────────────────────────────────────────────────

interface Step {
	name: string;
	pass: boolean;
	detail?: string;
}

const steps: Step[] = [];

function record(name: string, pass: boolean, detail?: string): void {
	steps.push({ name, pass, detail });
	const tag = pass ? "PASS" : "FAIL";
	const suffix = detail ? `    (${detail})` : "";
	console.log(`    [${tag}] ${name}${suffix}`);
}

async function waitFor(
	condition: () => boolean,
	timeoutMs: number,
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (condition()) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return condition();
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	console.log("[SMOKE-CLAUDE] Claude Code backend smoke test");
	console.log(`  timeout: ${TIMEOUT_MS}ms`);

	const bin = findClaudeBin();
	console.log(`  bin: ${bin}`);

	const opts: AgentOptions = {
		bin,
		workDir: process.cwd(),
		// Keep the turn tiny and read-only-ish; it must only emit text.
		appendSystemPrompt: "Reply in one short sentence. Do not call any tools.",
	};
	const mode: PermissionMode = "auto";

	const proc = new ClaudeProcess(opts, mode);

	proc.on("stderr", (line: string) => {
		console.log(`      [stderr] ${line}`);
	});

	let sessionId = "";
	proc.on("session", (sid: string) => {
		sessionId = sid;
	});

	let spawnError: Error | undefined;
	proc.on("error", (err: Error) => {
		if (!spawnError) spawnError = err;
	});

	let exitCode: number | null | undefined;
	proc.on("exit", (code: number | null) => {
		exitCode = code;
	});

	try {
		// ── Step 1: spawn + session acquisition ──
		await waitFor(
			() => sessionId.length > 0 || spawnError !== undefined || !proc.isAlive(),
			TIMEOUT_MS,
		);

		if (spawnError) {
			record("spawn + session", false, spawnError.message);
			proc.close();
			report();
			return;
		}

		if (!proc.isAlive() && !sessionId) {
			record(
				"spawn + session",
				false,
				`process exited (code=${exitCode ?? "null"}) without session`,
			);
			report();
			return;
		}

		if (sessionId) record("spawn + session", true, `sessionId=${sessionId}`);
		else
			record("spawn + session", true, "process alive (no session id emitted)");

		// ── Step 2: prompt → text response ──
		let textContent = "";
		proc.on("text", (t: string) => {
			textContent += t;
		});

		proc.send("Say hello");

		const hadText = await waitFor(() => textContent.length > 0, TIMEOUT_MS);
		if (hadText) {
			record("prompt → text", true, `received: "${textContent.slice(0, 80)}"`);
		} else {
			record("prompt → text", false, "no text event within timeout");
			proc.close();
			report();
			return;
		}

		// ── Step 3: result event ──
		let resultReceived = false;
		proc.on("result", () => {
			resultReceived = true;
		});

		const gotResult = await waitFor(() => resultReceived, TIMEOUT_MS);
		record("→ result", gotResult, gotResult ? "received" : "timeout");

		// ── Step 4: close ──
		proc.close();
		const exited = await waitFor(() => !proc.isAlive(), TIMEOUT_MS);
		record(
			"close",
			exited,
			exited
				? `exit code: ${exitCode ?? "signal"}`
				: "process did not exit within timeout",
		);
	} catch (err) {
		record("unexpected error", false, String(err));
		proc.close();
	}

	report();
}

function report(): void {
	console.log("");
	const failed = steps.filter((s) => !s.pass);
	if (failed.length === 0) {
		console.log("[SMOKE-CLAUDE] All checks PASSED ✓");
		process.exit(0);
	} else {
		console.log(`[SMOKE-CLAUDE] ${failed.length} check(s) FAILED ✗`);
		for (const s of failed) {
			console.log(`  FAILED: ${s.name}${s.detail ? ` — ${s.detail}` : ""}`);
		}
		process.exit(1);
	}
}

main();

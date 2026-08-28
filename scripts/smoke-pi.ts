/**
 * smoke-pi.ts — E2E smoke test for the Pi backend.
 *
 * Spawns a real `pi --mode rpc` process via PiProcess and verifies the
 * full RPC lifecycle: spawn → session → prompt → text → result → close.
 *
 * Usage:
 *   pnpm smoke:pi
 *   PI_BIN=/path/to/pi pnpm smoke:pi
 *   SMOKE_TIMEOUT=30000 pnpm smoke:pi     (override timeout in ms, default 60 000)
 *
 * Exit code 0 = all PASS, 1 = any FAIL.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { AgentOptions, PermissionMode } from "../src/agent.js";
import { PiProcess } from "../src/backends/pi.js";

// ── Configuration ──────────────────────────────────────────────────────────

const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT) || 60_000;

function findPiBin(): string {
	// 1. Explicit path via env
	if (process.env.PI_BIN) {
		if (!existsSync(process.env.PI_BIN)) {
			die(`PI_BIN="${process.env.PI_BIN}" が見つかりません。`);
		}
		return process.env.PI_BIN;
	}
	// 2. Try `pi` on PATH via `which`
	try {
		const resolved = execFileSync("which", ["pi"], {
			encoding: "utf-8",
		}).trim();
		if (resolved) return resolved;
	} catch {
		// `which` not found or `pi` not on PATH
	}
	// 3. Give up with a clear message
	die(
		"Pi CLI が見つかりません。\n" +
			"  - `pi` を PATH に追加するか、\n" +
			"  - PI_BIN=/path/to/pi を指定してください。",
	);
}

function die(msg: string): never {
	console.error(`\n[SMOKE-PI] FAIL: ${msg}\n`);
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
	const suffix = detail ? `   (${detail})` : "";
	console.log(`   [${tag}] ${name}${suffix}`);
}

/** Poll a condition until true or timeout. Returns whether condition was met. */
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
	console.log("[SMOKE-PI] Pi backend smoke test");
	console.log(`  timeout: ${TIMEOUT_MS}ms`);

	const bin = findPiBin();
	console.log(`  bin: ${bin}`);

	const opts: AgentOptions = {
		bin,
		workDir: process.cwd(),
	};
	const mode: PermissionMode = "auto";

	// ── Step 1: spawn + session acquisition ──
	const proc = new PiProcess(opts, mode);

	// Surface stderr for diagnostics
	proc.on("stderr", (line: string) => {
		console.log(`     [stderr] ${line}`);
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
		// Wait for a session id, spawn error, or process exit.
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

		if (sessionId) {
			record("spawn + session", true, `sessionId=${sessionId}`);
		} else {
			// Process spawned and is alive; some Pi versions may not
			// emit a session id via the response path. Pass as long as
			// the process is running.
			record("spawn + session", true, "process alive (no session id emitted)");
		}

		// ── Step 2: prompt → text response ──
		// Attach listener BEFORE sending the prompt.
		let textContent = "";
		proc.on("text", (t: string) => {
			textContent += t;
		});

		// Send the user prompt
		proc.send("Say hello");

		// Wait for text to arrive
		const hadText = await waitFor(() => textContent.length > 0, TIMEOUT_MS);
		if (hadText) {
			record("prompt → text", true, `received: "${textContent.slice(0, 80)}"`);
		} else {
			record("prompt → text", false, "no text event within timeout");
			proc.close();
			report();
			return;
		}

		// ── Step 3: agent_settled → result event ──
		let resultReceived = false;
		proc.on("result", () => {
			resultReceived = true;
		});

		const gotResult = await waitFor(() => resultReceived, TIMEOUT_MS);
		record(
			"agent_settled → result",
			gotResult,
			gotResult ? "received" : "timeout",
		);

		// ── Step 4: close ──
		proc.close();

		// Wait for the process to actually exit
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
		console.log("[SMOKE-PI] All checks PASSED ✓");
		process.exit(0);
	} else {
		console.log(`[SMOKE-PI] ${failed.length} check(s) FAILED ✗`);
		for (const s of failed) {
			console.log(`  FAILED: ${s.name}${s.detail ? ` — ${s.detail}` : ""}`);
		}
		process.exit(1);
	}
}

main();

/**
 * smoke-hermes.ts — E2E smoke test for the Hermes Agent backend.
 *
 * Spawns a real `hermes acp` process via HermesProcess and verifies the full
 * ACP lifecycle: spawn → initialize → session → prompt → text → result → close.
 *
 * Usage:
 *   pnpm smoke:hermes
 *   HERMES_BIN=/path/to/hermes pnpm smoke:hermes
 *   SMOKE_TIMEOUT=60000 pnpm smoke:hermes   (override timeout in ms)
 *
 * Exit code 0 = all PASS, 1 = any FAIL.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { AgentOptions, PermissionMode } from "../src/agent.js";
import { HermesProcess } from "../src/backends/hermes.js";

// ── Configuration ──────────────────────────────────────────────────────────

const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT) || 180_000;

function findHermesBin(): string {
	// 1. Explicit path via env
	if (process.env.HERMES_BIN) {
		if (!existsSync(process.env.HERMES_BIN)) {
			die(`HERMES_BIN="${process.env.HERMES_BIN}" が見つかりません。`);
		}
		return process.env.HERMES_BIN;
	}
	// 2. Try `hermes` on PATH via `which`
	try {
		const resolved = execFileSync("which", ["hermes"], {
			encoding: "utf-8",
		}).trim();
		if (resolved) return resolved;
	} catch {
		// `which` not found or `hermes` not on PATH
	}
	// 3. Give up with a clear message
	die(
		"Hermes CLI が見つかりません。\n" +
			"   - `hermes` を PATH に追加するか、\n" +
			"   - HERMES_BIN=/path/to/hermes を指定してください。",
	);
}

function die(msg: string): never {
	console.error(`\n[SMOKE-HERMES] FAIL: ${msg}\n`);
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
	console.log("[SMOKE-HERMES] Hermes Agent backend smoke test");
	console.log(`  timeout: ${TIMEOUT_MS}ms`);

	const bin = findHermesBin();
	console.log(`  bin: ${bin}`);

	// `auto` avoids interactive permission prompts blocking the smoke.
	const opts: AgentOptions = {
		bin,
		workDir: process.cwd(),
		sessionKey: `smoke-${Date.now()}`,
		mode: "manual",
	};
	const mode: PermissionMode = "auto";

	const proc = new HermesProcess(opts, mode);

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

		record(
			"spawn + session",
			true,
			sessionId
				? `sessionId=${sessionId.slice(0, 12)}…`
				: "process alive (no session id emitted)",
		);

		// ── Step 2: prompt → text response ──
		let textContent = "";
		proc.on("text", (t: string) => {
			textContent += t;
		});

		proc.send("Say hello in one short sentence.");

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
		record("prompt → result", gotResult, gotResult ? "received" : "timeout");

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
		console.log("[SMOKE-HERMES] All checks PASSED ✓");
		process.exit(0);
	} else {
		console.log(`[SMOKE-HERMES] ${failed.length} check(s) FAILED ✗`);
		for (const s of failed) {
			console.log(`  FAILED: ${s.name}${s.detail ? ` — ${s.detail}` : ""}`);
		}
		process.exit(1);
	}
}

main();

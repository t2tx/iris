/**
 * smoke-copilot.ts — E2E smoke test for the Copilot Agent backend.
 *
 * Spawns a real `copilot --acp` process via CopilotProcess and verifies the
 * full ACP lifecycle: spawn → initialize → session/new → session/prompt →
 * text → result(usage) → close, plus a best-effort grandchild-reaping check.
 *
 * Unlike smoke-hermes.ts, this SKIPs (exit 0) when `copilot` is absent rather
 * than failing — `copilot` is an optional backend, so its absence must not break
 * CI. Pass `COPILOT_BIN=/path/to/copilot` to override discovery.
 *
 * Usage:
 *   pnpm smoke:copilot
 *   COPILOT_BIN=/path/to/copilot pnpm smoke:copilot
 *   SMOKE_TIMEOUT=60000 pnpm smoke:copilot    (override timeout in ms)
 *
 * Exit code 0 = all PASS or skipped, 1 = any FAIL.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { AgentOptions, PermissionMode } from "../src/agent.js";
import { CopilotProcess } from "../src/backends/copilot.js";
import { usageFooter } from "../src/format.js";
import type { UsageInfo } from "../src/protocol.js";

// ── Configuration ──────────────────────────────────────────────────────────

const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT) || 180_000;

/**
 * Locate the copilot binary, or return undefined to signal "skip".
 *  1. COPILOT_BIN env (path must exist)
 *  2. `which copilot` on PATH
 *  3. undefined → caller skips.
 */
function findCopilotBin(): string | undefined {
	if (process.env.COPILOT_BIN) {
		if (!existsSync(process.env.COPILOT_BIN)) {
			console.error(
				`[SMOKE-COPILOT] COPILOT_BIN="${process.env.COPILOT_BIN}" ` +
					"が見つかりません。",
			);
			process.exit(1);
		}
		return process.env.COPILOT_BIN;
	}
	try {
		const resolved = execFileSync("which", ["copilot"], {
			encoding: "utf-8",
		}).trim();
		if (resolved) return resolved;
	} catch {
		// `which` not found or `copilot` not on PATH
	}
	return undefined;
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
	const suffix = detail ? ` (${detail})` : "";
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

/**
 * Count live child processes of a pid (best-effort grandchild-reaping probe).
 * Returns -1 if the platform probe is unavailable (treated as "not a failure").
 */
function countChildren(pid: number): number {
	try {
		const out = execFileSync("ps", ["-axo", "pid,ppid"], {
			encoding: "utf-8",
		});
		let n = 0;
		for (const line of out.split("\n")) {
			const [c, p] = line.trim().split(/\s+/);
			if (c && p === String(pid)) n++;
		}
		return n;
	} catch {
		return -1;
	}
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	console.log("[SMOKE-COPILOT] Copilot Agent backend smoke test");
	console.log(`  timeout: ${TIMEOUT_MS}ms`);

	const bin = findCopilotBin();
	if (!bin) {
		console.log(
			"  [SKIP] `copilot` not found on PATH — skipping (optional backend).\n" +
				"         run with COPILOT_BIN=/path/to/copilot to exercise.",
		);
		process.exit(0);
	}
	console.log(`  bin: ${bin}`);

	// `auto` grants tool permissions non-interactively (verify R2: copilot ACP
	// does NO interactive permission round-trip, so a turn must run with the
	// launch flag `--allow-all`).
	const opts: AgentOptions = {
		bin,
		workDir: process.cwd(),
		sessionKey: `smoke-${Date.now()}`,
	};
	const mode: PermissionMode = "auto";

	const proc = new CopilotProcess(opts, mode);

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
	let textContent = "";
	proc.on("text", (t: string) => {
		textContent += t;
	});
	let resultReceived = false;
	let resultUsage: UsageInfo | undefined;
	proc.on(
		"result",
		(_raw: Record<string, unknown>, usage: UsageInfo | undefined) => {
			resultReceived = true;
			resultUsage = usage;
		},
	);

	try {
		// ── Step 1: spawn + session acquisition ──
		await waitFor(
			() => sessionId.length > 0 || spawnError !== undefined || !proc.isAlive(),
			TIMEOUT_MS,
		);
		if (spawnError) {
			record("spawn + session/new", false, spawnError.message);
			proc.close();
			report();
			return;
		}
		if (!proc.isAlive() && !sessionId) {
			record(
				"spawn + session/new",
				false,
				`process exited (code=${exitCode ?? "null"}) without a session`,
			);
			proc.close();
			report();
			return;
		}
		record(
			"spawn + session/new",
			true,
			sessionId
				? `sessionId=${sessionId.slice(0, 12)}…`
				: "process alive (no id emitted)",
		);

		// ── Step 2: prompt → text ──
		proc.send(
			"In one short sentence, run a shell command that prints PERM_OK, " +
				"then reply with that exact word.",
		);
		const hadText = await waitFor(() => textContent.length > 0, TIMEOUT_MS);
		if (hadText) {
			record("prompt → text", true, `received: "${textContent.slice(0, 80)}"`);
		} else {
			record("prompt → text", false, "no text event within timeout");
			proc.close();
			report();
			return;
		}

		// ── Step 3: result event (with usage) ──
		const gotResult = await waitFor(() => resultReceived, TIMEOUT_MS);
		record("prompt → result", gotResult, gotResult ? "received" : "timeout");

		// ── Step 4: usage → footer (proves the UsageInfo projection end-to-end) ──
		if (resultUsage) {
			const footer = usageFooter({
				inputTokens: resultUsage.inputTokens,
				outputTokens: resultUsage.outputTokens,
				cacheReadTokens: resultUsage.cacheReadTokens,
				costUSD: resultUsage.costUSD,
				durationMs: resultUsage.durationMs,
			});
			record(
				"result → usage footer",
				footer.length > 0,
				`${resultUsage.inputTokens} in / ${resultUsage.outputTokens} out → ${footer || "(empty)"}`,
			);
		} else {
			record("result → usage footer", true, "no usage payload (acceptable)");
		}

		// ── Step 5: close + grandchild reaping ──
		const pidBefore = proc.getPid();
		proc.close();
		const exited = await waitFor(() => !proc.isAlive(), TIMEOUT_MS);
		record(
			"close",
			exited,
			exited
				? `exit code: ${exitCode ?? "signal"}`
				: "process did not exit within timeout",
		);
		if (exited && pidBefore !== undefined) {
			// Give grandchildren a moment to reap, then probe for orphans.
			await new Promise((r) => setTimeout(r, 500));
			const orphans = countChildren(pidBefore);
			record(
				"grandchildren reaped",
				orphans <= 0,
				orphans < 0
					? "probe unavailable (best-effort skipped)"
					: `${orphans} child(ren) of pid ${pidBefore}`,
			);
		}
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
		console.log("[SMOKE-COPILOT] All checks PASSED ✓");
		process.exit(0);
	} else {
		console.log(`[SMOKE-COPILOT] ${failed.length} check(s) FAILED ✗`);
		for (const s of failed) {
			console.log(`  FAILED: ${s.name}${s.detail ? ` — ${s.detail}` : ""}`);
		}
		process.exit(1);
	}
}

main();

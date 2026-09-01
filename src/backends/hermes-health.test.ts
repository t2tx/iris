import { expect, test } from "vitest";

import {
	classifyHermesAcpHealth,
	HERMES_ACP_PRECHECK_PHASE,
	HERMES_ACP_RECOVERY,
} from "./hermes-health.js";

// ── healthy ─────────────────────────────────────────────────────────────

test("exit 0 with a clean OK probe is healthy", () => {
	const res = classifyHermesAcpHealth({
		stdout: "OK\n",
		stderr: "",
		exitCode: 0,
	});
	expect(res.ok).toBe(true);
});

test("exit 0 with empty output is healthy", () => {
	const res = classifyHermesAcpHealth({ stdout: "", stderr: "", exitCode: 0 });
	expect(res.ok).toBe(true);
});

// ── missing agent-client-protocol (the case #83 guards) ──────────────────

test("ModuleNotFoundError for acp is unhealthy with recovery", () => {
	const res = classifyHermesAcpHealth({
		stdout: "",
		stderr: "ModuleNotFoundError: No module named 'acp'\n",
		exitCode: 1,
	});
	expect(res.ok).toBe(false);
	if (!res.ok) {
		expect(res.phase).toBe(HERMES_ACP_PRECHECK_PHASE);
		expect(res.recovery).toBe(HERMES_ACP_RECOVERY);
		expect(res.recovery).toContain("agent-client-protocol==0.9.0");
		expect(res.recovery).toContain("hermes acp --check");
	}
});

test("bare 'No module named' is treated as unhealthy with recovery", () => {
	const res = classifyHermesAcpHealth({
		stdout: "",
		stderr: "ImportError: No module named 'acp_adapter'",
		exitCode: 1,
	});
	expect(res.ok).toBe(false);
	if (!res.ok) expect(res.recovery).toBe(HERMES_ACP_RECOVERY);
});

// ── generic failures still surface the recovery hint ───────────────────────

test("non-zero exit with unrelated error still yields recovery hint", () => {
	const res = classifyHermesAcpHealth({
		stdout: "Traceback (most recent call last): ... RuntimeError",
		stderr: "",
		exitCode: 1,
	});
	expect(res.ok).toBe(false);
	if (!res.ok) {
		expect(res.phase).toBe(HERMES_ACP_PRECHECK_PHASE);
		expect(res.recovery).toBe(HERMES_ACP_RECOVERY);
	}
});

test("null exit code (timeout / signal) is unhealthy", () => {
	const res = classifyHermesAcpHealth({
		stdout: "",
		stderr: "",
		exitCode: null,
	});
	expect(res.ok).toBe(false);
	if (!res.ok) expect(res.recovery).toBe(HERMES_ACP_RECOVERY);
});

// ── the recovery message is a stable contract for smoke (#88) ─────────────

test("recovery message mentions the durable install and the check", () => {
	expect(HERMES_ACP_RECOVERY).toContain("pip install");
	expect(HERMES_ACP_RECOVERY).toContain("hermes acp --check");
	expect(HERMES_ACP_RECOVERY).toContain("hermes setup");
});

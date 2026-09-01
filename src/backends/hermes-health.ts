/**
 * hermes-health.ts — pre-spawn health gate for the Hermes ACP backend.
 *
 * Background (issue #83): Hermes' ACP adapter (`hermes acp` → `acp_adapter`)
 * requires the Python module `agent-client-protocol==0.9.0`. In a Homebrew
 * install the module lives only inside the Cellar, so a `brew upgrade
 * hermes-agent` can drop it; the symptom is `ModuleNotFoundError: No module
 * named 'acp'` when the ACP server starts. Today the machine was patched by
 * hand-injecting the package, which is not durable.
 *
 * The backend must detect this BEFORE spawning the agent — a missing acp module
 * would otherwise surface as a dead stdout with no agent output (hard to
 * diagnose). This module keeps the decision PURE (no IO) so it is unit-testable:
 *   - `classifyHermesAcpHealth(...)` maps a probe result to a health outcome.
 *   - `hermesAcpRecoveryMessage()` builds the user-facing recovery text.
 * hermes.ts (WBS-6, #87) runs the probe and feeds the classification into a
 * graceful `error` event (not a crash); the smoke in #88 exercises the missing
 * case.
 */

export type HermesAcpHealth =
	| { ok: true }
	| { ok: false; phase: string; recovery: string };

/** The phase tag hermes.ts forwards into the `error` event when the gate fails. */
export const HERMES_ACP_PRECHECK_PHASE = "hermes-acp-precheck";

/**
 * Recovery instructions to surface when `agent-client-protocol` is missing.
 * Kept as a module-level constant so smoke (#88) can assert on its presence.
 */
export const HERMES_ACP_RECOVERY = [
	"Hermes ACP is unavailable: the Python module `agent-client-protocol` is missing.",
	"Recover with one of:",
	"   - pip install 'agent-client-protocol==0.9.0'   (into the Python that runs hermes)",
	"   - hermes acp --check      (verify the ACP adapter imports)",
	"   - hermes setup            (re-run provider / dependency setup)",
].join("\n");

/**
 * Classify a `hermes acp --check` (or `import acp`) probe result.
 *
 * A probe is healthy only when it exits 0 AND its combined output carries no
 * module-not-found signature. Any non-zero / empty / missing-module result is
 * unhealthy, with the same recovery hint (a missing acp module is by far the
 * most common cause of ACP startup failure).
 */
export function classifyHermesAcpHealth(opts: {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}): HermesAcpHealth {
	const out = `${opts.stdout}\n${opts.stderr}`;
	const missingModule = /module not found|no module named\s+["']?acp/i.test(
		out,
	);

	// Healthy: clean exit and no missing-module signature anywhere in the output.
	if (opts.exitCode === 0 && !missingModule) {
		return { ok: true };
	}

	// Everything else is unhealthy. Whether or not we saw a module signature,
	// the recovery hint is the same.
	return {
		ok: false,
		phase: HERMES_ACP_PRECHECK_PHASE,
		recovery: HERMES_ACP_RECOVERY,
	};
}

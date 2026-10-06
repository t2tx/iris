import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Contract test for the `npm` job of `.github/workflows/release.yml`.
 *
 * Publishing moved from a long-lived npm access token to Trusted Publishing
 * (OIDC). The token route failed on v0.4.1: a granular npm token expires after
 * at most 90 days, and `npm publish` answered the dead token with
 * `E404 Not Found - PUT https://registry.npmjs.org/@t2tx%2firis`. Because the
 * `release` job lists `npm` in `needs`, that one failure skipped the GitHub
 * Release as well and threw away the four platform binaries that had built
 * successfully.
 *
 * The OIDC route has its own invariants, and every one of them is invisible
 * until a release is attempted:
 *
 *   1. the job needs `id-token: write`, and a job-level `permissions` block
 *      *replaces* the workflow-level one, so `contents: read` must be restated,
 *   2. npm requires CLI >= 11.5.1 — the npm bundled with our Node build is
 *      10.9.3, so the job installs a pinned npm first,
 *   3. any leftover `NODE_AUTH_TOKEN` makes the run authenticate with a token
 *      again, which hides a broken trusted-publisher configuration behind a
 *      success (or behind a second, unrelated expiry).
 *
 * These are text-level guards: a YAML parser is not a dependency of this
 * package and adding one to make a test pass would put a runtime-adjacent
 * decision in `package.json` without an issue for it. The slicing below is
 * therefore indentation-based, and a future restructuring of the workflow that
 * defeats it fails loudly in the first assertion rather than passing vacuously.
 * The package deliberately has no YAML dependency, so the parse check that this
 * file cannot do was run by hand with `python3 -c "import yaml; ..."` when the
 * job was edited.
 */

const ROOT = resolve(__dirname, "..");
const WORKFLOW_PATH = resolve(ROOT, ".github/workflows", "release.yml");
const workflow = readFileSync(WORKFLOW_PATH, "utf8");

/** Minimum npm CLI that supports trusted publishing (npm docs). */
const MIN_TRUSTED_PUBLISHING_NPM = [11, 5, 1];

/**
 * Body of the `npm` job: from its top-level key down to the next top-level key.
 * Job keys are indented by exactly two spaces, so nested mappings (`steps:`,
 * `permissions:`, `with:`) and list items never terminate the slice.
 */
function npmJobBody(text: string): string {
	const start = text.indexOf("\n  npm:\n");
	if (start === -1) return "";
	const rest = text.slice(start + 1);
	const end = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
	return end === -1 ? rest : rest.slice(0, end);
}

const npmJob = npmJobBody(workflow);

describe("release.yml npm job is present and sliced correctly", () => {
	test("the npm job block is found and the slice does not leak into its steps", () => {
		expect(npmJob.startsWith("  npm:\n")).toBe(true);
		expect(npmJob).toContain("    steps:");
		// If the slice ran past the job, the next job's key would be inside it.
		expect(npmJob).not.toContain("\n  macos-binary:");
	});
});

describe("release.yml npm job authenticates with OIDC only", () => {
	test("the job requests an OIDC token", () => {
		expect(/^ {6}id-token:\s*write\b/m.test(npmJob)).toBe(true);
	});

	test("the job restates contents: read, because job permissions replace workflow permissions", () => {
		expect(/^ {6}contents:\s*read\s*$/m.test(npmJob)).toBe(true);
	});

	test("no step hands npm a token — a token would mask a broken trusted publisher", () => {
		expect(workflow).not.toMatch(/NODE_AUTH_TOKEN/);
		expect(workflow).not.toMatch(/secrets\.NPM_TOKEN/);
	});

	test("the scoped package is still published publicly", () => {
		expect(npmJob).toMatch(/npm publish --access public/);
	});
});

describe("release.yml npm job pins the npm it publishes with", () => {
	const pin = npmJob.match(/npm install -g npm@(\d+)\.(\d+)\.(\d+)/);

	test("npm is upgraded to an exact version (no range, no dist-tag)", () => {
		const loose = npmJob.match(/npm install -g npm@(\S+)/);
		const spec = loose ? loose[1]! : "(none)";
		if (!pin) {
			throw new Error(
				`expected "npm install -g npm@<x.y.z>" in the npm job, got "${spec}". ` +
					`Trusted publishing needs npm >= 11.5.1 and the npm bundled with our ` +
					`Node build is older. Keep the version fully pinned: a range or a ` +
					`dist-tag makes the published artifact depend on whatever npm was ` +
					`current that day.`,
			);
		}
		expect(spec).toBe(`${pin[1]}.${pin[2]}.${pin[3]}`);
	});

	test("the pinned npm supports trusted publishing (>= 11.5.1)", () => {
		if (!pin) throw new Error("no fully pinned npm upgrade step found");
		const have = [Number(pin[1]), Number(pin[2]), Number(pin[3])];
		let cmp = 0;
		for (let i = 0; i < have.length; i++) {
			const a = have[i] ?? 0;
			const b = MIN_TRUSTED_PUBLISHING_NPM[i] ?? 0;
			if (a !== b) {
				cmp = a - b;
				break;
			}
		}
		if (cmp < 0) {
			throw new Error(
				`npm@${have.join(".")} predates trusted publishing (needs ` +
					`${MIN_TRUSTED_PUBLISHING_NPM.join(".")})`,
			);
		}
		expect(cmp).toBeGreaterThanOrEqual(0);
	});

	test("the Node the publish runs on is the one the repo pins in .node-version", () => {
		const nodeVersion = readFileSync(
			resolve(ROOT, ".node-version"),
			"utf8",
		).trim();
		if (!npmJob.includes(`node-version: '${nodeVersion}'`)) {
			throw new Error(
				`the npm job must run on .node-version (${nodeVersion}) so all release ` +
					`jobs build on one runtime. If .node-version was raised past 22.22, npm 12 ` +
					`becomes usable and the pinned upgrade step can be revisited — do both on ` +
					`purpose, not by accident.`,
			);
		}
	});
});

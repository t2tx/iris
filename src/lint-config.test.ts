import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * Contract test for `biome.json`.
 *
 * Biome discards a biome.json that fails to *parse* and then runs on its built-in
 * defaults — silently, with exit code 0. Measured on 2.5.10: prefixing the config
 * with a line comment (comments are legal in `biome.jsonc`, not in `biome.json`)
 * made `biome check src/` report exactly the pre-config diagnostic counts again,
 * exit 0, and print nothing mentioning the config file. A *schema* problem (an
 * unknown key, or the retired `recommended: true`) does fail with exit 1, so a
 * parse error is the one way to lose the whole configuration without a signal.
 *
 * The repo carried no biome.json for a while while AGENTS.md described settings
 * that were never in effect (`quoteStyle: single`, `bracketSpacing: false`); the
 * formatter used defaults and nothing complained. These tests pin the file that is
 * now the single source of truth, so both regressions get caught:
 *
 *   1. the config stops being loaded (parse error, rename, accidental deletion),
 *   2. a Biome upgrade changes a default and would silently reformat the repo.
 */

interface BiomeConfig {
	vcs: { enabled: boolean; clientKind: string; useIgnoreFile: boolean };
	formatter: { enabled: boolean; indentStyle: string; lineWidth: number };
	json: { formatter: { indentStyle: string; indentWidth: number } };
	assist: {
		enabled: boolean;
		actions: { source: { organizeImports: string } };
	};
	javascript: {
		formatter: {
			quoteStyle: string;
			bracketSpacing: boolean;
			trailingCommas: string;
		};
	};
	linter: {
		enabled: boolean;
		rules: { preset?: string; complexity?: Record<string, string> };
	};
	overrides: {
		includes: string[];
		linter?: { rules?: { style?: Record<string, string> } };
	}[];
}

const readConfigText = () =>
	readFileSync(new URL("../biome.json", import.meta.url), "utf8");

const load = (): BiomeConfig => JSON.parse(readConfigText()) as BiomeConfig;

describe("biome.json is the config Biome actually loads", () => {
	test("parses as strict JSON (a comment makes Biome silently use defaults)", () => {
		// JSON.parse is the exact guard: it rejects the JSONC comment that Biome
		// swallows while dropping the config, and a URL inside a string value (the
		// $schema line) keeps parsing fine, so there is no false alarm here.
		expect(() => JSON.parse(readConfigText())).not.toThrow();
	});

	test("pins the formatter to the shape the source is already in", () => {
		// Every value below equals what `biome check src/` produced *before* any
		// config existed ("No fixes applied", changed: 0 for every file in src/), so
		// pinning them costs no reformatting diff and only freezes them against a
		// future default change.
		const cfg = load();
		expect(cfg.formatter.indentStyle).toBe("tab");
		expect(cfg.formatter.lineWidth).toBe(80);
		expect(cfg.javascript.formatter.quoteStyle).toBe("double");
		expect(cfg.javascript.formatter.bracketSpacing).toBe(true);
		expect(cfg.javascript.formatter.trailingCommas).toBe("all");
	});

	test("pins the JSON configs to the shape they are already in", () => {
		// The root indentStyle is tab (that is how every .ts file is formatted), and
		// Biome applies it to *.json too — which would reformat package.json,
		// tsconfig*.json and sea-config.json to tabs the moment anyone runs a check
		// that walks the repo root. Pinning space/2 matches the committed files, so
		// `biome check .` reports 0 format errors across all 64 files.
		const cfg = load();
		expect(cfg.formatter.indentStyle).toBe("tab");
		expect(cfg.json.formatter.indentStyle).toBe("space");
		expect(cfg.json.formatter.indentWidth).toBe(2);
	});

	test("keeps the import-sorting assist on (it gates `pnpm check`)", () => {
		// organizeImports reports at error level, so an unsorted import block fails
		// `pnpm check` → `pnpm verify` → CI. Turning it off would quietly remove one
		// of the only two gates that actually bite today.
		expect(load().assist.actions.source.organizeImports).toBe("on");
	});

	test("uses `preset`, never the retired `recommended` boolean", () => {
		// `rules.recommended: true` is a hard configuration error on 2.5.10
		// ("The recommended field has been deprecated … Use preset instead", exit 1).
		const rules = load().linter.rules;
		expect(rules.preset).toBe("recommended");
		expect(Object.hasOwn(rules, "recommended")).toBe(false);
	});

	test("never lets `check:fix` touch files git ignores (tokens live there)", () => {
		// .gitignore covers iris.config.toml and .env*, i.e. the Slack tokens, plus
		// dist/ and coverage/ artifacts. vcs.useIgnoreFile keeps `pnpm check:fix`
		// (biome check --write) away from all of them. Side effect worth knowing:
		// with this on, Biome exits 1 in a directory that has no ignore file at all.
		const cfg = load();
		expect(cfg.vcs.enabled).toBe(true);
		expect(cfg.vcs.clientKind).toBe("git");
		expect(cfg.vcs.useIgnoreFile).toBe(true);
	});
});

describe("biome.json records its deliberate exceptions", () => {
	test("useLiteralKeys is off for a stated reason, not by accident", () => {
		// Reading wire payloads as `raw["type"]` / `msg["method"]` is the house style:
		// 115 occurrences in src/, led by the stream-json parsers (protocol.ts 28,
		// copilot-protocol.ts 18, hermes-protocol.ts 16) and the ACP session layer
		// (hermes.ts 18, copilot-sessions.ts 8, copilot.ts 4). The rule only asks to
		// rewrite them as `raw.type`, which would churn every pure function that parses
		// agent output, and would make the field names harder to grep against the
		// protocol table in AGENTS.md. Fixing it instead is a refactor PR, not a config
		// change. Re-measure with `useLiteralKeys: "warn"` if the number looks stale.
		expect(load().linter.rules.complexity?.useLiteralKeys).toBe("off");
	});

	test("unit tests may use `!`, production code may not", () => {
		// Fixture access like `events[0]!` is the shape of most assertions here, and
		// noUncheckedIndexedAccess would otherwise force a guard per assertion (39
		// sites in tests). The carve-out is scoped to test files, so a stray `!` in a
		// production source still warns (3 of them do today, cli.ts / commands.ts).
		const tests = load().overrides.find((o) =>
			o.includes.includes("src/**/*.test.ts"),
		);
		expect(tests?.linter?.rules?.style?.noNonNullAssertion).toBe("off");
	});
});

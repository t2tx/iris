import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
	ConfigError,
	composeLaunchdPath,
	defaultConfigPath,
	loadConfig,
	resolveConfigPath,
	routeChannel,
	routeUser,
	STANDARD_PATH_DIRS,
} from "./config.js";

const baseEnv = {
	SLACK_BOT_TOKEN: "xoxb-test",
	SLACK_APP_TOKEN: "xapp-test",
} as NodeJS.ProcessEnv;

function writeToml(body: string): string {
	const dir = mkdtempSync(join(tmpdir(), "iris-cfg-"));
	const path = join(dir, "iris.config.toml");
	writeFileSync(path, body);
	return path;
}

test("TOML without [[projects]] throws ConfigError", () => {
	const path = writeToml(`
[slack]
bot_token = "xoxb-x"
app_token = "xapp-x"
`);
	expect(() => loadConfig({ path, env: {} })).toThrow(ConfigError);
});

test("env tokens override the TOML [slack] block", () => {
	const path = writeToml(`
[slack]
bot_token = "xoxb-from-toml"
app_token = "xapp-from-toml"

[[projects]]
name = "p"
work_dir = "/w"
`);
	const cfg = loadConfig({
		path,
		env: { SLACK_BOT_TOKEN: "xoxb-from-env", SLACK_APP_TOKEN: "xapp-from-env" },
	});
	expect(cfg.botToken).toBe("xoxb-from-env");
	expect(cfg.appToken).toBe("xapp-from-env");
});

test("missing tokens throws ConfigError", () => {
	const path = writeToml(`
[[projects]]
name = "p"
work_dir = "/w"
`);
	expect(() => loadConfig({ path, env: {} })).toThrow(ConfigError);
});

test("invalid permission mode throws ConfigError", () => {
	const path = writeToml(`
permission_mode = "yolo"

[[projects]]
name = "p"
work_dir = "/w"
`);
	expect(() => loadConfig({ path, env: baseEnv })).toThrow(ConfigError);
});

test("TOML: multiple projects with per-project overrides", () => {
	const path = writeToml(`
permission_mode = "manual"

[[projects]]
name = "work"
work_dir = "/Users/me/work"
allow_users = ["U1"]
allow_channels = ["C1"]

[[projects]]
name = "lab"
work_dir = "/Users/me/lab"
allow_users = ["U2"]
permission_mode = "acceptEdits"
`);
	const cfg = loadConfig({ path, env: baseEnv });
	expect(cfg.projects.length).toBe(2);
	expect(cfg.projects[0]!.permissionMode).toBe("manual"); // inherits default
	expect(cfg.projects[1]!.permissionMode).toBe("acceptEdits"); // overridden
});

test("agent: defaults to claude when unset", () => {
	const path = writeToml(`
[[projects]]
name = "p"
work_dir = "/w"
`);
	const cfg = loadConfig({ path, env: baseEnv });
	expect(cfg.projects[0]!.agent).toBe("claude");
});

test("agent: top-level default applies, project overrides it", () => {
	const path = writeToml(`agent = "pi"

[[projects]]
name = "a"
work_dir = "/a"

[[projects]]
name = "b"
work_dir = "/b"
agent = "claude"
`);
	const cfg = loadConfig({ path, env: baseEnv });
	expect(cfg.projects[0]!.agent).toBe("pi"); // inherits top-level
	expect(cfg.projects[1]!.agent).toBe("claude"); // overridden
});

test("agent: accepts pi", () => {
	const path = writeToml(`agent = "pi"

[[projects]]
name = "p"
work_dir = "/w"
`);
	expect(loadConfig({ path, env: baseEnv }).projects[0]!.agent).toBe("pi");
});

test("pi_bin: defaults to pi, TOML sets it", () => {
	const base = writeToml(`[[projects]]
name = "p"
work_dir = "/w"
`);
	expect(loadConfig({ path: base, env: baseEnv }).piBin).toBe("pi");

	const custom = writeToml(`pi_bin = "pi-cli"
[[projects]]
name = "p"
work_dir = "/w"
`);
	expect(loadConfig({ path: custom, env: baseEnv }).piBin).toBe("pi-cli");
});

test("invalid top-level agent throws ConfigError", () => {
	const path = writeToml(`agent = "yolo"

[[projects]]
name = "p"
work_dir = "/w"
`);
	expect(() => loadConfig({ path, env: baseEnv })).toThrow(ConfigError);
});

test("invalid per-project agent throws ConfigError", () => {
	const path = writeToml(`[[projects]]
name = "p"
work_dir = "/w"
agent = "yolo"
`);
	expect(() => loadConfig({ path, env: baseEnv })).toThrow(ConfigError);
});

test("TOML: env tokens fill in when [slack] omitted", () => {
	const path = writeToml(`
[[projects]]
name = "work"
work_dir = "/w"
`);
	const cfg = loadConfig({ path, env: baseEnv });
	expect(cfg.botToken).toBe("xoxb-test");
	expect(cfg.appToken).toBe("xapp-test");
});

test("log_level: defaults to info, accepts valid, rejects invalid", () => {
	const base = writeToml(`
[[projects]]
name = "p"
work_dir = "/w"
`);
	expect(loadConfig({ path: base, env: baseEnv }).logLevel).toBe("info");

	const debug = writeToml(`
log_level = "debug"
[[projects]]
name = "p"
work_dir = "/w"
`);
	expect(loadConfig({ path: debug, env: baseEnv }).logLevel).toBe("debug");

	const bad = writeToml(`
log_level = "loud"
[[projects]]
name = "p"
work_dir = "/w"
`);
	expect(() => loadConfig({ path: bad, env: baseEnv })).toThrow(ConfigError);
});

test("bash_progress_max: defaults to 800, accepts a positive int, rejects invalid", () => {
	const base = writeToml(`
[[projects]]
name = "p"
work_dir = "/w"
`);
	expect(loadConfig({ path: base, env: baseEnv }).bashProgressMax).toBe(800);

	const custom = writeToml(`
bash_progress_max = 2000
[[projects]]
name = "p"
work_dir = "/w"
`);
	expect(loadConfig({ path: custom, env: baseEnv }).bashProgressMax).toBe(2000);

	const bad = writeToml(`
bash_progress_max = 0
[[projects]]
name = "p"
work_dir = "/w"
`);
	expect(() => loadConfig({ path: bad, env: baseEnv })).toThrow(ConfigError);
});

test("idle_ttl_min: defaults to 24h, TOML sets it, 0 disables", () => {
	const base = writeToml(`
[[projects]]
name = "p"
work_dir = "/w"
`);
	expect(loadConfig({ path: base, env: baseEnv }).idleTtlMs).toBe(
		24 * 60 * 60_000,
	);

	const custom = writeToml(`
idle_ttl_min = 30
[[projects]]
name = "p"
work_dir = "/w"
`);
	expect(loadConfig({ path: custom, env: baseEnv }).idleTtlMs).toBe(
		30 * 60_000,
	);

	const off = writeToml(`
idle_ttl_min = 0
[[projects]]
name = "p"
work_dir = "/w"
`);
	expect(loadConfig({ path: off, env: baseEnv }).idleTtlMs).toBe(0);

	const bad = writeToml(`
idle_ttl_min = -5
[[projects]]
name = "p"
work_dir = "/w"
`);
	expect(() => loadConfig({ path: bad, env: baseEnv })).toThrow(ConfigError);
});

test("IRIS_IDLE_TTL_MIN env overrides TOML idle_ttl_min", () => {
	const path = writeToml(`
idle_ttl_min = 30
[[projects]]
name = "p"
work_dir = "/w"
`);
	const env = { ...baseEnv, IRIS_IDLE_TTL_MIN: "90" };
	expect(loadConfig({ path, env }).idleTtlMs).toBe(90 * 60_000);

	// A non-integer / negative env value is rejected.
	expect(() =>
		loadConfig({ path, env: { ...baseEnv, IRIS_IDLE_TTL_MIN: "x" } }),
	).toThrow(ConfigError);
});

test("TOML: project without work_dir throws", () => {
	const path = writeToml(`
[[projects]]
name = "bad"
`);
	expect(() => loadConfig({ path, env: baseEnv })).toThrow(ConfigError);
});

test("routing: channel + user AND-match; DM by user", () => {
	const path = writeToml(`
[[projects]]
name = "work"
work_dir = "/w"
allow_channels = ["C1"]
allow_users = ["U1"]

[[projects]]
name = "lab"
work_dir = "/l"
allow_channels = ["C2"]
allow_users = ["U2"]
`);
	const cfg = loadConfig({ path, env: baseEnv });
	// Channel allowed AND user allowed → match.
	expect(routeChannel(cfg, "C2", "U2")?.name).toBe("lab");
	// Channel allowed but user NOT in that project's allow_users → no match.
	expect(routeChannel(cfg, "C2", "U1")).toBe(undefined);
	// Channel restricts users, but no user passed → no match.
	expect(routeChannel(cfg, "C2")).toBe(undefined);
	expect(routeChannel(cfg, "C9", "U2")).toBe(undefined); // channel not allowed
	expect(routeUser(cfg, "U1")?.name).toBe("work");
	expect(routeUser(cfg, undefined)).toBe(undefined);
});

test('routing: empty allow_users keeps "any user in allowed channel"', () => {
	const path = writeToml(`
[[projects]]
name = "shared"
work_dir = "/s"
allow_channels = ["C1"]
`);
	const cfg = loadConfig({ path, env: baseEnv });
	// No allow_users → any sender in the channel matches (legacy behavior).
	expect(routeChannel(cfg, "C1", "Uanyone")?.name).toBe("shared");
	expect(routeChannel(cfg, "C1")?.name).toBe("shared");
});

test("routing: multi-bot — each bot answers only its owner in a shared channel", () => {
	// Two separate Iris hosts (iris-a / iris-b), each with its own config but
	// both joined to the same shared channel C1. iris-b only knows UserB.
	const irisB = loadConfig({
		path: writeToml(`
[[projects]]
name = "b"
work_dir = "/b"
allow_channels = ["C1"]
allow_users = ["UserB"]
`),
		env: baseEnv,
	});
	// UserA mentions iris-b in the shared channel → iris-b ignores it.
	expect(routeChannel(irisB, "C1", "UserA")).toBe(undefined);
	// UserB mentions iris-b → answered.
	expect(routeChannel(irisB, "C1", "UserB")?.name).toBe("b");
});

test("defaultConfigPath is ~/.iris-slack/config.toml", () => {
	expect(defaultConfigPath("/home/me")).toBe(
		"/home/me/.iris-slack/config.toml",
	);
});

test("resolveConfigPath: IRIS_CONFIG takes precedence", () => {
	expect(resolveConfigPath({ IRIS_CONFIG: "/custom/path.toml" })).toBe(
		"/custom/path.toml",
	);
});

test("resolveConfigPath: undefined when neither cwd nor home has a config", () => {
	// Inject empty cwd + home so the result is deterministic (no real-FS deps).
	const emptyCwd = mkdtempSync(join(tmpdir(), "iris-cwd-"));
	const emptyHome = mkdtempSync(join(tmpdir(), "iris-home-"));
	const got = resolveConfigPath({}, { cwd: emptyCwd, home: emptyHome });
	expect(got).toBe(undefined);
});

test("resolveConfigPath: finds repo-local ./iris.config.toml first", () => {
	const cwd = mkdtempSync(join(tmpdir(), "iris-cwd-"));
	const home = mkdtempSync(join(tmpdir(), "iris-home-"));
	writeFileSync(join(cwd, "iris.config.toml"), "");
	expect(resolveConfigPath({}, { cwd, home })).toBe(
		join(cwd, "iris.config.toml"),
	);
});

// ── composeLaunchdPath ────────────────────────────────────────────────────────
// The bug under test: an installed (launchd) Iris service runs with a restricted
// PATH, so `spawn("claude")` / `spawn("pi")` ENOENTs when the agent CLI lives in
// a user-managed bin dir (nodenv / homebrew / ~/.local/bin / …). `iris install`
// runs from the user's interactive shell, so we forward that shell's PATH.

test("composeLaunchdPath forwards the inherited shell PATH (the fix)", () => {
	// A version-manager dir like nodenv is where claude/pi live; a minimal
	// hardcoded PATH would drop it and spawn would ENOENT.
	const path = composeLaunchdPath(
		"/opt/homebrew/bin",
		"/Users/me/.anyenv/envs/nodenv/versions/24.20.0/bin:/opt/homebrew/bin",
	);
	expect(path).toContain("/Users/me/.anyenv/envs/nodenv/versions/24.20.0/bin");
	expect(path).toContain("/usr/bin");
});

test("composeLaunchdPath always includes the standard dirs first", () => {
	const path = composeLaunchdPath("/opt/homebrew/bin", "");
	const entries = path.split(":");
	// The standard set leads the PATH, in declared order.
	expect(entries.slice(0, STANDARD_PATH_DIRS.length)).toEqual([
		...STANDARD_PATH_DIRS,
	]);
});

test("composeLaunchdPath de-duplicates entries (first occurrence wins)", () => {
	const path = composeLaunchdPath("/opt/homebrew/bin", "/opt/homebrew/bin");
	const homebrew = path.match(/\/opt\/homebrew\/bin/g) ?? [];
	expect(homebrew.length).toBe(1);
});

test("composeLaunchdPath tolerates undefined inherited PATH", () => {
	expect(() => composeLaunchdPath("/x", undefined)).not.toThrow();
	expect(composeLaunchdPath("/x")).toContain("/x");
});

test("composeLaunchdPath places an extra binDir after the standard dirs", () => {
	const path = composeLaunchdPath("/custom/bin");
	const entries = path.split(":");
	expect(entries[STANDARD_PATH_DIRS.length]).toBe("/custom/bin");
});

test("composeLaunchdPath drops empty segments (trailing/leading/double colons)", () => {
	const path = composeLaunchdPath("", ":/opt/homebrew/bin::/usr/bin:");
	expect(path.split(":")).not.toContain("");
	// the inherited entries collapse into the standard set, no empties
	expect(path.startsWith(":")).toBe(false);
	expect(path.endsWith(":")).toBe(false);
	expect(path).not.toContain("::");
});

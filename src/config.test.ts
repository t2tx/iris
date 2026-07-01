import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  loadConfig,
  routeChannel,
  routeUser,
  resolveConfigPath,
  defaultConfigPath,
  ConfigError,
} from './config.js';

const baseEnv = {
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_APP_TOKEN: 'xapp-test',
} as NodeJS.ProcessEnv;

function writeToml(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-cfg-'));
  const path = join(dir, 'iris.config.toml');
  writeFileSync(path, body);
  return path;
}

test('TOML without [[projects]] throws ConfigError', () => {
  const path = writeToml(`
[slack]
bot_token = "xoxb-x"
app_token = "xapp-x"
`);
  assert.throws(() => loadConfig({path, env: {}}), ConfigError);
});

test('env tokens override the TOML [slack] block', () => {
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
    env: {SLACK_BOT_TOKEN: 'xoxb-from-env', SLACK_APP_TOKEN: 'xapp-from-env'},
  });
  assert.equal(cfg.botToken, 'xoxb-from-env');
  assert.equal(cfg.appToken, 'xapp-from-env');
});

test('missing tokens throws ConfigError', () => {
  const path = writeToml(`
[[projects]]
name = "p"
work_dir = "/w"
`);
  assert.throws(() => loadConfig({path, env: {}}), ConfigError);
});

test('invalid permission mode throws ConfigError', () => {
  const path = writeToml(`
permission_mode = "yolo"

[[projects]]
name = "p"
work_dir = "/w"
`);
  assert.throws(() => loadConfig({path, env: baseEnv}), ConfigError);
});

test('TOML: multiple projects with per-project overrides', () => {
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
  const cfg = loadConfig({path, env: baseEnv});
  assert.equal(cfg.projects.length, 2);
  assert.equal(cfg.projects[0]!.permissionMode, 'manual'); // inherits default
  assert.equal(cfg.projects[1]!.permissionMode, 'acceptEdits'); // overridden
});

test('TOML: env tokens fill in when [slack] omitted', () => {
  const path = writeToml(`
[[projects]]
name = "work"
work_dir = "/w"
`);
  const cfg = loadConfig({path, env: baseEnv});
  assert.equal(cfg.botToken, 'xoxb-test');
  assert.equal(cfg.appToken, 'xapp-test');
});

test('log_level: defaults to info, accepts valid, rejects invalid', () => {
  const base = writeToml(`
[[projects]]
name = "p"
work_dir = "/w"
`);
  assert.equal(loadConfig({path: base, env: baseEnv}).logLevel, 'info');

  const debug = writeToml(`
log_level = "debug"
[[projects]]
name = "p"
work_dir = "/w"
`);
  assert.equal(loadConfig({path: debug, env: baseEnv}).logLevel, 'debug');

  const bad = writeToml(`
log_level = "loud"
[[projects]]
name = "p"
work_dir = "/w"
`);
  assert.throws(() => loadConfig({path: bad, env: baseEnv}), ConfigError);
});

test('bash_progress_max: defaults to 800, accepts a positive int, rejects invalid', () => {
  const base = writeToml(`
[[projects]]
name = "p"
work_dir = "/w"
`);
  assert.equal(loadConfig({path: base, env: baseEnv}).bashProgressMax, 800);

  const custom = writeToml(`
bash_progress_max = 2000
[[projects]]
name = "p"
work_dir = "/w"
`);
  assert.equal(loadConfig({path: custom, env: baseEnv}).bashProgressMax, 2000);

  const bad = writeToml(`
bash_progress_max = 0
[[projects]]
name = "p"
work_dir = "/w"
`);
  assert.throws(() => loadConfig({path: bad, env: baseEnv}), ConfigError);
});

test('TOML: project without work_dir throws', () => {
  const path = writeToml(`
[[projects]]
name = "bad"
`);
  assert.throws(() => loadConfig({path, env: baseEnv}), ConfigError);
});

test('routing: channel + user AND-match; DM by user', () => {
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
  const cfg = loadConfig({path, env: baseEnv});
  // Channel allowed AND user allowed → match.
  assert.equal(routeChannel(cfg, 'C2', 'U2')?.name, 'lab');
  // Channel allowed but user NOT in that project's allow_users → no match.
  assert.equal(routeChannel(cfg, 'C2', 'U1'), undefined);
  // Channel restricts users, but no user passed → no match.
  assert.equal(routeChannel(cfg, 'C2'), undefined);
  assert.equal(routeChannel(cfg, 'C9', 'U2'), undefined); // channel not allowed
  assert.equal(routeUser(cfg, 'U1')?.name, 'work');
  assert.equal(routeUser(cfg, undefined), undefined);
});

test('routing: empty allow_users keeps "any user in allowed channel"', () => {
  const path = writeToml(`
[[projects]]
name = "shared"
work_dir = "/s"
allow_channels = ["C1"]
`);
  const cfg = loadConfig({path, env: baseEnv});
  // No allow_users → any sender in the channel matches (legacy behavior).
  assert.equal(routeChannel(cfg, 'C1', 'Uanyone')?.name, 'shared');
  assert.equal(routeChannel(cfg, 'C1')?.name, 'shared');
});

test('routing: multi-bot — each bot answers only its owner in a shared channel', () => {
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
  assert.equal(routeChannel(irisB, 'C1', 'UserA'), undefined);
  // UserB mentions iris-b → answered.
  assert.equal(routeChannel(irisB, 'C1', 'UserB')?.name, 'b');
});

test('defaultConfigPath is ~/.iris-slack/config.toml', () => {
  assert.equal(
    defaultConfigPath('/home/me'),
    '/home/me/.iris-slack/config.toml',
  );
});

test('resolveConfigPath: IRIS_CONFIG takes precedence', () => {
  assert.equal(
    resolveConfigPath({IRIS_CONFIG: '/custom/path.toml'}),
    '/custom/path.toml',
  );
});

test('resolveConfigPath: undefined when neither cwd nor home has a config', () => {
  // Inject empty cwd + home so the result is deterministic (no real-FS deps).
  const emptyCwd = mkdtempSync(join(tmpdir(), 'iris-cwd-'));
  const emptyHome = mkdtempSync(join(tmpdir(), 'iris-home-'));
  const got = resolveConfigPath({}, {cwd: emptyCwd, home: emptyHome});
  assert.equal(got, undefined);
});

test('resolveConfigPath: finds repo-local ./iris.config.toml first', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'iris-cwd-'));
  const home = mkdtempSync(join(tmpdir(), 'iris-home-'));
  writeFileSync(join(cwd, 'iris.config.toml'), '');
  assert.equal(
    resolveConfigPath({}, {cwd, home}),
    join(cwd, 'iris.config.toml'),
  );
});

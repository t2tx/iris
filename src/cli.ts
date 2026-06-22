#!/usr/bin/env node
/**
 * cli.ts — Iris CLI entry point.
 *
 * Subcommands:
 *   (none)        Start the Iris bridge (default)
 *   init          Write a starter config to ~/.iris-slack/config.toml
 *   config check  Validate the resolved config without starting
 *   config path   Print which config file would be used
 *   install       Generate a launchd plist and load it
 *   uninstall     Unload and remove the launchd plist
 *   status        Show launchd service status
 */

import {resolve, dirname} from 'node:path';
import {
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {createRequire} from 'node:module';
import {
  defaultConfigPath,
  resolveConfigPath,
  loadConfig,
  ConfigError,
} from './config.js';

const LABEL = 'com.t2tx.iris';
const PLIST_DIR = resolve(homedir(), 'Library/LaunchAgents');
const PLIST_PATH = resolve(PLIST_DIR, `${LABEL}.plist`);
const LOG_DIR = resolve(homedir(), 'Library/Logs/iris');

/** True when running as a Node Single Executable Application (SEA) binary. */
function isSea(): boolean {
  try {
    // node:sea is a builtin (Node 20+); resolve it via process.execPath so this
    // works even in the SEA bundle where import.meta.url is unavailable.
    const sea = createRequire(process.execPath)('node:sea') as {
      isSea(): boolean;
    };
    return sea.isSea() === true;
  } catch {
    return false;
  }
}

function uid(): number {
  const id = process.getuid?.();
  if (id === undefined) {
    console.error('launchd is only supported on macOS/Linux.');
    process.exit(1);
  }
  return id;
}

// Subcommand dispatch table. Keeping this a map (rather than a big switch)
// holds main()'s complexity flat as commands are added.
const COMMANDS: Record<string, () => void> = {
  init,
  config: configCmd,
  install,
  uninstall,
  status,
  start: () => void startBridge(),
  '--help': help,
  '-h': help,
  '--version': version,
  '-v': version,
};

function main() {
  const sub = process.argv[2] ?? 'start';
  const handler = COMMANDS[sub];
  if (!handler) {
    console.error(`Unknown command: ${sub}\n`);
    help();
    process.exit(1);
  }
  handler();
}

// Build-time version. The SEA build injects this via esbuild --define; when
// running from source/dist it stays undefined and we read package.json.
declare const __IRIS_VERSION__: string | undefined;

/** Print the package version. */
function version() {
  // SEA binary: use the injected constant (package.json isn't bundled).
  if (typeof __IRIS_VERSION__ === 'string' && __IRIS_VERSION__) {
    console.log(__IRIS_VERSION__);
    return;
  }
  try {
    const pkgPath = resolve(
      dirname(new URL(import.meta.url).pathname),
      '..',
      'package.json',
    );
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {version?: string};
    console.log(pkg.version ?? 'unknown');
  } catch {
    console.log('unknown');
  }
}

function help() {
  console.log(`Iris — Slack ⇄ Claude Code bridge

Usage: iris [command]

Commands:
  (none), start   Start the bridge (foreground)
  init            Write a starter config (then fill in your Slack tokens)
  config check    Validate the resolved config without starting
  config path     Print which config file would be used
  install         Install as a launchd service (macOS)
  uninstall       Remove the launchd service
  status          Show launchd service status
  --version, -v   Show version
  --help, -h      Show this help

Options for init / install:
  --config <path>   Path to the TOML config (default: ~/.iris-slack/config.toml)
`);
}

/**
 * Starter config written by `iris init`. Kept in sync with
 * iris.config.example.toml. Embedded as a string so it also works from the
 * standalone SEA binary, which does not bundle the example file.
 */
const CONFIG_TEMPLATE = `# Iris 設定ファイル（TOML）。
#
# 配置場所（このいずれか。上から順に探索される）:
#   1. 環境変数 IRIS_CONFIG=<path> で指定したパス
#   2. ./iris.config.toml             … 開発（リポジトリ内）
#   3. ~/.iris-slack/config.toml      … 本番（インストール後）
#
# このファイルはトークンを含みます。他人に読まれないよう保護してください
# （例: chmod 600）。リポジトリにはコミットしないこと（gitignore 済み）。

# 全プロジェクト共通のデフォルト（各プロジェクトで上書き可）。
# TOML の仕様上、これらトップレベルのキーは [slack] や [[projects]] などの
# テーブル見出しより「前」に書く必要があります（後ろに書くとそのテーブルの
# 中のキーと解釈され、効きません）。
claude_bin = "claude"          # claude CLI のパス（PATH にあれば claude のままで可）
permission_mode = "manual"     # manual（毎回確認）| acceptEdits | auto（全自動）
log_level = "info"             # debug | info | warn | error（既定 info）
# model = ""                   # 空 = CLI 既定

[slack]
bot_token = "xoxb-..."        # Bot User OAuth Token
app_token = "xapp-..."        # App-Level Token（Socket Mode 用、connections:write）

# プロジェクトごとに work_dir・許可リスト・権限モードを割り当てる。
# 受信メッセージは allow_channels（チャンネル）/ allow_users（DM）で照合され、
# 最初にマッチしたプロジェクトが使われる。どれにもマッチしなければ無視（default-deny）。

[[projects]]
name = "default"
work_dir = "/path/to/your/repo"    # Claude が作業するディレクトリ
allow_channels = ["C0123ABCDEF"]   # このチャンネルでの @mention / スレッド
allow_users = ["U09XXXXXXX"]       # このユーザーからの DM

# 例: もう 1 プロジェクト（別ディレクトリ・別権限）を足す場合
# [[projects]]
# name = "lab"
# work_dir = "/path/to/another/repo"
# allow_users = ["U09XXXXXXX"]
# permission_mode = "acceptEdits"  # 編集系は自動許可（個別上書き）
`;

/**
 * iris init — write a starter config so users don't have to create it by hand.
 * Never overwrites an existing file. The file is created 0600 (it will hold
 * Slack tokens). Honors --config / IRIS_CONFIG; defaults to ~/.iris-slack/.
 */
function init() {
  const configPath = resolveConfigArg();

  mkdirSync(dirname(configPath), {recursive: true});
  // 'wx' = exclusive create: fails atomically if the file already exists, so
  // the never-overwrite guarantee holds even against a concurrent creator
  // (no TOCTOU gap between an existsSync check and the write).
  try {
    writeFileSync(configPath, CONFIG_TEMPLATE, {mode: 0o600, flag: 'wx'});
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      console.error(`Config already exists: ${configPath}`);
      console.error(
        'Edit it directly, or pass --config <path> to write elsewhere.',
      );
      process.exit(1);
    }
    throw err;
  }
  console.log(`Wrote starter config: ${configPath}`);
  console.log(
    'Next: open it and fill in your Slack tokens ([slack] bot_token / app_token)\n' +
      'and at least one [[projects]] (work_dir + allow_channels / allow_users).\n' +
      'Then run "iris" (foreground) or "iris install" (launchd, macOS).',
  );
}

/**
 * Resolve the config path the way the running bridge would: an explicit
 * --config wins, otherwise the env/cwd/home search (resolveConfigPath, which
 * only returns a path that exists). Returns undefined when nothing is found.
 */
function resolveConfigForInspect(): string | undefined {
  const idx = process.argv.indexOf('--config');
  if (idx !== -1) {
    // --config was given — it must carry a path; don't silently auto-resolve.
    const val = process.argv[idx + 1];
    if (!val || val.startsWith('-')) {
      console.error('--config requires a path argument.');
      process.exit(1);
    }
    return resolve(val);
  }
  return resolveConfigPath();
}

/** iris config <check|path> — inspect config without starting the bridge. */
function configCmd() {
  const action = process.argv[3];
  if (action === 'path') return configPath();
  if (action === 'check') return configCheck();
  console.error('Usage: iris config <check|path> [--config <path>]');
  process.exit(1);
}

/** Print which config file the bridge would use (or report none found). */
function configPath() {
  const path = resolveConfigForInspect();
  if (!path) {
    console.error('No config found.');
    console.error(
      `Searched: $IRIS_CONFIG, ./iris.config.toml, ${defaultConfigPath()}`,
    );
    console.error('Run "iris init" to create one.');
    process.exit(1);
  }
  console.log(path);
}

/** Validate the resolved config without starting the bridge. */
function configCheck() {
  const path = resolveConfigForInspect();
  if (!path || !existsSync(path)) {
    console.error(`No config found${path ? `: ${path}` : ''}.`);
    console.error('Run "iris init" to create one.');
    process.exit(1);
  }
  try {
    const config = loadConfig({path});
    console.log(`OK: ${path}`);
    console.log(`  projects: ${config.projects.length}`);
    for (const p of config.projects) {
      console.log(
        `   • ${p.name} (${p.permissionMode}) workDir=${p.workDir} ` +
          `channels=${p.allowChannels.length} users=${p.allowUsers.length}`,
      );
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Config error in ${path}:\n  ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

function install() {
  const configPath = resolveConfigArg();

  // Validate config file exists and is readable
  if (!existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    console.error(
      `Create it first (see README), or pass --config <path>.\n` +
        `Default location: ${defaultConfigPath()}`,
    );
    process.exit(1);
  }

  // Resolve how launchd should run Iris.
  // - SEA binary: run the binary itself (process.execPath).
  // - Node + script: run `node <cli.js>`.
  let programArgs: string[];
  if (isSea()) {
    programArgs = [process.execPath];
  } else {
    const irisBin = resolve(
      dirname(new URL(import.meta.url).pathname),
      'cli.js',
    );
    if (!existsSync(irisBin)) {
      console.error(`Cannot find iris CLI: ${irisBin}`);
      console.error('Run "pnpm build" first, or install via npm.');
      process.exit(1);
    }
    programArgs = [process.execPath, irisBin];
  }

  // Kill all existing Iris processes to avoid zombie Socket Mode connections
  killAllIrisProcesses();

  // Ensure log directory exists
  mkdirSync(LOG_DIR, {recursive: true});

  const plist = buildPlist(programArgs, configPath);

  // Write plist
  mkdirSync(PLIST_DIR, {recursive: true});
  writeFileSync(PLIST_PATH, plist, 'utf8');
  console.log(`Plist written: ${PLIST_PATH}`);

  // Load the service
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid()}`, PLIST_PATH], {
      stdio: 'ignore',
    });
  } catch {
    /* not loaded yet — fine */
  }
  execFileSync('launchctl', ['bootstrap', `gui/${uid()}`, PLIST_PATH]);
  console.log(`Service loaded: ${LABEL}`);
  console.log(`Logs: ${LOG_DIR}/`);
  console.log('\nIris is now running and will start automatically on login.');
}

function uninstall() {
  if (!existsSync(PLIST_PATH)) {
    console.log('Iris is not installed (no plist found).');
  } else {
    try {
      execFileSync('launchctl', ['bootout', `gui/${uid()}`, PLIST_PATH]);
      console.log(`Service unloaded: ${LABEL}`);
    } catch {
      console.log('Service was not running.');
    }
    unlinkSync(PLIST_PATH);
    console.log(`Plist removed: ${PLIST_PATH}`);
  }

  // Kill all remaining Iris processes to close Socket Mode connections
  killAllIrisProcesses();
}

function status() {
  if (!existsSync(PLIST_PATH)) {
    console.log('Iris is not installed (no plist found).');
    return;
  }

  try {
    // launchctl print emits service details on stdout; if the service is not
    // loaded it exits non-zero and we fall through to the catch below.
    const output = execFileSync(
      'launchctl',
      ['print', `gui/${uid()}/${LABEL}`],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']},
    );
    // Extract key info
    const stateMatch = output.match(/state = (.+)/);
    const pidMatch = output.match(/pid = (\d+)/);
    const lastExitMatch = output.match(/last exit code = (\d+)/);

    console.log(`Service: ${LABEL}`);
    console.log(`Plist:   ${PLIST_PATH}`);
    console.log(`State:   ${stateMatch?.[1] ?? 'unknown'}`);
    if (pidMatch) console.log(`PID:     ${pidMatch[1]}`);
    if (lastExitMatch) console.log(`Last exit: ${lastExitMatch[1]}`);
    console.log(`Logs:    ${LOG_DIR}/`);

    // Show config path from plist
    try {
      const plistContent = readFileSync(PLIST_PATH, 'utf8');
      const configMatch = plistContent.match(
        /<key>IRIS_CONFIG<\/key>\s*<string>([^<]+)<\/string>/,
      );
      if (configMatch) console.log(`Config:  ${configMatch[1]}`);
    } catch {
      /* ignore */
    }
  } catch {
    console.log(`Service ${LABEL} is installed but not currently loaded.`);
  }
}

function killAllIrisProcesses() {
  const myPid = process.pid;
  try {
    // Enumerate processes without a shell, then match in JS (replaces the
    // former `ps | grep` pipeline — no shell, no injection surface).
    const output = execFileSync('ps', ['-eo', 'pid=,command='], {
      encoding: 'utf8',
    });
    const pids = output
      .trim()
      .split('\n')
      .filter(
        (line) =>
          /iris\/dist\/cli\.js|iris\/dist\/index\.js/.test(line) &&
          !line.includes('grep'),
      )
      .map((line) => parseInt(line.trim(), 10))
      .filter((pid) => !isNaN(pid) && pid !== myPid);
    if (pids.length > 0) {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* already gone */
        }
      }
      console.log(
        `Killed ${pids.length} existing Iris process(es): ${pids.join(', ')}`,
      );
      // Wait for processes to exit and release Socket Mode connections.
      // Synchronous sleep without spawning a shell.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
    }
  } catch {
    /* no matching processes — fine */
  }
}

async function startBridge() {
  // Dynamic import so the CLI subcommands don't need Slack/Bolt deps loaded
  await import('./index.js');
}

function resolveConfigArg(): string {
  const idx = process.argv.indexOf('--config');
  // --config is optional; default to the product config path.
  if (idx === -1 || !process.argv[idx + 1]) {
    return defaultConfigPath();
  }
  return resolve(process.argv[idx + 1]!);
}

function buildPlist(programArgs: string[], configPath: string): string {
  const argsXml = programArgs
    .map((a) => `    <string>${a}</string>`)
    .join('\n');
  const binDir = dirname(programArgs[0]!);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>IRIS_CONFIG</key>
    <string>${configPath}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:${binDir}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/iris.stdout.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/iris.stderr.log</string>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

main();

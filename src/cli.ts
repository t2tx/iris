#!/usr/bin/env node
/**
 * cli.ts — Iris CLI entry point.
 *
 * Subcommands:
 *   (none)      Start the Iris bridge (default)
 *   install     Generate a launchd plist and load it
 *   uninstall   Unload and remove the launchd plist
 *   status      Show launchd service status
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
import {defaultConfigPath} from './config.js';

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

function main() {
  const sub = process.argv[2];
  switch (sub) {
    case 'install':
      return install();
    case 'uninstall':
      return uninstall();
    case 'status':
      return status();
    case undefined:
    case 'start':
      void startBridge();
      return;
    case '--help':
    case '-h':
      return help();
    case '--version':
    case '-v':
      return version();
    default:
      console.error(`Unknown command: ${sub}\n`);
      help();
      process.exit(1);
  }
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
  install         Install as a launchd service (macOS)
  uninstall       Remove the launchd service
  status          Show launchd service status
  --version, -v   Show version
  --help, -h      Show this help

Options for install:
  --config <path>   Path to the TOML config (default: ~/.iris-slack/config.toml)
`);
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

/**
 * commands.ts — Iris slash commands.
 *
 * Messages starting with "/" are intercepted before reaching Claude.
 * Returns the response text, or null if the message is not a command.
 */

import {readdirSync} from 'node:fs';
import {join, basename} from 'node:path';
import type {SessionManager} from './session.js';

export interface CommandContext {
  sessionKey: string;
  manager: SessionManager;
  allManagers: Map<string, SessionManager>;
  projectName: string;
  baseWorkDir: string;
}

export interface CommandResult {
  text: string;
}

type CommandHandler = (arg: string, ctx: CommandContext) => CommandResult;

const COMMANDS: Record<string, CommandHandler> = {
  help: () => cmdHelp(),
  status: (_a, ctx) => cmdStatus(ctx),
  sessions: (_a, ctx) => cmdSessions(ctx),
  restart: (_a, ctx) => cmdRestart(ctx),
  clear: (_a, ctx) => cmdClear(ctx),
  new: (_a, ctx) => cmdClear(ctx),
  switch: (arg, ctx) => cmdSwitch(arg, ctx),
};

/**
 * Try to handle a slash command. Returns null if the message is not a command.
 */
export function handleCommand(
  message: string,
  ctx: CommandContext,
): CommandResult | null {
  const trimmed = message.trim();
  // In Slack DMs, users must prepend a space before "/" to bypass Slack's
  // native slash command interception. The trim() above strips that space.
  if (!trimmed.startsWith('/')) return null;

  const spaceIdx = trimmed.indexOf(' ');
  const raw = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const arg = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  const name = raw.slice(1).toLowerCase();

  const handler = COMMANDS[name];
  if (handler) return handler(arg, ctx);

  // A bare "/word" (single token, no spaces) that matches no command is
  // almost certainly a typo — report it instead of forwarding to Claude.
  // Anything with spaces (e.g. "/path/to/file を説明して") is treated as a
  // normal prompt and passed through.
  if (raw === trimmed) {
    return {text: `_Unknown command: \`${raw}\`. Try \`/help\`._`};
  }
  return null; // pass through to Claude
}

function cmdHelp(): CommandResult {
  return {
    text: [
      '*Iris commands* (in DM, prepend a space before `/`)',
      '`/help` — Show this help',
      '`/status` — Current session info',
      '`/sessions` — All active sessions',
      '`/restart` — Restart the Claude process, keeping the conversation (resume)',
      '`/clear` — Reset the conversation (new session, no history; alias `/new`)',
      '`/switch <name>` — Switch working directory (searches under base work_dir)',
      '`/switch` — Show current working directory',
      '`/switch -` — Revert to default working directory',
    ].join('\n'),
  };
}

function cmdStatus(ctx: CommandContext): CommandResult {
  const info = ctx.manager.getSessionInfo(ctx.sessionKey);
  if (!info) {
    return {text: '_No active session in this thread._'};
  }
  const lines = [
    `*Session status* (project: ${ctx.projectName})`,
    `PID: ${info.pid ?? 'n/a'}`,
    `Session ID: \`${info.sessionId || 'n/a'}\``,
    `Alive: ${info.alive ? 'yes' : 'no'}`,
  ];
  return {text: lines.join('\n')};
}

function cmdSessions(ctx: CommandContext): CommandResult {
  const lines: string[] = ['*Active sessions*'];
  let total = 0;

  for (const [projectName, manager] of ctx.allManagers) {
    const sessions = manager.listSessions();
    for (const s of sessions) {
      total++;
      const status = s.alive ? ':green_circle:' : ':red_circle:';
      lines.push(
        `${status} \`${s.sessionKey}\` (${projectName}) pid=${s.pid ?? 'n/a'}`,
      );
    }
  }

  if (total === 0) {
    return {text: '_No active sessions._'};
  }
  return {text: lines.join('\n')};
}

function cmdRestart(ctx: CommandContext): CommandResult {
  const killed = ctx.manager.killSession(ctx.sessionKey);
  if (killed) {
    return {
      text: ':arrows_counterclockwise: Process restarted. The conversation resumes on your next message.',
    };
  }
  return {text: '_No active session to restart._'};
}

function cmdClear(ctx: CommandContext): CommandResult {
  ctx.manager.clearSession(ctx.sessionKey);
  return {
    text: ':broom: Conversation cleared. A fresh session starts on your next message.',
  };
}

// ── /switch ──────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.pnpm-store',
  'coverage',
  '.cache',
  '.turbo',
]);

/**
 * Search for directories under `baseDir` whose name contains `query`
 * (case-insensitive). Searches up to `maxDepth` levels deep.
 */
export function findDirectories(
  baseDir: string,
  query: string,
  maxDepth: number = 3,
): string[] {
  const q = query.toLowerCase();
  const results: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.name.toLowerCase().includes(q)) {
        results.push(full);
      }
      walk(full, depth + 1);
    }
  }

  walk(baseDir, 1);

  // Prefer exact basename match over partial
  const exact = results.filter((r) => basename(r).toLowerCase() === q);
  return exact.length > 0 ? exact : results;
}

function cmdSwitch(arg: string, ctx: CommandContext): CommandResult {
  const current = ctx.manager.getEffectiveWorkDir(ctx.sessionKey);

  // No arg → show current
  if (!arg) {
    const isOverridden = ctx.manager.getWorkDirOverride(ctx.sessionKey);
    return {
      text:
        `*Current work dir:* \`${current}\`` +
        (isOverridden ? ' (switched)' : ' (default)'),
    };
  }

  // /switch - → revert to default
  if (arg === '-') {
    const hadOverride = ctx.manager.getWorkDirOverride(ctx.sessionKey);
    if (!hadOverride) {
      return {text: `_Already at default: \`${ctx.baseWorkDir}\`._`};
    }
    ctx.manager.clearWorkDirOverride(ctx.sessionKey);
    // clearSession (not killSession): forget the stored session id too, so the
    // next message starts fresh in the default dir instead of trying to
    // --resume a session that belongs to the previous working directory.
    ctx.manager.clearSession(ctx.sessionKey);
    return {
      text: `:house: Switched back to default: \`${ctx.baseWorkDir}\`. A fresh session starts on your next message.`,
    };
  }

  // Search for matching directory
  const matches = findDirectories(ctx.baseWorkDir, arg);
  if (matches.length === 0) {
    return {
      text: `_No directory matching "${arg}" found under \`${ctx.baseWorkDir}\`._`,
    };
  }
  if (matches.length > 1) {
    const list = matches.slice(0, 10).map((m) => `• \`${m}\``);
    if (matches.length > 10) list.push(`_… and ${matches.length - 10} more_`);
    return {
      text: `Multiple matches for "${arg}":\n${list.join('\n')}\n_Be more specific._`,
    };
  }

  const target = matches[0]!;
  if (target === current) {
    return {text: `_Already in \`${target}\`._`};
  }

  ctx.manager.setWorkDirOverride(ctx.sessionKey, target);
  // clearSession (not killSession): forget the stored session id too. Resuming
  // a session from the old working directory in the new dir fails (Claude exits
  // with code 1), so start a fresh session in the new dir instead.
  ctx.manager.clearSession(ctx.sessionKey);
  return {
    text: `:arrow_right: Switched to \`${target}\`. A fresh session starts on your next message.`,
  };
}

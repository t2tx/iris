/**
 * commands.ts — Iris slash commands.
 *
 * Messages starting with "/" are intercepted before reaching Claude.
 * Returns the response text, or null if the message is not a command.
 */

import type {SessionManager} from './session.js';

export interface CommandContext {
  sessionKey: string;
  manager: SessionManager;
  allManagers: Map<string, SessionManager>;
  projectName: string;
}

export interface CommandResult {
  text: string;
}

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

  const [raw] = trimmed.split(/\s+/, 1) as [string];
  const name = raw.slice(1).toLowerCase();
  switch (name) {
    case 'help':
      return cmdHelp();
    case 'status':
      return cmdStatus(ctx);
    case 'sessions':
      return cmdSessions(ctx);
    case 'restart':
      return cmdRestart(ctx);
    case 'clear':
    case 'new':
      return cmdClear(ctx);
    default:
      // A bare "/word" (single token, no spaces) that matches no command is
      // almost certainly a typo — report it instead of forwarding to Claude.
      // Anything with spaces (e.g. "/path/to/file を説明して") is treated as a
      // normal prompt and passed through.
      if (raw === trimmed) {
        return {text: `_Unknown command: \`${raw}\`. Try \`/help\`._`};
      }
      return null; // pass through to Claude
  }
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

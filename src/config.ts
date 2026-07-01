import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {parse as parseToml} from 'smol-toml';
import type {PermissionMode} from './claude.js';
import {isLogLevel, type LogLevel} from './log.js';

/**
 * config.ts — loads Iris configuration from a TOML file and/or environment.
 *
 * The product configuration is a single TOML file (tokens included). The file
 * is located by resolveConfigPath() below. Environment variables remain
 * supported for development convenience (and override TOML when set); when no
 * TOML and no `[[projects]]` exist, a single project is synthesized from the
 * IRIS_* env vars.
 *
 * Routing: an inbound message is matched against each project's allowChannels
 * (for channel messages) or allowUsers (for DMs); the FIRST matching project
 * wins. No match → ignored (default-deny).
 */

/** Default product config location: ~/.iris-slack/config.toml */
export function defaultConfigPath(home: string = homedir()): string {
  return join(home, '.iris-slack', 'config.toml');
}

/**
 * Locate the TOML config file. Precedence:
 *   1. IRIS_CONFIG env (explicit path)
 *   2. ./iris.config.toml in the current directory  (development — repo-local)
 *   3. ~/.iris-slack/config.toml                    (product default)
 * Returns undefined if none exist.
 *
 * Repo-local comes before the home default so a developer running inside the
 * checkout automatically uses the repo's iris.config.toml, while an installed
 * product (launchd) uses ~/.iris-slack/config.toml (or an explicit --config).
 */
export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  opts: {cwd?: string; home?: string} = {},
): string | undefined {
  if (env.IRIS_CONFIG) return env.IRIS_CONFIG;
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const candidates = [join(cwd, 'iris.config.toml'), defaultConfigPath(home)];
  return candidates.find((p) => existsSync(p));
}

const PERMISSION_MODES: readonly PermissionMode[] = [
  'manual',
  'acceptEdits',
  'auto',
];

export interface ProjectConfig {
  name: string;
  workDir: string;
  allowChannels: string[];
  allowUsers: string[];
  permissionMode: PermissionMode;
  model?: string;
}

export interface IrisConfig {
  botToken: string;
  appToken: string;
  claudeBin: string;
  logLevel: LogLevel;
  /** Max chars of a Bash command shown in the tool-progress line. */
  bashProgressMax: number;
  projects: ProjectConfig[];
}

/** Raw TOML shapes (everything optional; validated below). */
interface RawProject {
  name?: unknown;
  work_dir?: unknown;
  allow_channels?: unknown;
  allow_users?: unknown;
  permission_mode?: unknown;
  model?: unknown;
}
interface RawConfig {
  slack?: {bot_token?: unknown; app_token?: unknown};
  claude_bin?: unknown;
  model?: unknown;
  permission_mode?: unknown;
  log_level?: unknown;
  bash_progress_max?: unknown;
  projects?: unknown;
}

export class ConfigError extends Error {}

export function loadConfig(opts?: {
  path?: string;
  env?: NodeJS.ProcessEnv;
}): IrisConfig {
  const env = opts?.env ?? process.env;
  const raw = opts?.path ? readTomlFile(opts.path) : {};

  // Tokens come from the TOML [slack] block; env vars may override them
  // (handy for CI / secret managers). Everything else is TOML-only.
  const {botToken, appToken} = resolveTokens(env, raw);
  const claudeBin = str(raw.claude_bin) || 'claude';
  const defaultMode = parseMode(str(raw.permission_mode) || 'manual');
  const defaultModel = str(raw.model) || undefined;
  const logLevel = parseLogLevel(str(raw.log_level) || 'info');
  const bashProgressMax = parsePositiveInt(raw.bash_progress_max, 800);
  const projects = parseProjects(raw, defaultMode, defaultModel);
  return {botToken, appToken, claudeBin, logLevel, bashProgressMax, projects};
}

/** Parse a positive integer from TOML; fall back to `def` if unset/invalid. */
function parsePositiveInt(v: unknown, def: number): number {
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new ConfigError(
      `invalid bash_progress_max ${JSON.stringify(v)} (expected a positive integer)`,
    );
  }
  return v;
}

function parseLogLevel(v: string): LogLevel {
  if (isLogLevel(v)) return v;
  throw new ConfigError(
    `invalid log_level "${v}" (expected: debug, info, warn, error)`,
  );
}

/** Validate and normalize the [[projects]] array (at least one required). */
function parseProjects(
  raw: RawConfig,
  defaultMode: PermissionMode,
  defaultModel: string | undefined,
): ProjectConfig[] {
  if (!Array.isArray(raw.projects) || raw.projects.length === 0) {
    throw new ConfigError(
      'no [[projects]] defined in the config file (at least one is required)',
    );
  }
  return raw.projects.map((p, i) =>
    normalizeProject(p as RawProject, i, defaultMode, defaultModel),
  );
}

/** Resolve and validate the Slack tokens (env takes precedence over TOML). */
function resolveTokens(
  env: NodeJS.ProcessEnv,
  raw: RawConfig,
): {botToken: string; appToken: string} {
  const botToken = firstNonEmpty(
    env.SLACK_BOT_TOKEN,
    str(raw.slack?.bot_token),
  );
  const appToken = firstNonEmpty(
    env.SLACK_APP_TOKEN,
    str(raw.slack?.app_token),
  );
  if (!botToken)
    throw new ConfigError('SLACK_BOT_TOKEN (or [slack].bot_token) is required');
  if (!appToken)
    throw new ConfigError('SLACK_APP_TOKEN (or [slack].app_token) is required');
  return {botToken, appToken};
}

/**
 * Pick the first project that permits this channel message.
 * A project matches when the channel is in allowChannels AND, if that project
 * also restricts users (allowUsers non-empty), the sender is in allowUsers.
 * Leaving allowUsers empty keeps the legacy "any user in an allowed channel"
 * behavior. Passing user lets several bots share one channel while each only
 * answers its own owner (e.g. UserA → @iris-b is ignored by iris-b).
 */
export function routeChannel(
  cfg: IrisConfig,
  channel: string,
  user?: string,
): ProjectConfig | undefined {
  return cfg.projects.find(
    (p) =>
      p.allowChannels.includes(channel) &&
      (p.allowUsers.length === 0 ||
        (user !== undefined && p.allowUsers.includes(user))),
  );
}
export function routeUser(
  cfg: IrisConfig,
  user: string | undefined,
): ProjectConfig | undefined {
  if (user === undefined) return undefined;
  return cfg.projects.find((p) => p.allowUsers.includes(user));
}

// ── helpers ────────────────────────────────────────────────────────────────

function readTomlFile(path: string): RawConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `cannot read config file ${path}: ${(err as Error).message}`,
    );
  }
  try {
    return parseToml(text);
  } catch (err) {
    throw new ConfigError(`invalid TOML in ${path}: ${(err as Error).message}`);
  }
}

function normalizeProject(
  p: RawProject,
  index: number,
  defaultMode: PermissionMode,
  defaultModel: string | undefined,
): ProjectConfig {
  const name = str(p.name) || `project-${index}`;
  const workDir = str(p.work_dir);
  if (!workDir)
    throw new ConfigError(`project "${name}": work_dir is required`);
  return {
    name,
    workDir,
    allowChannels: toStringArray(p.allow_channels),
    allowUsers: toStringArray(p.allow_users),
    permissionMode: p.permission_mode
      ? parseMode(str(p.permission_mode))
      : defaultMode,
    model: str(p.model) || defaultModel,
  };
}

function parseMode(v: string): PermissionMode {
  if ((PERMISSION_MODES as readonly string[]).includes(v))
    return v as PermissionMode;
  throw new ConfigError(
    `invalid permission_mode "${v}" (expected: ${PERMISSION_MODES.join(', ')})`,
  );
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function firstNonEmpty(...vals: Array<string | undefined>): string {
  for (const v of vals) if (v && v.trim()) return v.trim();
  return '';
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter(Boolean);
}

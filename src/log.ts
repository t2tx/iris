/**
 * log.ts — minimal leveled logger (stdout/stderr, zero dependencies).
 *
 * Levels: debug < info < warn < error. Messages below the configured level
 * are dropped. Kept deliberately small to match Iris's thin design.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = {debug: 0, info: 1, warn: 2, error: 3};
const LEVELS = Object.keys(ORDER) as LogLevel[];

export function isLogLevel(v: string): v is LogLevel {
  return (LEVELS as string[]).includes(v);
}

let current: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  current = level;
}

function emit(level: LogLevel, msg: string): void {
  if (ORDER[level] < ORDER[current]) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string) => emit('debug', msg),
  info: (msg: string) => emit('info', msg),
  warn: (msg: string) => emit('warn', msg),
  error: (msg: string) => emit('error', msg),
};

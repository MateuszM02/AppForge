// Logging. stdout belongs to the MCP stdio transport, so every log line goes to stderr (MCP clients show it in
// their server output panel) and, when the logs folder exists, to logs/appforge.log.

import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold = order[(process.env.APPFORGE_LOG_LEVEL as Level) ?? 'info'] ?? 1;

function write(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (order[level] < threshold) return;
  const tail = extra === undefined ? '' : ' ' + (extra instanceof Error ? extra.message : safeJson(extra));
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${msg}${tail}\n`;
  process.stderr.write(line);
  try {
    fs.appendFileSync(path.join(paths.logs, 'appforge.log'), line);
  } catch {
    // no logs folder yet (not installed) or not writable: stderr is enough
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => write('debug', scope, m, e),
    info: (m: string, e?: unknown) => write('info', scope, m, e),
    warn: (m: string, e?: unknown) => write('warn', scope, m, e),
    error: (m: string, e?: unknown) => write('error', scope, m, e),
  };
}

export type Logger = ReturnType<typeof logger>;

/** While serving MCP over stdio, anything printed with console.log by a library would corrupt the protocol. */
export function redirectConsoleToStderr(): void {
  const toErr = (...args: unknown[]) => process.stderr.write(args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ') + '\n');
  console.log = toErr;
  console.info = toErr;
  console.debug = toErr;
}

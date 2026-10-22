// Registers the AppForge MCP server in the clients found on this computer, and removes it again.
// - VS Code (and Insiders): the user-level mcp.json that `code --add-mcp` writes ({"servers": {...}}), edited
//   directly so no shell quoting is involved; the old file is kept as mcp.json.appforge-backup.
// - Claude Code: `claude mcp add-json --scope user`, or ~/.claude.json when the CLI cannot be started.
// The entry runs this install's own Node with an absolute path, so it works without anything on PATH.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoRoot } from './paths.js';

export const SERVER_NAME = 'appforge';

export function serverCommand(): { command: string; args: string[] } {
  return { command: process.execPath, args: [path.join(repoRoot, 'dist', 'server', 'src', 'cli.js'), 'serve'] };
}

export interface ClientResult {
  client: string;
  status: 'added' | 'updated' | 'unchanged' | 'removed' | 'absent' | 'not-installed' | 'failed';
  detail?: string;
}

function vscodeUserDirs(): Array<{ client: string; dir: string }> {
  const home = os.homedir();
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    { client: 'VS Code', dir: path.join(base, 'Code', 'User') },
    { client: 'VS Code Insiders', dir: path.join(base, 'Code - Insiders', 'User') },
  ].filter((c) => fs.existsSync(path.dirname(c.dir)));
}

/** JSON with comments and trailing commas (VS Code's settings dialect) -> value. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1') || '{}');
}

function editJson(file: string, edit: (doc: Record<string, unknown>) => boolean): 'changed' | 'unchanged' {
  const exists = fs.existsSync(file);
  const raw = exists ? fs.readFileSync(file, 'utf8') : '';
  const doc = (raw.trim() ? parseJsonc(raw) : {}) as Record<string, unknown>;
  if (!edit(doc)) return 'unchanged';
  if (exists) fs.copyFileSync(file, `${file}.appforge-backup`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, '\t') + '\n');
  return 'changed';
}

function registerVsCode(remove: boolean): ClientResult[] {
  const dirs = vscodeUserDirs();
  if (!dirs.length) return [{ client: 'VS Code', status: 'not-installed' }];
  const entry = { type: 'stdio', ...serverCommand() };
  return dirs.map(({ client, dir }) => {
    const file = path.join(dir, 'mcp.json');
    try {
      let before: unknown;
      const r = editJson(file, (doc) => {
        const servers = (doc.servers ??= {}) as Record<string, unknown>;
        before = servers[SERVER_NAME];
        if (remove) {
          if (!before) return false;
          delete servers[SERVER_NAME];
          return true;
        }
        if (JSON.stringify(before) === JSON.stringify(entry)) return false;
        servers[SERVER_NAME] = entry;
        doc.inputs ??= [];
        return true;
      });
      const status: ClientResult['status'] = r === 'unchanged' ? (remove ? 'absent' : 'unchanged') : remove ? 'removed' : before ? 'updated' : 'added';
      return { client, status, detail: file };
    } catch (e) {
      return { client, status: 'failed', detail: `${file}: ${e instanceof Error ? e.message : String(e)} (add it by hand: see README)` };
    }
  });
}

function findClaude(): string | null {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const dirs = [path.join(os.homedir(), '.local', 'bin'), ...(process.env.PATH ?? '').split(path.delimiter)];
  for (const d of dirs) {
    const p = path.join(d, exe);
    if (d && fs.existsSync(p)) return p;
  }
  return null;
}

function registerClaude(remove: boolean): ClientResult {
  const claudeJson = path.join(os.homedir(), '.claude.json');
  const cli = findClaude();
  if (!cli && !fs.existsSync(claudeJson) && !fs.existsSync(path.join(os.homedir(), '.claude'))) return { client: 'Claude Code', status: 'not-installed' };
  const entry = { type: 'stdio', ...serverCommand(), env: {} };
  if (cli) {
    const run = (args: string[]) => spawnSync(cli, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    const had = run(['mcp', 'get', SERVER_NAME]).status === 0;
    if (remove) {
      if (!had) return { client: 'Claude Code', status: 'absent' };
      const r = run(['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
      return r.status === 0 ? { client: 'Claude Code', status: 'removed' } : { client: 'Claude Code', status: 'failed', detail: (r.stderr || r.stdout).trim() };
    }
    if (had) run(['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
    const r = run(['mcp', 'add-json', '--scope', 'user', SERVER_NAME, JSON.stringify(entry)]);
    if (r.status === 0) return { client: 'Claude Code', status: had ? 'updated' : 'added' };
    // fall through to the file
  }
  try {
    let before: unknown;
    const r = editJson(claudeJson, (doc) => {
      const servers = (doc.mcpServers ??= {}) as Record<string, unknown>;
      before = servers[SERVER_NAME];
      if (remove) {
        if (!before) return false;
        delete servers[SERVER_NAME];
        return true;
      }
      servers[SERVER_NAME] = entry;
      return JSON.stringify(before) !== JSON.stringify(entry);
    });
    const status: ClientResult['status'] = r === 'unchanged' ? (remove ? 'absent' : 'unchanged') : remove ? 'removed' : before ? 'updated' : 'added';
    return { client: 'Claude Code', status, detail: claudeJson };
  } catch (e) {
    return { client: 'Claude Code', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

export function registerClients(opts: { clients: string[]; remove?: boolean }): ClientResult[] {
  const want = (c: string) => opts.clients.includes('all') || opts.clients.includes(c);
  const out: ClientResult[] = [];
  if (want('vscode')) out.push(...registerVsCode(Boolean(opts.remove)));
  if (want('claude')) out.push(registerClaude(Boolean(opts.remove)));
  return out;
}

/** The JSON to paste into other MCP clients (Cursor, Windsurf, Gemini CLI, Codex, ...). */
export function manualSnippet(): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: serverCommand() } }, null, 2);
}

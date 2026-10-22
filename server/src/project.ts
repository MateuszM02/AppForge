// Which project a call is about. Project memories are kept per project, keyed by the git remote when there is one
// (so two clones share memories) and by the folder path otherwise.
// Order: an explicit `project` argument, then the client's workspace roots (MCP "roots", sent by VS Code and
// Claude Code), then the server's working directory.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ProjectInfo {
  /** Short stable folder-safe id, e.g. "appforge-1a2b3c4d". */
  key: string;
  /** Human name (the folder or repo name). */
  name: string;
  /** Local folder, when known. */
  dir: string | null;
  /** Normalised git remote, when known (github.com/owner/repo). */
  remote: string | null;
}

function findGitDir(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function readRemote(repoDir: string): string | null {
  try {
    let gitDir = path.join(repoDir, '.git');
    if (fs.statSync(gitDir).isFile()) {
      // worktree / submodule: ".git" is a file "gitdir: <path>"
      const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(gitDir, 'utf8'));
      if (m) gitDir = path.resolve(repoDir, m[1]!.trim(), '..', '..');
    }
    const cfg = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg);
    return m ? normaliseRemote(m[1]!) : null;
  } catch {
    return null;
  }
}

export function normaliseRemote(url: string): string {
  return url
    .trim()
    .replace(/^git@([^:]+):/, '$1/')
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';
}

function hash8(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
}

export function projectFromDir(dir: string): ProjectInfo {
  const gitRoot = findGitDir(dir);
  const base = gitRoot ?? path.resolve(dir);
  const remote = gitRoot ? readRemote(gitRoot) : null;
  const name = remote ? remote.split('/').pop()! : path.basename(base);
  const identity = remote ?? base.toLowerCase().replace(/\\/g, '/');
  return { key: `${slug(name)}-${hash8(identity)}`, name, dir: base, remote };
}

/** A plain name ("my-app") that is not a folder: memories are keyed by the name alone. */
export function projectFromName(name: string): ProjectInfo {
  return { key: `${slug(name)}-${hash8(name.toLowerCase())}`, name, dir: null, remote: null };
}

export function resolveProject(explicit: string | undefined, roots: string[]): ProjectInfo {
  if (explicit && explicit.trim()) {
    const e = explicit.trim();
    if (fs.existsSync(e)) return projectFromDir(e);
    if (/github\.com[/:]/i.test(e)) {
      const remote = normaliseRemote(e);
      const name = remote.split('/').pop()!;
      return { key: `${slug(name)}-${hash8(remote)}`, name, dir: null, remote };
    }
    return projectFromName(e);
  }
  for (const r of roots) {
    const dir = r.startsWith('file:') ? fileURLToPath(r) : r;
    if (fs.existsSync(dir)) return projectFromDir(dir);
  }
  return projectFromDir(process.cwd());
}

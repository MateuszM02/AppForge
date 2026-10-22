// One GitHub client for every part of AppForge. It keeps the free quota free:
// - API answers are cached with their ETag; a "304 Not Modified" costs nothing against the rate limit.
// - File contents come from raw.githubusercontent.com (no API quota) and, when asked for by commit SHA, are cached
//   forever because they can never change.
// Token: GITHUB_TOKEN or GH_TOKEN, else `gh auth token` when the GitHub CLI is logged in. Without one GitHub allows
// 60 API requests an hour, with one 5,000.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { paths } from './paths.js';
import { logger } from './log.js';

const log = logger('github');
const UA = 'AppForge (+https://github.com/MateuszM02/AppForge)';

let tokenCache: string | null | undefined;

export function githubToken(): string | null {
  if (tokenCache !== undefined) return tokenCache;
  tokenCache = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  if (!tokenCache) {
    try {
      const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const t = r.status === 0 ? r.stdout.trim() : '';
      tokenCache = t || null;
    } catch {
      tokenCache = null;
    }
  }
  return tokenCache;
}

export interface RateInfo {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  authenticated: boolean;
}

const rate: RateInfo = { limit: null, remaining: null, resetAt: null, authenticated: false };

export function rateInfo(): RateInfo {
  return { ...rate, authenticated: githubToken() !== null };
}

export class GitHubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

let db: DatabaseSync | null = null;

function cacheDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(paths.cache, { recursive: true });
  db = new DatabaseSync(path.join(paths.cache, 'github.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS http (url TEXT PRIMARY KEY, etag TEXT, body TEXT NOT NULL, fetched_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS raw (key TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at INTEGER NOT NULL);
  `);
  return db;
}

function apiHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const t = githubToken();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

function noteRate(res: Response): void {
  const n = (k: string) => {
    const v = res.headers.get(k);
    return v === null ? null : Number(v);
  };
  if (res.headers.has('x-ratelimit-remaining')) {
    rate.limit = n('x-ratelimit-limit');
    rate.remaining = n('x-ratelimit-remaining');
    const reset = n('x-ratelimit-reset');
    rate.resetAt = reset ? new Date(reset * 1000).toISOString() : null;
  }
}

function rateLimitMessage(): string {
  const when = rate.resetAt ? ` It resets at ${rate.resetAt}.` : '';
  const how = githubToken()
    ? ''
    : ' Log in with the GitHub CLI (`gh auth login`) or set GITHUB_TOKEN to get 5,000 requests an hour instead of 60.';
  return `GitHub API rate limit reached.${when}${how}`;
}

/**
 * GET an API path ("/repos/o/r") or full URL, as JSON. Cached answers younger than `maxAgeSec` are returned without
 * a request; older ones are revalidated with their ETag.
 */
export async function ghApi<T = unknown>(pathOrUrl: string, opts: { maxAgeSec?: number } = {}): Promise<T> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `https://api.github.com${pathOrUrl}`;
  const row = cacheDb().prepare('SELECT etag, body, fetched_at FROM http WHERE url = ?').get(url) as
    | { etag: string | null; body: string; fetched_at: number }
    | undefined;
  if (row && opts.maxAgeSec && Date.now() - row.fetched_at < opts.maxAgeSec * 1000) return JSON.parse(row.body) as T;

  const headers = apiHeaders();
  if (row?.etag) headers['If-None-Match'] = row.etag;
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    if (row) {
      log.warn(`offline, using cached ${url}`);
      return JSON.parse(row.body) as T;
    }
    throw e;
  }
  noteRate(res);
  if (res.status === 304 && row) {
    cacheDb().prepare('UPDATE http SET fetched_at = ? WHERE url = ?').run(Date.now(), url);
    return JSON.parse(row.body) as T;
  }
  if ((res.status === 403 || res.status === 429) && rate.remaining === 0) {
    if (row) return JSON.parse(row.body) as T;
    throw new GitHubError(rateLimitMessage(), res.status);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new GitHubError(`GitHub ${res.status} for ${url}: ${text.slice(0, 200)}`, res.status);
  }
  const body = await res.text();
  cacheDb()
    .prepare('INSERT OR REPLACE INTO http (url, etag, body, fetched_at) VALUES (?, ?, ?, ?)')
    .run(url, res.headers.get('etag'), body, Date.now());
  return JSON.parse(body) as T;
}

/**
 * A file's text from raw.githubusercontent.com (no API quota). `ref` should be a commit SHA when possible: those
 * answers are cached forever. Returns null for a missing file.
 */
export async function ghRaw(owner: string, repo: string, ref: string, filePath: string): Promise<string | null> {
  const immutable = /^[0-9a-f]{40}$/.test(ref);
  const key = `${owner}/${repo}@${ref}:${filePath}`;
  if (immutable) {
    const row = cacheDb().prepare('SELECT body FROM raw WHERE key = ?').get(key) as { body: string } | undefined;
    if (row) return row.body;
  }
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  const headers: Record<string, string> = { 'User-Agent': UA };
  const t = githubToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new GitHubError(`raw.githubusercontent.com ${res.status} for ${owner}/${repo}/${filePath}`, res.status);
  const body = await res.text();
  if (immutable) cacheDb().prepare('INSERT OR REPLACE INTO raw (key, body, fetched_at) VALUES (?, ?, ?)').run(key, body, Date.now());
  return body;
}

/** A file's bytes (for installing: skills can carry images and fonts). Not cached. */
export async function ghRawBuffer(owner: string, repo: string, ref: string, filePath: string): Promise<Buffer | null> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  const headers: Record<string, string> = { 'User-Agent': UA };
  const t = githubToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new GitHubError(`raw.githubusercontent.com ${res.status} for ${owner}/${repo}/${filePath}`, res.status);
  return Buffer.from(await res.arrayBuffer());
}

/** The commit SHA a branch (default: the repo's default branch) points at. Free when unchanged (ETag). */
export async function ghHeadSha(owner: string, repo: string, ref = 'HEAD'): Promise<string> {
  const commit = await ghApi<{ sha: string }>(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`);
  return commit.sha;
}

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

/** Every file of a repo at a commit, in one request (cached forever per SHA). */
export async function ghTree(owner: string, repo: string, sha: string): Promise<TreeEntry[]> {
  const tree = await ghApi<{ tree: TreeEntry[]; truncated: boolean }>(
    `/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`,
    { maxAgeSec: 365 * 24 * 3600 },
  );
  if (tree.truncated) log.warn(`tree of ${owner}/${repo} is truncated by GitHub (very large repo)`);
  return tree.tree;
}

/** "owner/name", a GitHub URL or "owner/name/sub/path" -> owner and repo. */
export function parseRepo(ref: string): { owner: string; repo: string } {
  const cleaned = ref.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '');
  const [owner, repo] = cleaned.split('/');
  if (!owner || !repo) throw new Error(`Expected "owner/name", got "${ref}"`);
  return { owner, repo };
}

// User settings: <data folder>/config.json, merged over the defaults below. Every scalar setting can also be set
// with an environment variable APPFORGE_<SECTION>_<KEY> (e.g. APPFORGE_MEMORY_MAXENTRIES=200), which wins.
// Change settings with `appforge config set memory.maxEntries 200` or the memory_config tool.

import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';

export interface SkillSourceConfig {
  key: string;
  owner: string;
  repo: string;
  /** "skills": folders with SKILL.md; "marketplace": a Claude plugin marketplace (.claude-plugin/marketplace.json). */
  kind: 'skills' | 'marketplace';
  enabled: boolean;
  label?: string;
}

export const DEFAULT_SOURCES: SkillSourceConfig[] = [
  { key: 'anthropic-skills', owner: 'anthropics', repo: 'skills', kind: 'skills', enabled: true, label: 'Anthropic Skills' },
  {
    key: 'anthropic-plugins',
    owner: 'anthropics',
    repo: 'claude-plugins-official',
    kind: 'marketplace',
    enabled: true,
    label: 'Claude Plugins (official)',
  },
];

export const DEFAULTS = {
  tools: {
    /** Tool groups; switch one off to keep the client's tool list short. */
    memory: true,
    skills: true,
    repos: true,
    browser: true,
    /** browser_evaluate runs arbitrary JavaScript in the page, so it is off unless you turn it on. */
    browserEvaluate: false,
  },
  memory: {
    /** Active memories across all scopes; over it, the weakest unpinned ones move to the archive. */
    maxEntries: 500,
    /** Total text of active memories, in MB. */
    maxMB: 5,
    /** Default size of a memory_recall answer, in tokens (about 4 characters each). */
    recallBudgetTokens: 1500,
    /** Keep evicted memories in memory/archive/*.md (false = delete them). */
    keepArchive: true,
    /** Seed a fresh store with a few general guidelines (tagged "starter"). */
    starterPack: true,
  },
  skills: {
    sources: DEFAULT_SOURCES,
    /** Also search the community catalog bundled with skill-browser (~9,000 skills from 11 GitHub repos). */
    communityCatalog: false,
    /** Re-check sources at most this often (a check costs 1 GitHub request, free when nothing changed). */
    syncHours: 24,
  },
  browser: {
    /** Stop the Camoufox browser after this many idle minutes (it starts again on the next browser call). */
    idleMinutes: 10,
    /** Longest page snapshot returned at once, in characters (the rest is read with browser_snapshot offset). */
    maxSnapshotChars: 15000,
    /** Fixed port for the camofox server; 0 = pick a free one. */
    port: 0,
  },
  repos: {
    /** repo_search waits this long for results, then returns a job id to poll with repo_search_result. */
    waitSeconds: 40,
    /** Which local models rank results: small, balanced or best (see `appforge setup models`). */
    modelProfile: 'best',
    /** Override the profile's models: a key from server/src/models.ts or a Hugging Face id. */
    embedModel: '',
    rerankModel: '',
    /** Repos fetched from GitHub, and how many of them the cross-encoder reads; 0 = the profile's value. */
    poolSize: 0,
    rerankPool: 0,
    /** Stage floors: embedding similarity, and the cross-encoder score below which a repo is never shown, however popular
     * (0.01 removed the unrelated famous repos from the results and none of the expected ones on the test set). */
    minSimilarity: 0.2,
    minRerankScore: 0.01,
    /** The cross-encoder's share of the final score; the rest is popularity (0.5), credibility and recency. 0.15 was
     * fitted to the Qwen3 rerankers, which rate unrelated repos near 0 and related ones near 1. */
    rerankWeight: 0.15,
    /** How many repos the search returns. */
    finalists: 10,
    /** Unload the GGUF reranker after this many idle minutes to free its memory. */
    modelIdleMinutes: 10,
  },
  /** Check GitHub for a newer AppForge when the server starts. */
  updateCheck: true,
};

export type Config = typeof DEFAULTS;

let cached: Config | null = null;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, over: unknown): T {
  if (!isObject(base) || !isObject(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? merge(out[k], v) : v;
  return out as T;
}

function readFileConfig(): unknown {
  try {
    return JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  } catch {
    return {};
  }
}

function coerce(raw: string, like: unknown): unknown {
  if (typeof like === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`"${raw}" is not a number`);
    return n;
  }
  if (typeof like === 'boolean') {
    if (/^(1|true|yes|on)$/i.test(raw)) return true;
    if (/^(0|false|no|off)$/i.test(raw)) return false;
    throw new Error(`"${raw}" is not true/false`);
  }
  return raw;
}

function applyEnv(cfg: Config): Config {
  const out = structuredClone(cfg) as unknown as Record<string, unknown>;
  for (const [section, value] of Object.entries(out)) {
    if (!isObject(value)) {
      const env = process.env[`APPFORGE_${section.toUpperCase()}`];
      if (env !== undefined) out[section] = coerce(env, value);
      continue;
    }
    for (const [key, leaf] of Object.entries(value)) {
      if (isObject(leaf) || Array.isArray(leaf)) continue;
      const env = process.env[`APPFORGE_${section.toUpperCase()}_${key.toUpperCase()}`];
      if (env !== undefined) value[key] = coerce(env, leaf);
    }
  }
  return out as unknown as Config;
}

export function loadConfig(fresh = false): Config {
  if (cached && !fresh) return cached;
  cached = applyEnv(merge(structuredClone(DEFAULTS), readFileConfig()));
  return cached;
}

function walk(obj: unknown, dotted: string): { parent: Record<string, unknown>; key: string } {
  const parts = dotted.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (!isObject(cur) || !(p in cur)) throw new Error(`Unknown setting "${dotted}"`);
    cur = cur[p];
  }
  const key = parts[parts.length - 1]!;
  if (!isObject(cur) || !(key in cur)) throw new Error(`Unknown setting "${dotted}"`);
  return { parent: cur, key };
}

export function getSetting(dotted: string): unknown {
  const { parent, key } = walk(loadConfig(), dotted);
  return parent[key];
}

/** Saves one setting to config.json (only what differs from the defaults is kept there). */
export function setSetting(dotted: string, raw: unknown): unknown {
  const { parent, key } = walk(structuredClone(DEFAULTS), dotted);
  const like = parent[key];
  const value = typeof raw === 'string' && !Array.isArray(like) && !isObject(like) ? coerce(raw, like) : raw;
  const file = readFileConfig() as Record<string, unknown>;
  const parts = dotted.split('.');
  let cur: Record<string, unknown> = file;
  for (const p of parts.slice(0, -1)) {
    if (!isObject(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
  fs.mkdirSync(path.dirname(paths.config), { recursive: true });
  fs.writeFileSync(paths.config, JSON.stringify(file, null, 2) + '\n');
  loadConfig(true);
  return value;
}

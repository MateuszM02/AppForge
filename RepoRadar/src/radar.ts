// Loads the bundled headless RepoRadar (dist/reporadar/headless.mjs) with AppForge's settings, and keeps track of
// running searches so a slow search can be picked up later with repo_search_result.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../../server/src/config.js';
import { githubToken } from '../../server/src/github.js';
import { resolveModels, type EncoderModel } from '../../server/src/models.js';
import { paths, repoRoot } from '../../server/src/paths.js';

export interface RadarFilters {
  language?: string | null;
  license?: string[];
  minStars?: number | null;
  pushedWithinDays?: number | null;
  includeSmallProjects?: boolean;
}

export interface RadarResult {
  rank: number | null;
  repo: { fullName?: string; url?: string; description?: string | null; language?: string | null; license?: string | null; topics?: string[] };
  scores: { fit: number | null; future: number | null; underrated: number | null; total: number | null };
  analysis: { summary?: string; risks?: Array<{ label?: string; severity?: string; detail?: string } | string>; matchedFeatures?: unknown[]; missingFeatures?: unknown[]; repoType?: string } | null;
  metrics: { stars?: number; forks?: number; contributors?: number; releaseCount?: number; latestReleaseAt?: string | null; pushedAt?: string | null; openIssues?: number } | null;
}

/** What each pipeline stage did (RepoRadar/headless/pipeline.ts SearchStats). */
export interface RadarStats {
  queries: string[];
  topics: string[];
  /** Topics of the first round's best matches, searched in a second round. */
  expansion: string[];
  pool: number;
  githubCalls: number;
  rank: { pool: number; belowSimilarity: number; reranked: number; belowRerankScore: number; finalists: number } | null;
  seconds: Record<string, number>;
}

export interface RadarSearch {
  searchId: string;
  status: string;
  stage: string | null;
  progress: number;
  error: string | null;
  prompt: string | null;
  results: RadarResult[];
  stats: RadarStats | null;
}

/** The settings of one search, built from the config and the model profile. */
export interface SearchSettings {
  poolSize: number;
  embed: { id: string; pooling?: 'mean' | 'cls' };
  /** readme: whether this cross-encoder reads the start of each README; gguf: its file, for node-llama-cpp. */
  rerank: { id: string; readme?: boolean; gguf?: string; yes?: string };
  minSimilarity: number;
  rerankPool: number;
  minRerankScore: number;
  rerankWeight: number;
  rerankScale?: 'minmax';
  finalists: number;
  /** Unload the GGUF reranker after this many idle minutes. */
  modelIdleMinutes: number;
  cacheDir: string;
}

interface Headless {
  startSearch(prompt: string, filters: RadarFilters, settings: SearchSettings): Promise<{ id: string; done: Promise<void> }>;
  getSearch(id: string): Promise<RadarSearch | null>;
  reference(prompt: string): Promise<{ refQueries: string[]; excludeFullNames: string[] } | null>;
  repoDetails(fullName: string, need?: string, rerank?: SearchSettings['rerank']): Promise<{ evidence: Record<string, unknown>; analysis: Record<string, unknown> } | null>;
}

let loaded: Promise<Headless> | null = null;

export function radar(): Promise<Headless> {
  loaded ??= (async () => {
    const bundle = path.join(repoRoot, 'dist', 'reporadar', 'headless.mjs');
    if (!fs.existsSync(bundle)) throw new Error('RepoRadar is not built. Run `npm run build` in the AppForge folder (the installer does this).');
    const token = githubToken();
    // RepoRadar reads its settings from the environment once, when it loads.
    process.env.DATABASE_URL ??= 'appforge-sqlite';
    // Upstream's LLM paths stay off; the bundler replaces the OpenAI client with a stub that throws.
    process.env.NO_LLM_MODE = 'true';
    if (token) process.env.GITHUB_TOKEN = token;
    process.env.APPFORGE_RADAR_DB_DIR = paths.cache;
    process.env.APPFORGE_MODELS_DIR = paths.models;
    return (await import(pathToFileURL(bundle).href)) as Headless;
  })();
  loaded.catch(() => {
    loaded = null;
  });
  return loaded;
}

/** Where a GGUF reranker lives (models/rerank/<file>). */
export const rerankPath = (m: EncoderModel) => (m.gguf ? path.join(paths.models, 'rerank', m.gguf.file) : undefined);

const spec = (m: EncoderModel) => ({ id: m.id, pooling: m.pooling, readme: m.readme, gguf: rerankPath(m), yes: m.yes });

export function searchSettings(): SearchSettings {
  const c = loadConfig().repos;
  const m = resolveModels(c);
  return {
    poolSize: m.poolSize,
    embed: spec(m.embed),
    rerank: spec(m.rerank),
    minSimilarity: c.minSimilarity,
    rerankPool: m.rerankPool,
    minRerankScore: c.minRerankScore,
    rerankWeight: m.rerankWeight,
    rerankScale: m.rerankScale,
    finalists: c.finalists,
    modelIdleMinutes: c.modelIdleMinutes,
    cacheDir: paths.cache,
  };
}

/** Searches started in this process (the pipeline keeps running after repo_search returns). */
const running = new Map<string, Promise<void>>();

export async function startSearch(prompt: string, filters: RadarFilters): Promise<string> {
  if (!githubToken() && process.env.APPFORGE_ALLOW_ANONYMOUS_SEARCH !== '1') {
    throw new Error(
      'repo_search needs a GitHub login: one search makes about 100 GitHub API requests and GitHub allows 60 an hour without one. ' +
        'Run `gh auth login` (GitHub CLI) and try again, or set GITHUB_TOKEN and restart the MCP server. repo_tree, repo_read_file and repo_details work without it.',
    );
  }
  const r = await radar();
  const { id, done } = await r.startSearch(prompt, filters, searchSettings());
  running.set(id, done);
  void done.finally(() => running.delete(id));
  return id;
}

export async function getSearch(id: string): Promise<RadarSearch | null> {
  return (await radar()).getSearch(id);
}

export function isRunningHere(id: string): boolean {
  return running.has(id);
}

/** Downloads the local models of a profile (default: the configured one) and loads each once. */
export async function prefetchModels(profile?: string): Promise<string[]> {
  const enc = await import('../headless/encoders.js');
  enc.setModelsDir(paths.models);
  const c = loadConfig().repos;
  const m = resolveModels({ ...c, modelProfile: profile ?? c.modelProfile });
  await enc.warm(spec(m.embed), 'embed');
  if (m.rerank.gguf && !fs.existsSync(rerankPath(m.rerank)!)) {
    const { resolveModelFile } = await import('node-llama-cpp');
    await resolveModelFile(m.rerank.gguf.uri, { directory: path.join(paths.models, 'rerank'), fileName: m.rerank.gguf.file, cli: process.stderr.isTTY === true });
  }
  await enc.warm(spec(m.rerank), 'rerank');
  return [m.embed.id, m.rerank.gguf?.file ?? m.rerank.id];
}

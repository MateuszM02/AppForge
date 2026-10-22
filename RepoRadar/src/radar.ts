// Loads the bundled headless RepoRadar (dist/reporadar/headless.mjs) with AppForge's settings, and keeps track of
// running searches so a slow search can be picked up later with repo_search_result.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { githubToken } from '../../server/src/github.js';
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

export interface RadarSearch {
  searchId: string;
  status: string;
  stage: string | null;
  progress: number;
  error: string | null;
  prompt: string | null;
  results: RadarResult[];
}

interface Headless {
  startSearch(prompt: string, filters?: RadarFilters): Promise<{ id: string; done: Promise<void> }>;
  getSearch(id: string): Promise<RadarSearch | null>;
  repoDetails(fullName: string, need?: string): Promise<{ evidence: Record<string, unknown>; analysis: Record<string, unknown> } | null>;
}

let loaded: Promise<Headless> | null = null;

export function radar(): Promise<Headless> {
  loaded ??= (async () => {
    const bundle = path.join(repoRoot, 'dist', 'reporadar', 'headless.mjs');
    if (!fs.existsSync(bundle)) throw new Error('RepoRadar is not built. Run `npm run build` in the AppForge folder (the installer does this).');
    const token = githubToken();
    // RepoRadar reads its settings from the environment once, when it loads.
    process.env.DATABASE_URL ??= 'appforge-sqlite';
    process.env.NO_LLM_MODE = 'true';
    if (token) process.env.GITHUB_TOKEN = token;
    process.env.APPFORGE_RADAR_DB_DIR = paths.cache;
    process.env.APPFORGE_MODELS_DIR = paths.models;
    process.env.CROSS_ENCODER_RERANK ??= 'true';
    return (await import(pathToFileURL(bundle).href)) as Headless;
  })();
  loaded.catch(() => {
    loaded = null;
  });
  return loaded;
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
  const { id, done } = await r.startSearch(prompt, filters);
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

/** Downloads the two local models RepoRadar ranks with (about 180 MB, once). */
export async function prefetchModels(): Promise<string[]> {
  const t = await import('@huggingface/transformers');
  t.env.cacheDir = paths.models;
  const embed = await t.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32' });
  await embed('warm up', { pooling: 'mean', normalize: true });
  const rerank = process.env.RERANK_MODEL || 'Xenova/ms-marco-MiniLM-L-6-v2';
  await t.AutoTokenizer.from_pretrained(rerank);
  await t.AutoModelForSequenceClassification.from_pretrained(rerank, { dtype: 'fp32' });
  return ['Xenova/all-MiniLM-L6-v2', rerank];
}

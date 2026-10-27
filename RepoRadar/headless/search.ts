// Stages 1-3 of repo_search without storage or evidence, so pipeline.ts and scripts/eval-search.mjs run the same code
// (the eval with cached GitHub answers and model outputs). The fetch has two rounds: the need's own words, then the
// GitHub topics shared by the first round's best matches, which finds the projects whose descriptions use other words
// ("scraping" for "scrape", "note-taking" for "alternative to Notion").

import { buildQueries, discoverTopics, extractTerms, fetchPool, qualifiersFor, withLanguage, ROLE_WORDS, type GitHubClient } from './fetch.js';
import { rankCandidates, repoText, type RankSettings, type RankStats } from './rank.js';
import type { Candidate, SearchFilters } from '../upstream/src/lib/types.js';

export interface FindSettings extends RankSettings {
  poolSize: number;
  /** Second round: how many topics of the first round's best matches to search, and the repos fetched for them. */
  expandTopics: number;
  expandPool: number;
  cacheDir: string;
}

export interface FindDeps {
  client: GitHubClient;
  embed(texts: string[]): Promise<Float32Array[]>;
  rerank(query: string, docs: string[]): Promise<number[]>;
  readmeHeads?(fullNames: string[]): Promise<Map<string, string>>;
  /** "Alternative to X": extra queries, and X itself to leave out (upstream's buildReferenceContext). */
  reference?: { refQueries: string[]; excludeFullNames: string[] } | null;
}

export interface FindResult {
  candidates: Candidate[];
  ranked: Awaited<ReturnType<typeof rankCandidates<Candidate>>>['ranked'];
  rank: RankStats;
  queries: string[];
  topics: string[];
  expansion: string[];
  calls: number;
  errors: string[];
}

type Timed = <T>(stage: string, run: () => Promise<T>) => Promise<T>;

/** The second round: this many topics, one page (100 repos) each. */
export const EXPAND = { topics: 5, pool: 500 };

// Topics that say nothing about what a repository does.
const NOISE_TOPICS = new Set(['hacktoberfest', 'awesome', 'awesome-list', 'list', 'open-source', 'opensource', 'github', 'free', 'tool', 'tools', 'app', 'application']);

/**
 * The topics most shared by the first round's best matches (by embedding similarity): counted over the top 30,
 * weighted by similarity, at least 3 repos each, leaving out topics already searched, noise and bare languages or
 * platforms (topic:python alone is millions of repos).
 */
export function expansionTopics(scored: { topics: string[]; sim: number }[], o: { count: number; skip: Iterable<string> }): string[] {
  const skip = new Set(o.skip);
  const weight = new Map<string, { w: number; n: number }>();
  for (const r of [...scored].sort((a, b) => b.sim - a.sim).slice(0, 30))
    for (const t of new Set(r.topics)) {
      if (skip.has(t) || NOISE_TOPICS.has(t) || ROLE_WORDS.has(t) || /^hacktoberfest/.test(t)) continue;
      const e = weight.get(t) ?? { w: 0, n: 0 };
      weight.set(t, { w: e.w + r.sim, n: e.n + 1 });
    }
  return [...weight.entries()].filter(([, e]) => e.n >= 3).sort((a, b) => b[1].w - a[1].w).slice(0, o.count).map(([t]) => t);
}

export async function findRepos(prompt: string, filters: SearchFilters, s: FindSettings, deps: FindDeps, timed: Timed = (_s, run) => run()): Promise<FindResult> {
  // The pool's vectors are reused by the ranking, so each repo is embedded once.
  const vectors = new Map<string, Float32Array>();
  const embed = async (texts: string[]) => {
    const missing = [...new Set(texts.filter((t) => !vectors.has(t)))];
    if (missing.length) (await deps.embed(missing)).forEach((v, i) => vectors.set(missing[i]!, v));
    return texts.map((t) => vectors.get(t)!);
  };
  const f = withLanguage(prompt, filters);
  const terms = extractTerms(prompt);
  const topics = await discoverTopics(terms.keywords, { need: prompt, filters: f, phrases: terms.phrases }, {
    client: deps.client,
    embed: async (texts) => (await embed(texts)).map((v) => Array.from(v)),
    cacheDir: s.cacheDir,
  }).catch(() => null);
  const queries = [...new Set([...(deps.reference?.refQueries ?? []).map((q) => `${q} ${qualifiersFor(f)}`), ...buildQueries(prompt, f), ...(topics?.queries ?? [])])];
  const excluded = new Set(deps.reference?.excludeFullNames ?? []);
  const keep = (c: Candidate) => !excluded.has(c.fullName.toLowerCase());
  const first = await timed('fetch', () => fetchPool(queries, { poolSize: s.poolSize }, { client: deps.client }));
  let candidates = first.candidates.filter(keep);

  // Round 2: the topics of the best matches so far.
  let expansion: string[] = [];
  let second = { calls: 0, errors: [] as string[] };
  if (s.expandTopics > 0 && candidates.length) {
    const [need, ...vecs] = await timed('embed', () => embed([prompt, ...candidates.map(repoText)]));
    const scored = candidates.map((c, i) => ({ topics: c.topics, sim: vecs[i]!.reduce((d, x, k) => d + x * need![k]!, 0) }));
    expansion = expansionTopics(scored, { count: s.expandTopics, skip: [...(topics?.topics ?? []), ...terms.keywords] });
    if (expansion.length) {
      const more = await timed('expand', () => fetchPool(expansion.map((t) => `topic:${t} ${qualifiersFor(f)}`), { poolSize: s.expandPool, pages: 1 }, { client: deps.client }));
      const seen = new Set(candidates.map((c) => c.fullName.toLowerCase()));
      candidates = [...candidates, ...more.candidates.filter((c) => keep(c) && !seen.has(c.fullName.toLowerCase()))];
      second = more;
    }
  }

  const { ranked, stats } = await timed('rank', () =>
    rankCandidates(prompt, candidates, { ...s, includeSmallProjects: f.includeSmallProjects, pushedWithinDays: f.pushedWithinDays }, { embed, rerank: deps.rerank, readmeHeads: deps.readmeHeads }),
  );
  return {
    candidates, ranked, rank: stats, queries, topics: topics?.topics ?? [], expansion,
    calls: first.calls + second.calls + (topics?.calls ?? 0), errors: [...first.errors, ...second.errors],
  };
}

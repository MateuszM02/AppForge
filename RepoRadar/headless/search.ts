// Stages 1-3 of repo_search without storage or evidence, so pipeline.ts and scripts/eval-search.mjs run the same code
// (the eval with cached GitHub answers and model outputs). The fetch has two rounds: the need's own words, then the
// GitHub topics shared by the first round's best matches, which finds the projects whose descriptions use other words
// ("scraping" for "scrape", "note-taking" for "alternative to Notion").

import { buildQueries, discoverTopics, extractTerms, fetchPool, qualifiersFor, withLanguage, ROLE_WORDS, type GitHubClient } from './fetch.js';
import { gateScore, rankCandidates, repoText, type RankSettings, type RankStats } from './rank.js';
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
  /** "Alternative to X": extra queries, and X itself to leave out (upstream's buildReferenceContext); a promise is
   * awaited alongside the topic discovery. */
  reference?: Reference | Promise<Reference> | null;
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

type Reference = { refQueries: string[]; excludeFullNames: string[] } | null;
type Timed = <T>(stage: string, run: () => Promise<T>) => Promise<T>;

/** The second round: this many topics, one page (100 repos) each. */
export const EXPAND = { topics: 5, pool: 500 };

// Topics that say nothing about what a repository does.
const NOISE_TOPICS = new Set(['hacktoberfest', 'awesome', 'awesome-list', 'list', 'open-source', 'opensource', 'github', 'free', 'tool', 'tools', 'app', 'application']);

/** A topic's spelling-insensitive form: note-taking-apps, notetakingapp and note-taking-app are one topic. */
const topicKey = (t: string) => t.replace(/[-_]/g, '').replace(/(es|s)$/, '');

/**
 * Candidate topics for the second round: those shared by at least 2 of the first round's 30 best matches (by the
 * shortlist's blend of similarity and popularity, since established projects carry curated topics), weighted by
 * those repos' scores, leaving out spellings of topics already searched, noise and bare languages or platforms.
 */
export function topicCandidates(scored: { topics: string[]; score: number }[], skip: Iterable<string>): { topic: string; weight: number }[] {
  const skipped = new Set([...skip].map(topicKey));
  const weight = new Map<string, { w: number; n: number }>();
  for (const r of [...scored].sort((a, b) => b.score - a.score).slice(0, 30))
    for (const t of new Set(r.topics)) {
      if (skipped.has(topicKey(t)) || NOISE_TOPICS.has(t) || ROLE_WORDS.has(t) || /^hacktoberfest/.test(t)) continue;
      const e = weight.get(t) ?? { w: 0, n: 0 };
      weight.set(t, { w: e.w + r.score, n: e.n + 1 });
    }
  return [...weight.entries()].filter(([, e]) => e.n >= 2).map(([topic, e]) => ({ topic, weight: e.w }));
}

/**
 * The topics to search: the more related half of the candidates by the embedding of the topic's own words (drops
 * generic ones such as c, data, svg or devops, which would bring in thousands of popular unrelated repos), then the
 * most shared first.
 */
export function expansionTopics(cands: { topic: string; weight: number; sim: number }[], count: number): string[] {
  const sims = cands.map((c) => c.sim).sort((a, b) => b - a);
  const cut = sims[Math.max(0, Math.ceil(sims.length / 2) - 1)] ?? 0;
  return cands.filter((c) => c.sim >= cut).sort((a, b) => b.weight - a.weight).slice(0, count).map((c) => c.topic);
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
  const [topics, reference] = await Promise.all([
    discoverTopics(terms.keywords, { need: prompt, filters: f, phrases: terms.phrases }, {
      client: deps.client,
      embed: async (texts) => (await embed(texts)).map((v) => Array.from(v)),
      cacheDir: s.cacheDir,
    }).catch(() => null),
    Promise.resolve(deps.reference ?? null).catch(() => null),
  ]);
  const queries = [...new Set([...(reference?.refQueries ?? []).map((q) => `${q} ${qualifiersFor(f)}`), ...buildQueries(prompt, f), ...(topics?.queries ?? [])])];
  const excluded = new Set(reference?.excludeFullNames ?? []);
  const keep = (c: Candidate) => !excluded.has(c.fullName.toLowerCase());
  // Round 2: the topics of the best matches among round 1's first pages, searched while its further pages load.
  let expansion: string[] = [];
  let round2: Promise<{ candidates: Candidate[]; calls: number; errors: string[] }> | null = null;
  const expand = async (firstPages: Candidate[]) => {
    const [need, ...vecs] = await embed([prompt, ...firstPages.map(repoText)]);
    const dot = (v: Float32Array) => v.reduce((d, x, k) => d + x * need![k]!, 0);
    const scored = firstPages.map((c, i) => ({ topics: c.topics, score: gateScore(dot(vecs[i]!), c, f.includeSmallProjects === true) }));
    const cands = topicCandidates(scored, [...(topics?.topics ?? []), ...terms.keywords]);
    const tvecs = await embed(cands.map((c) => c.topic.replace(/-/g, ' ')));
    expansion = expansionTopics(cands.map((c, i) => ({ ...c, sim: dot(tvecs[i]!) })), s.expandTopics);
    if (!expansion.length) return { candidates: [], calls: 0, errors: [] };
    return fetchPool(expansion.map((t) => `topic:${t} ${qualifiersFor(f)}`), { poolSize: s.expandPool, pages: 1 }, { client: deps.client });
  };
  const first = await timed('fetch', () =>
    fetchPool(queries, {
      poolSize: s.poolSize,
      onFirstPages: (c) => {
        // Caught here: a failed second round only means a smaller pool.
        if (s.expandTopics > 0 && c.length) round2 = expand(c.filter(keep)).catch((e) => ({ candidates: [], calls: 0, errors: [`round 2: ${e instanceof Error ? e.message : e}`] }));
      },
    }, { client: deps.client }),
  );
  const second = (await timed('expand', () => round2 ?? Promise.resolve({ candidates: [], calls: 0, errors: [] }))) as { candidates: Candidate[]; calls: number; errors: string[] };
  const seen = new Set<string>();
  const candidates = [...first.candidates, ...second.candidates].filter((c) => keep(c) && !seen.has(c.fullName.toLowerCase()) && seen.add(c.fullName.toLowerCase()));

  const { ranked, stats } = await timed('rank', () =>
    rankCandidates(prompt, candidates, { ...s, includeSmallProjects: f.includeSmallProjects, pushedWithinDays: f.pushedWithinDays }, { embed, rerank: deps.rerank, readmeHeads: deps.readmeHeads }),
  );
  return {
    candidates, ranked, rank: stats, queries, topics: topics?.topics ?? [], expansion,
    calls: first.calls + second.calls + (topics?.calls ?? 0), errors: [...first.errors, ...second.errors],
  };
}

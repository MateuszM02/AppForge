// AppForge's repo_search pipeline. It replaces upstream's runSearch, which is built around an LLM writing the GitHub
// queries, and reuses upstream's modules (unchanged) for everything after the fetch:
//   1 fetch   fetch.ts + search.ts: LLM-free queries + GitHub topics → GraphQL search, then a second round on the
//             topics of the best matches: a pool of up to a few thousand repos
//   2 embed   rank.ts: an embedding model drops junk and keeps the K most promising
//   3 rerank  rank.ts: a cross-encoder reads need + repo; the N best by its score and popularity are the results
//   4 evidence upstream enrichment and health score for the N
// Results are stored with upstream's persist helpers, so getSearch / serializeResult read them as before.

import { prisma } from './prisma-shim';
import { extractTerms, type GitHubClient } from './fetch';
import type { RankStats } from './rank';
import { EXPAND, findRepos } from './search';
import { embed, rerank, warm, type EncoderSpec } from './encoders';
import { createLogger } from '@/lib/logger';
import { enrichReposBatch } from '@/lib/github/enrich';
import { deterministicScore } from '@/lib/scoring/deterministic';
import { clamp01, computeTotal } from '@/lib/scoring/rubric';
import { buildReferenceContext } from '@/lib/search/referenceResolver';
import { upsertRepo, saveResult } from '@/lib/pipeline/persist';
import { writeSearchDiagnostics } from '@/lib/pipeline/diagnostics';
import type { Analysis, Candidate, Intent, RepoEvidence, SearchFilters } from '@/lib/types';


export interface SearchSettings {
  poolSize: number;
  embed: EncoderSpec;
  rerank: EncoderSpec;
  minSimilarity: number;
  rerankPool: number;
  minRerankScore: number;
  rerankWeight: number;
  finalists: number;
  /** Unload the GGUF reranker after this many idle minutes. */
  modelIdleMinutes: number;
  /** Folder for the GitHub topic cache. */
  cacheDir: string;
}

/** What each stage did, for the tool's footer line and the eval. */
export interface SearchStats {
  queries: string[];
  topics: string[];
  expansion: string[];
  pool: number;
  githubCalls: number;
  rank: Omit<RankStats, 'shortlist'> | null;
  seconds: Record<string, number>;
}

const stats = new Map<string, SearchStats>();
export const searchStats = (id: string): SearchStats | null => stats.get(id) ?? null;

const setJob = (id: string, data: { status?: string; stage?: string; progress?: number; error?: string }) =>
  prisma.searchJob.updateMany({ where: { searchQueryId: id }, data });

// The fetch talks to GitHub directly: upstream's octokit throttles every GraphQL call to one at a time, a second apart
// (and /search/ calls to one per 2 s), which turned 30 parallel page requests into a 40-second queue.
const api = async (method: string, route: string, body?: unknown) => {
  const r = await fetch(`https://api.github.com${route}`, {
    method,
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'AppForge' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = (await r.json()) as { data?: unknown; errors?: { message: string }[]; message?: string };
  if (!r.ok || j.errors) throw new Error(`GitHub ${r.status}: ${j.errors?.[0]?.message ?? j.message ?? r.statusText}`);
  return j;
};
const github: GitHubClient = {
  graphql: async <T>(query: string, variables?: Record<string, unknown>) => (await api('POST', '/graphql', { query, variables })).data as T,
  request: async (route: string, params?: Record<string, unknown>) => {
    const [, path] = route.split(' ');
    return { data: await api('GET', `${path}?${new URLSearchParams(Object.entries(params ?? {}).map(([k, v]) => [k, String(v)]))}`) };
  },
};

/** The first 500 characters of each repo's README.md, by lowercase fullName. */
async function readmeHeads(names: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const batches = Array.from({ length: Math.ceil(names.length / 40) }, (_, i) => names.slice(i * 40, i * 40 + 40));
  await Promise.all(batches.map(async (batch) => {
    const fields = batch.map((n, k) => `r${k}: repository(owner: ${JSON.stringify(n.split('/')[0])}, name: ${JSON.stringify(n.split('/')[1])}) { a: object(expression: "HEAD:README.md") { ... on Blob { text } } b: object(expression: "HEAD:readme.md") { ... on Blob { text } } }`);
    const data = await github.graphql<Record<string, { a?: { text?: string }; b?: { text?: string } } | null>>(`{ ${fields.join(' ')} }`).catch(() => ({}) as Record<string, null>);
    batch.forEach((n, k) => {
      const text = data[`r${k}`]?.a?.text ?? data[`r${k}`]?.b?.text;
      if (text) out.set(n.toLowerCase(), text.slice(0, 500));
    });
  }));
  return out;
}

export async function runAppForgeSearch(id: string, prompt: string, filters: SearchFilters, s: SearchSettings): Promise<void> {
  const log = createLogger(`pipeline:${id.slice(0, 8)}`);
  const st: SearchStats = { queries: [], topics: [], expansion: [], pool: 0, githubCalls: 0, rank: null, seconds: {} };
  stats.set(id, st);
  const timed = async <T>(stage: string, run: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    const done = log.time(stage);
    try {
      return await run();
    } finally {
      done();
      st.seconds[stage] = (Date.now() - t) / 1000;
    }
  };
  try {
    await setJob(id, { status: 'running', stage: 'fetch', progress: 5 });
    process.env.APPFORGE_MODEL_IDLE_MS = String(s.modelIdleMinutes * 60_000);
    // Both models load (seconds each, the 4B reranker most) while GitHub is searched.
    void warm(s.embed, 'embed').catch(() => undefined);
    void warm(s.rerank, 'rerank').catch(() => undefined);
    const found = await findRepos(prompt, filters, { ...s, expandTopics: EXPAND.topics, expandPool: EXPAND.pool }, {
      client: github,
      embed: (texts) => embed(s.embed, texts),
      rerank: (q, docs) => rerank(s.rerank, q, docs),
      // README beginnings help some cross-encoders and hurt others (models.ts): 40 repos per GraphQL call, all at once.
      readmeHeads: !s.rerank.readme ? undefined : (names) => readmeHeads(names),
      reference: buildReferenceContext(prompt).catch(() => null),
    }, async (stage, run) => {
      const progress = { fetch: 5, embed: 15, expand: 20, rank: 30 }[stage];
      if (progress) await setJob(id, { stage, progress });
      return timed(stage, run);
    });
    const { candidates, ranked } = found;
    const { shortlist, ...rankStats } = found.rank;
    Object.assign(st, { queries: found.queries, topics: found.topics, expansion: found.expansion, pool: candidates.length, githubCalls: found.calls, rank: rankStats });
    log.info('Ranked', { queries: st.queries, topics: st.topics, expansion: st.expansion, pool: st.pool, calls: st.githubCalls, errors: found.errors });

    // Stage 4: evidence and health for the results, which keep the ranking's order.
    await setJob(id, { stage: 'enrich', progress: 55 });
    const evidences = await timed('enrich', () => enrichReposBatch(ranked.map((r) => ({ candidate: r.candidate, similarity: r.rerankScore }))));
    const intent: Intent = {
      normalizedPrompt: prompt,
      queries: st.queries,
      constraints: {
        keywords: extractTerms(prompt).keywords, requiredFeatures: [], aspects: [], language: filters.language ?? null, licenses: filters.license ?? [],
        pushedWithinDays: filters.pushedWithinDays ?? null, projectType: filters.projectType ?? 'any',
        includeSmallProjects: filters.includeSmallProjects === true, minStars: filters.minStars ?? null, maxStars: null,
      },
    };
    const baselines = evidences.map((e) => deterministicScore(intent, e));
    // The cross-encoder is the best relevance signal, so it carries most of the fit score.
    const ordered: { evidence: RepoEvidence; analysis: Analysis }[] = evidences.map((evidence, i) => {
      const fit = clamp01(0.7 * ranked[i]!.rerankScore + 0.3 * baselines[i]!.fit);
      return { evidence, analysis: { ...baselines[i]!, fit, total: computeTotal(fit, baselines[i]!.future, baselines[i]!.underrated) } };
    });
    let rank = 1;
    for (const r of ordered) await saveResult({ searchQueryId: id, repoId: await upsertRepo(r.evidence.candidate), rank: rank++, analysis: r.analysis, evidence: r.evidence });
    const now = new Date().toISOString();
    writeSearchDiagnostics({
      searchQueryId: id, prompt, llmQueries: [], heuristicQueries: st.queries, guidanceHints: [], canonicalNames: [], activeQueries: st.queries,
      perQueryResults: [], dedupeCount: 0, candidatePoolCount: candidates.length, candidatePool: candidates.map((c: Candidate) => c.fullName),
      funnelSurvivors: shortlist, droppedKnownCandidates: [], startedAt: now, updatedAt: now,
    });
    log.info('Search complete', { results: ordered.length, ...st, queries: undefined });
    await setJob(id, { status: 'completed', stage: 'done', progress: 100 });
  } catch (e) {
    log.error('Search failed', e);
    await setJob(id, { status: 'failed', error: e instanceof Error ? e.message : String(e), progress: 100 });
  }
}

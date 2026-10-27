// AppForge's repo_search pipeline. It replaces upstream's runSearch, which is built around an LLM writing the GitHub
// queries, and reuses upstream's modules (unchanged) for everything after the fetch:
//   1 fetch   fetch.ts: LLM-free queries + GitHub topics → GraphQL search, a pool of up to a few thousand repos
//   2 embed   rank.ts: an embedding model drops junk and keeps the K most promising
//   3 rerank  rank.ts: a cross-encoder reads need + repo (+ README head) and keeps the N best
//   4 pick    upstream enrichment and health score, then one listwise call to the local LLM (openai-local.ts) that
//             orders the N and drops off-topic ones
// Results are stored with upstream's persist helpers, so getSearch / serializeResult read them as before.

import { prisma } from './prisma-shim';
import { buildQueries, discoverTopics, extractTerms, fetchPool, qualifiersFor, type GitHubClient } from './fetch';
import { rankCandidates, type RankStats } from './rank';
import { embed, rerank, type EncoderSpec } from './encoders';
import { preload } from './openai-local';
import { createLogger } from '@/lib/logger';
import { enrichReposBatch } from '@/lib/github/enrich';
import { deterministicScore } from '@/lib/scoring/deterministic';
import { clamp01, computeTotal } from '@/lib/scoring/rubric';
import { applyListwiseRanking, rankReposListwise } from '@/lib/llm/listwise';
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
  finalists: number;
  /** Run the local LLM pick; llmModelPath is null when the model is not downloaded. */
  llm: boolean;
  llmModelPath: string | null;
  llmTimeoutSeconds: number;
  llmIdleMinutes: number;
  /** Folder for the GitHub topic cache. */
  cacheDir: string;
}

/** What each stage did, for the tool's footer line and the eval. */
export interface SearchStats {
  queries: string[];
  topics: string[];
  pool: number;
  githubCalls: number;
  rank: Omit<RankStats, 'shortlist'> | null;
  llm: 'used' | 'off' | 'unavailable' | 'failed';
  llmDropped: number;
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
  const st: SearchStats = { queries: [], topics: [], pool: 0, githubCalls: 0, rank: null, llm: 'off', llmDropped: 0, seconds: {} };
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
    // The LLM loads (tens of seconds for a 4B model) while GitHub is searched.
    if (s.llm && s.llmModelPath) preload(s.llmModelPath);
    const client = github;

    // Stage 1: the queries (plus GitHub topics and "alternative to X" queries), then the pool.
    const terms = extractTerms(prompt);
    const [ref, topics] = await Promise.all([
      buildReferenceContext(prompt).catch(() => null),
      discoverTopics(terms.keywords, { need: prompt, filters, phrases: terms.phrases }, {
        client,
        embed: async (texts) => (await embed(s.embed, texts)).map((v) => Array.from(v)),
        cacheDir: s.cacheDir,
      }).catch(() => null),
    ]);
    st.topics = topics?.topics ?? [];
    st.queries = [...new Set([...(ref?.refQueries ?? []).map((q) => `${q} ${qualifiersFor(filters)}`), ...buildQueries(prompt, filters), ...(topics?.queries ?? [])])];
    const pool = await timed('fetch', () => fetchPool(st.queries, { poolSize: s.poolSize }, { client }));
    // An "alternative to X" search must not return X itself.
    const excluded = new Set(ref?.excludeFullNames ?? []);
    const candidates = pool.candidates.filter((c) => !excluded.has(c.fullName.toLowerCase()));
    st.pool = candidates.length;
    st.githubCalls = pool.calls + (topics?.calls ?? 0);
    log.info('Pool fetched', { queries: st.queries, topics: st.topics, pool: st.pool, calls: st.githubCalls, errors: pool.errors });

    // Stages 2-3: the embedding gate, then the cross-encoder on the shortlist, with README beginnings.
    await setJob(id, { stage: 'rank', progress: 30 });
    const { ranked, stats: rs } = await timed('rank', () =>
      rankCandidates(prompt, candidates, { ...s, includeSmallProjects: filters.includeSmallProjects, pushedWithinDays: filters.pushedWithinDays }, {
        embed: (texts) => embed(s.embed, texts),
        rerank: (q, docs) => rerank(s.rerank, q, docs),
        // README beginnings help some cross-encoders and hurt others (models.ts): 40 repos per GraphQL call, all at once.
        readmeHeads: !s.rerank.readme ? undefined : (names) => readmeHeads(names),
      }),
    );
    const { shortlist, ...rankStats } = rs;
    st.rank = rankStats;

    // Stage 4: evidence and health for the finalists, then the local LLM's listwise pick.
    await setJob(id, { stage: 'enrich', progress: 55 });
    const evidences = await timed('enrich', () => enrichReposBatch(ranked.map((r) => ({ candidate: r.candidate, similarity: r.rerankScore }))));
    const intent: Intent = {
      normalizedPrompt: prompt,
      queries: st.queries,
      constraints: {
        keywords: terms.keywords, requiredFeatures: [], aspects: [], language: filters.language ?? null, licenses: filters.license ?? [],
        pushedWithinDays: filters.pushedWithinDays ?? null, projectType: filters.projectType ?? 'any',
        includeSmallProjects: filters.includeSmallProjects === true, minStars: filters.minStars ?? null, maxStars: null,
      },
    };
    const baselines = evidences.map((e) => deterministicScore(intent, e));
    // Without the LLM, the cross-encoder is the best relevance signal, so it carries most of the fit score.
    let ordered: { evidence: RepoEvidence; analysis: Analysis }[] = evidences.map((evidence, i) => {
      const fit = clamp01(0.7 * ranked[i]!.rerankScore + 0.3 * baselines[i]!.fit);
      return { evidence, analysis: { ...baselines[i]!, fit, total: computeTotal(fit, baselines[i]!.future, baselines[i]!.underrated) } };
    });
    if (s.llm && evidences.length > 1) {
      await setJob(id, { stage: 'pick', progress: 70 });
      if (!s.llmModelPath) st.llm = 'unavailable';
      else {
        // openai-local.ts and upstream's listwise call read these per call.
        process.env.APPFORGE_LLM_MODEL_PATH = s.llmModelPath;
        process.env.APPFORGE_LLM_IDLE_MS = String(s.llmIdleMinutes * 60_000);
        process.env.LISTWISE_TIMEOUT_MS = String(s.llmTimeoutSeconds * 1000);
        const listwise = await timed('pick', () => rankReposListwise(intent, evidences, baselines).catch(() => null));
        if (listwise) {
          // A filter only: reordered by a 2-4B model the list scored lower than in the blend's order (0.57 vs 0.60),
          // so the LLM drops what it calls off-topic and adds its one-line reasons, and the order stays.
          const verdicts = new Map(applyListwiseRanking({ evidences, baselines, listwise }).map((p) => [p.evidence.candidate.fullName, p]));
          const kept = ordered.map((o) => verdicts.get(o.evidence.candidate.fullName) ?? o).filter((p) => p.analysis.relevant !== false);
          st.llmDropped = ordered.length - kept.length;
          ordered = kept;
          st.llm = 'used';
        } else st.llm = 'failed';
      }
    }

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

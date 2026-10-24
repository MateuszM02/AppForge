// Headless RepoRadar: AppForge's search pipeline (pipeline.ts) on top of upstream's modules (RepoRadar/upstream/src/lib)
// without Next.js or PostgreSQL. Bundled by scripts/build-reporadar.mjs into dist/reporadar/headless.mjs and loaded by
// RepoRadar/src/radar.ts, which sets process.env (GITHUB_TOKEN, the LLM switch, cache folders) before importing it.

import { env as transformersEnv } from '@huggingface/transformers';
import { prisma } from './prisma-shim';
import { runAppForgeSearch, searchStats, type SearchSettings } from './pipeline';
import { rerank, setModelsDir, type EncoderSpec } from './encoders';
import { extractTerms } from './fetch';
import { repoText } from './rank';
import { serializeResult } from '@/lib/api/serialize';
import { fetchCandidatesByName } from '@/lib/github/fetchRepos';
import { enrichRepo } from '@/lib/github/enrich';
import { octokit } from '@/lib/github/client';
import { deterministicScore } from '@/lib/scoring/deterministic';
import { heuristicIntent } from '@/lib/llm/intent';
import type { SearchFilters } from '@/lib/types';

if (process.env.APPFORGE_MODELS_DIR) {
  transformersEnv.cacheDir = process.env.APPFORGE_MODELS_DIR;
  setModelsDir(process.env.APPFORGE_MODELS_DIR);
}

export type { SearchFilters, SearchSettings };

/** Starts a search; resolves with its id at once. `done` settles when the pipeline finishes. */
export async function startSearch(prompt: string, filters: SearchFilters, settings: SearchSettings): Promise<{ id: string; done: Promise<void> }> {
  const query = (await prisma.searchQuery.create({ data: { rawPrompt: prompt, normalizedPrompt: prompt } })) as { id: string };
  await prisma.searchJob.create({ data: { searchQueryId: query.id, status: 'queued', progress: 0 } });
  const done = runAppForgeSearch(query.id, prompt, filters, settings).catch(async (e: unknown) => {
    await prisma.searchJob.updateMany({
      where: { searchQueryId: query.id },
      data: { status: 'failed', error: e instanceof Error ? e.message : String(e) },
    });
  });
  return { id: query.id, done };
}

/** Status and (when finished) ranked results of a search, in RepoRadar's API shape. */
export async function getSearch(id: string) {
  const job = (await prisma.searchJob.findFirst({ where: { searchQueryId: id }, orderBy: { createdAt: 'desc' } })) as Record<string, unknown> | null;
  if (!job) return null;
  const query = (await prisma.searchQuery.findUnique({ where: { id } })) as Record<string, unknown> | null;
  const results = (await prisma.searchResult.findMany({ where: { searchQueryId: id }, orderBy: { rank: 'asc' }, include: { repo: true } })) as unknown as Parameters<typeof serializeResult>[0][];
  return {
    searchId: id,
    status: job.status as string,
    stage: (job.stage as string | undefined) ?? null,
    progress: (job.progress as number | undefined) ?? 0,
    error: (job.error as string | undefined) ?? null,
    prompt: (query?.rawPrompt as string | undefined) ?? null,
    constraints: query?.extractedConstraints ?? null,
    results: results.map(serializeResult),
    stats: searchStats(id),
  };
}

/** Evidence and a deterministic health/risk assessment for one repository. */
export async function repoDetails(fullName: string, need?: string, rerankSpec?: EncoderSpec) {
  const [candidate] = await fetchCandidatesByName([fullName]);
  if (!candidate) return null;
  const evidence = await enrichRepo(candidate, 0);
  // fetchCandidatesByName leaves openIssues at 0 (search results get it from the search API instead). GitHub's
  // open_issues_count includes open pull requests, which enrichment counted separately.
  const { data } = await octokit.rest.repos.get({ owner: candidate.owner, repo: candidate.name });
  candidate.openIssues = Math.max(0, data.open_issues_count - evidence.openPRs);
  evidence.openIssues = candidate.openIssues;
  // The same relevance signal search results get: the profile's cross-encoder on the need and the repo.
  if (need && rerankSpec) {
    const text = rerankSpec.readme && evidence.readme ? `${repoText(candidate)}. ${evidence.readme.slice(0, 500)}` : repoText(candidate);
    [evidence.similarity] = await rerank(rerankSpec, need, [text]);
  }
  const intent = heuristicIntent(need || candidate.description || candidate.name);
  if (need) intent.constraints.keywords = extractTerms(need).keywords;
  const analysis = deterministicScore(intent, evidence);
  return { evidence, analysis };
}

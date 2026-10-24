// Stages 2 and 3 of repo_search: an embedding model drops junk from a large candidate pool, then a cross-encoder reads
// the need and each remaining repo together and keeps the best few for the LLM. The models are passed in
// (encoders.ts in the app, fakes in tests), so this file is plain ranking logic.

/** The fields ranking needs; upstream's Candidate type has all of them. */
export interface RankCandidate {
  fullName: string;
  description: string | null;
  topics: string[];
  stars: number;
  forks: number;
  pushedAt: string | null;
}

export interface RankSettings {
  /** Stage 2: drop candidates below this embedding similarity, and pass at most rerankPool (K) on. */
  minSimilarity: number;
  rerankPool: number;
  /** Stage 3: drop candidates below this cross-encoder score, and keep at most finalists (N). */
  minRerankScore: number;
  finalists: number;
  /** The user asked for small / little-known projects: no popularity prior. */
  includeSmallProjects?: boolean;
  pushedWithinDays?: number | null;
}

export interface RankDeps {
  /** Normalized embedding vectors. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Relevance in (0,1) of each doc to the query. */
  rerank(query: string, docs: string[]): Promise<number[]>;
  /** README beginnings by lowercase fullName (optional). */
  readmeHeads?(fullNames: string[]): Promise<Map<string, string>>;
}

export interface RankStats {
  pool: number;
  belowSimilarity: number;
  reranked: number;
  belowRerankScore: number;
  finalists: number;
  /** fullNames sent to the cross-encoder. */
  shortlist: string[];
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** What stage 2 embeds: short on purpose (name, description, topics), so even thousands of repos are quick. */
export function repoText(c: RankCandidate): string {
  return [c.fullName.replace('/', ' / '), (c.description ?? '').slice(0, 300), c.topics.slice(0, 10).join(' ')].filter(Boolean).join('. ');
}

// RepoRadar's funnel priors (upstream/src/lib/funnel/narrow.ts): log-star prominence, credibility (keeps 0-star repos
// down) and recency. Neutral when the user asked for small projects.
const prominence = (stars: number, small: boolean) => (small ? 0.8 : clamp01(Math.log10(Math.max(stars, 0) + 1) / 5));
const credibility = (stars: number, forks: number, small: boolean) => (small ? 1 : clamp01(Math.log10(Math.max(stars, 0) + 2 * Math.max(forks, 0) + 1) / 2.2));
function recency(pushedAt: string | null, within: number | null | undefined): number {
  const days = pushedAt ? (Date.now() - Date.parse(pushedAt)) / 86400_000 : Infinity;
  if (within) return days <= within ? 1 : 0.2;
  return days < 30 ? 1 : days < 90 ? 0.8 : days < 180 ? 0.6 : days < 365 ? 0.4 : 0.2;
}

export async function rankCandidates<C extends RankCandidate>(need: string, candidates: C[], s: RankSettings, deps: RankDeps) {
  const small = s.includeSmallProjects === true;
  const [queryVec, ...vecs] = await deps.embed([need, ...candidates.map(repoText)]);
  const passed = candidates.map((c, i) => ({ c, sim: vecs[i]!.reduce((d, x, k) => d + x * queryVec![k]!, 0) })).filter((x) => x.sim >= s.minSimilarity);
  // In a pool of thousands, pure similarity fills the shortlist with small repos named after the need's words
  // ("habit-tracker" x 60) and pushes out the established projects. So two thirds of the K slots go by similarity
  // blended with the popularity priors, and one third to the most-starred repos above the floor.
  const blend = (x: (typeof passed)[number]) => 0.65 * x.sim + 0.2 * prominence(x.c.stars, small) + 0.15 * credibility(x.c.stars, x.c.forks, small);
  passed.sort((a, b) => blend(b) - blend(a));
  const nBlend = s.rerankPool - Math.floor(s.rerankPool / 3);
  const rest = passed.slice(nBlend);
  if (!small) rest.sort((a, b) => b.c.stars - a.c.stars);
  const shortlist = [...passed.slice(0, nBlend), ...rest.slice(0, s.rerankPool - nBlend)];

  const heads = (await deps.readmeHeads?.(shortlist.map((x) => x.c.fullName)).catch(() => null)) ?? new Map<string, string>();
  const docs = shortlist.map((x) => {
    const head = heads.get(x.c.fullName.toLowerCase());
    return head ? `${repoText(x.c)}. ${head.slice(0, 500)}` : repoText(x.c);
  });
  const ce = await deps.rerank(need, docs);
  const ranked = shortlist
    .map((x, i) => ({ candidate: x.c, similarity: x.sim, rerankScore: ce[i] ?? 0 }))
    .filter((r) => r.rerankScore >= s.minRerankScore)
    // Weights measured on tests/search-gold.json: a cross-encoder alone over-rates small keyword-perfect repos, so
    // prominence carries half the score (RepoRadar's funnel uses 0.6 / 0.2 / 0.12 / 0.08; this scored 0.53 vs 0.37).
    .map((r) => ({ ...r, score: 0.35 * r.rerankScore + 0.5 * prominence(r.candidate.stars, small) + 0.1 * credibility(r.candidate.stars, r.candidate.forks, small) + 0.05 * recency(r.candidate.pushedAt, s.pushedWithinDays) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, s.finalists);
  const stats: RankStats = {
    pool: candidates.length,
    belowSimilarity: candidates.length - passed.length,
    reranked: shortlist.length,
    belowRerankScore: shortlist.filter((_, i) => (ce[i] ?? 0) < s.minRerankScore).length,
    finalists: ranked.length,
    shortlist: shortlist.map((x) => x.c.fullName),
  };
  return { ranked, stats };
}

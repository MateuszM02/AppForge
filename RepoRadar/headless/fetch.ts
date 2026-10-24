// Stage 1 of repo_search: a wide GitHub fetch with no LLM. The need becomes 6-12 search queries (stoplist, light
// stemming, format synonyms, "X to Y" phrases, filter qualifiers), GitHub topics close to the need add `topic:`
// queries, and the queries are paged through GraphQL search, breadth first, into a pool of up to a few thousand repos.
// The GitHub client and the embedding are passed in, so tsc builds this file as well as the RepoRadar bundler.

import fs from 'node:fs';
import path from 'node:path';
import type { Candidate, SearchFilters } from '../upstream/src/lib/types.js';

/** The part of an Octokit instance used here. */
export interface GitHubClient {
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
  request(route: string, params?: Record<string, unknown>): Promise<{ data: unknown }>;
}

const words = (s: string) => new Set(s.split(' '));
const STOPWORDS = words(
  'a an and are as at be but by can do for from has have how i if in into is it its me my need no not of on or our ' +
    'please should so some that the this to up use using want we what which with would you your also any best good ' +
    'great new looking recommend suggest alternative alternatives open source opensource github repo repository project',
);
/** Words that describe every repository; searching on them only adds noise ("app", "converts"). */
const GENERIC = words(
  'app application tool software program utility service platform solution system convert converts converter ' +
    'conversion find get simple easy free way something file files document documents data basic small lightweight fast ' +
    'modern powerful awesome working support',
);
/** Platforms and languages narrow a search but never say what a repository does, so they never anchor one. */
const MODIFIERS = words('cli gui web desktop mobile android ios linux windows macos self-hosted local cloud api plugin extension browser server python javascript typescript java go rust');
/** Other spellings GitHub repositories use; the first is the most common. */
const SYNONYMS: Record<string, string[]> = {
  txt: ['text', 'txt'], text: ['text', 'txt'], word: ['docx', 'word'], doc: ['docx', 'doc'], excel: ['xlsx', 'excel'],
  xls: ['xlsx', 'xls'], powerpoint: ['pptx', 'powerpoint'], ppt: ['pptx', 'ppt'], image: ['image', 'png'], photo: ['photo', 'image'],
  jpeg: ['jpg', 'jpeg'], video: ['video', 'mp4'], movie: ['video', 'movie'], audio: ['audio', 'mp3'], music: ['music', 'audio'],
  ebook: ['ebook', 'epub'], md: ['markdown'], email: ['email', 'mail'], k8s: ['kubernetes'], db: ['database'], todo: ['todo', 'task'],
  scraping: ['scraper', 'scraping'], scraper: ['scraper', 'scraping'],
};

/** Plural to singular ("trackers" -> "tracker"), the only change made to words that go into queries. */
function singular(w: string): string {
  if (w.length <= 3 || /(ss|us|is|os|ows)$/.test(w) || w === 'kubernetes') return w;
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (/(sses|xes|ches|shes)$/.test(w)) return w.slice(0, -2);
  return w.endsWith('s') ? w.slice(0, -1) : w;
}

const isContent = (t: string) => t !== '|' && t.length > 1 && !STOPWORDS.has(t) && !GENERIC.has(t) && !GENERIC.has(singular(t));

export interface NeedTerms {
  /** One spelling list per concept, most specific first (platforms and languages last). */
  concepts: string[][];
  /** The preferred spelling of each concept, e.g. ["pdf", "text", "docx"]. */
  keywords: string[];
  /** Phrases to match whole: "pdf to text", "pdf converter", "markdown editor". */
  phrases: string[];
  /** Repository-name forms such as pdf2docx. */
  names: string[];
}

export function extractTerms(need: string): NeedTerms {
  // "txt/word", "a, b" and "a or b" are lists: a separator token keeps their words apart.
  const tokens = (need.toLowerCase().replace(/[/,;&]+|\bor\b|\band\b/g, ' | ').match(/[\p{L}\p{N}+#.-]+|\|/gu) ?? [])
    .map((t) => (t === '|' ? t : singular(t.replace(/^[.-]+|[.-]+$/g, ''))))
    .filter(Boolean);
  const concepts = new Map<string, string[]>();
  for (const t of tokens) if (isContent(t) && ![...concepts.values()].some((alts) => alts.includes(t))) concepts.set(t, SYNONYMS[t] ?? [t]);
  const alts = (t: string) => concepts.get(t) ?? [t];
  const phrases = new Set<string>();
  const names = new Set<string>();
  const converts = /\bconver(t|ts|ter|sion)\b/.test(need.toLowerCase());
  tokens.forEach((t, i) => {
    // "X to Y[/Z]": a conversion, which repositories name "X to Y", "X converter" or "x2y".
    if ((t === 'to' || t === 'into') && i > 0 && isContent(tokens[i - 1]!)) {
      const from = alts(tokens[i - 1]!)[0]!;
      for (let j = i + 1; j < tokens.length && (tokens[j] === '|' || isContent(tokens[j]!)); j++) {
        if (tokens[j] === '|') continue;
        for (const to of alts(tokens[j]!)) {
          phrases.add(`${from} to ${to}`);
          if (from.length <= 6 && to.length <= 6) names.add(`${from}2${to}`);
        }
        if (tokens[j + 1] !== '|') break;
      }
      if (converts) phrases.add(`${from} converter`);
    }
    const next = tokens[i + 1];
    if (next && isContent(t) && isContent(next) && t !== next) phrases.add(`${t} ${next}`);
  });
  const ranked = [...concepts.entries()].sort(([a], [b]) => Number(MODIFIERS.has(a)) - Number(MODIFIERS.has(b))).map(([, v]) => v);
  return { concepts: ranked, keywords: ranked.map((c) => c[0]!), phrases: [...phrases], names: [...names] };
}

/** Search qualifiers for the tool's filters (repeated license: qualifiers are OR-ed by GitHub). */
export function qualifiersFor(f: SearchFilters = {}, now = new Date()): string {
  const q = ['archived:false'];
  if (f.language) q.push(`language:"${f.language.trim().toLowerCase()}"`);
  for (const l of f.license ?? []) q.push(`license:${l.trim().toLowerCase()}`);
  if (f.minStars) q.push(`stars:>=${Math.floor(f.minStars)}`);
  if (f.pushedWithinDays) q.push(`pushed:>=${new Date(now.getTime() - f.pushedWithinDays * 86_400_000).toISOString().slice(0, 10)}`);
  return q.join(' ');
}

/** GitHub allows at most five boolean operators in one search, so OR-lists hold six terms. */
const or = (terms: string[]) => terms.slice(0, 6).join(' OR ');

/** About 6-12 queries, highest signal first, each with the filter qualifiers; empty when no searchable word is left. */
export function buildQueries(need: string, filters: SearchFilters = {}): string[] {
  const { concepts, phrases, names } = extractTerms(need);
  if (!concepts.length) return [];
  const [anchor, ...others] = concepts as [string[], ...string[][]];
  const raw = [
    phrases.length ? or(phrases.map((p) => `"${p}"`)) : '',
    phrases.length > 6 ? or(phrases.slice(6).map((p) => `"${p}"`)) : '',
    names.length ? or(names) : '',
    others.length > 1 ? [anchor[0], ...others.slice(0, 2).map((c) => c[0])].join(' ') : '',
    others.length ? `${anchor[0]} ${others[0]![0]}` : or(anchor),
    // Most starred first: well-known projects whose description skips the details.
    `${or(anchor)} sort:stars`,
    others.length ? `${anchor[0]} ${others[0]![0]} sort:stars` : '',
    ...others.flatMap((o) => o.slice(0, 2).map((alt) => `${anchor[0]} ${alt}`)),
  ];
  const qualifiers = qualifiersFor(filters);
  return [...new Set(raw.filter(Boolean))].slice(0, 12).map((q) => `${q} ${qualifiers}`);
}

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0) / (Math.hypot(...a) * Math.hypot(...b) || 1);

/**
 * GitHub topics close to the need (`/search/topics` per keyword, cached for a week in cacheDir), scored with the
 * embedding of their name and description. The close ones become `topic:` queries; one that only repeats a keyword
 * (topic:pdf) is paired with another keyword, since alone it is too wide.
 */
export async function discoverTopics(
  keywords: string[],
  o: { need: string; filters?: SearchFilters; phrases?: string[] },
  deps: { client: GitHubClient; embed: (texts: string[]) => Promise<number[][]>; cacheDir: string },
): Promise<{ topics: string[]; queries: string[]; calls: number }> {
  const file = path.join(deps.cacheDir, 'github-topics.json');
  let cache: Record<string, { at: number; topics: { name: string; text: string }[] }> = {};
  try {
    cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* first run */
  }
  const due = keywords.slice(0, 4).filter((k) => !cache[k] || Date.now() - cache[k].at > 7 * 86_400_000);
  const calls = due.length;
  await Promise.all(due.map(async (k) => {
    const { data } = await deps.client.request('GET /search/topics', { q: k, per_page: 30 }).catch(() => ({ data: { items: [] } }));
    const items = (data as { items?: { name: string; display_name?: string | null; short_description?: string | null }[] }).items ?? [];
    cache[k] = { at: Date.now(), topics: items.map((t) => ({ name: t.name, text: [t.display_name ?? t.name.replace(/-/g, ' '), t.short_description].filter(Boolean).join(': ') })) };
  }));
  if (calls) {
    fs.mkdirSync(deps.cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache));
  }
  const found = [...new Map(keywords.flatMap((k) => cache[k]?.topics ?? []).map((t) => [t.name, t])).values()];
  if (!found.length) return { topics: [], queries: [], calls };
  const [needVec, ...vecs] = await deps.embed([o.need, ...found.map((t) => t.text)]);
  const scored = found.map((t, i) => ({ name: t.name, score: cosine(needVec!, vecs[i]!) })).sort((a, b) => b.score - a.score);
  // A topic spelled like one of the need's phrases (note-taking) is what the user said, so it is always kept.
  const slugs = new Set((o.phrases ?? []).map((p) => p.replace(/\s+/g, '-')));
  const floor = Math.max(0.4, scored[0]!.score - 0.15);
  const topics = scored.filter((t) => slugs.has(t.name) || t.score >= floor).slice(0, 5).map((t) => t.name);
  const qualifiers = qualifiersFor(o.filters);
  const queries = topics.flatMap((t) => {
    const others = keywords.filter((k) => !t.includes(k));
    return keywords.includes(t) && others.length ? others.slice(0, 2).map((k) => `topic:${t} ${k}`) : [`topic:${t}`];
  });
  return { topics, queries: [...new Set(queries)].map((q) => `${q} ${qualifiers}`), calls };
}

const SEARCH = `query($q: String!, $after: String) {
  search(query: $q, type: REPOSITORY, first: 100, after: $after) {
    repositoryCount
    nodes { ... on Repository {
      databaseId nameWithOwner description url stargazerCount forkCount pushedAt createdAt updatedAt isArchived isFork
      primaryLanguage { name } licenseInfo { spdxId } repositoryTopics(first: 10) { nodes { topic { name } } }
    } }
  }
}`;

type Node = { databaseId: number; nameWithOwner: string; description: string | null; url: string; stargazerCount: number; forkCount: number; pushedAt: string | null; createdAt: string | null; updatedAt: string | null; isArchived: boolean; isFork: boolean; primaryLanguage: { name: string } | null; licenseInfo: { spdxId: string | null } | null; repositoryTopics: { nodes: { topic: { name: string } }[] } };

// Upstream's Candidate; GraphQL search has no open-issue count here (0, as in upstream's fetchCandidatesByName).
const toCandidate = (n: Node): Candidate => ({
  githubId: n.databaseId, fullName: n.nameWithOwner, owner: n.nameWithOwner.split('/')[0]!, name: n.nameWithOwner.split('/')[1]!,
  htmlUrl: n.url, description: n.description, primaryLanguage: n.primaryLanguage?.name ?? null, licenseSpdx: n.licenseInfo?.spdxId ?? null,
  topics: n.repositoryTopics.nodes.map((t) => t.topic.name), isArchived: n.isArchived, isFork: n.isFork, stars: n.stargazerCount,
  forks: n.forkCount, openIssues: 0, watchers: n.stargazerCount, createdAt: n.createdAt, updatedAt: n.updatedAt, pushedAt: n.pushedAt,
});

// GitHub's search cursors are an encoded offset ("cursor:100" in base64): undocumented, but it lets every page of a
// query be requested at once instead of one after another (each call takes 3-6 s). If that ever stops working, those
// pages fail and are skipped, and the pool is just smaller.
const cursorAt = (offset: number) => (offset ? Buffer.from(`cursor:${offset}`).toString('base64') : null);

/**
 * Fetches the queries through GraphQL search (100 repos per call, at most 1,000 per query) in two parallel rounds: the
 * first page of every query, then all the further pages needed for `poolSize`, lowest pages first. Archived repos
 * and forks are dropped. The pool is ordered by page, then query, so it does not depend on which call returned first.
 */
export async function fetchPool(queries: string[], o: { poolSize: number; concurrency?: number }, deps: { client: GitHubClient }) {
  const started = Date.now();
  const pages: Candidate[][][] = queries.map(() => []);
  const totals = queries.map(() => 0);
  const errors: string[] = [];
  let calls = 0;
  const get = async (i: number, page: number) => {
    calls++;
    try {
      const r = await deps.client.graphql<{ search: { repositoryCount: number; nodes: Node[] } }>(SEARCH, { q: queries[i], after: cursorAt(page * 100) });
      pages[i]![page] = r.search.nodes.filter((n) => n?.nameWithOwner && !n.isArchived && !n.isFork).map(toCandidate);
      if (page === 0) totals[i] = Math.min(r.search.repositoryCount ?? 0, 1000);
    } catch (e) {
      errors.push(`${queries[i]} (page ${page + 1}): ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const limit = o.concurrency ?? 30;
  const runAll = async (jobs: [number, number][]) => {
    for (let k = 0; k < jobs.length; k += limit) await Promise.all(jobs.slice(k, k + limit).map(([i, p]) => get(i, p)));
  };
  await runAll(queries.map((_, i) => [i, 0]));
  // Further pages, breadth first, until the results (duplicates across queries counted, about a third) cover the pool.
  const more: [number, number][] = [];
  let expected = pages.reduce((t, p) => t + (p[0]?.length ?? 0), 0);
  for (let page = 1; page < 10 && expected < o.poolSize * 1.5; page++) {
    for (let i = 0; i < queries.length && expected < o.poolSize * 1.5; i++) {
      if (totals[i]! > page * 100) {
        more.push([i, page]);
        expected += Math.min(100, totals[i]! - page * 100);
      }
    }
  }
  await runAll(more);
  const pool = new Map<string, Candidate>();
  for (let page = 0; page < 10; page++) for (const q of pages) for (const c of q[page] ?? []) if (!pool.has(c.fullName.toLowerCase())) pool.set(c.fullName.toLowerCase(), c);
  return { candidates: [...pool.values()].slice(0, o.poolSize), calls, errors, seconds: (Date.now() - started) / 1000 };
}

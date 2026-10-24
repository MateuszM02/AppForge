// Stage 1 of AppForge's repo_search: a wide GitHub candidate fetch with no LLM. The need is turned into 6-12
// GitHub search queries (stoplist, light stemming, phrases, format synonyms, OR-groups, filter qualifiers), close
// GitHub topics are found with an embedding, and the queries are paged through GraphQL search into a pool of
// 1,000-3,000 candidates in upstream's Candidate shape. Later stages (embedding gate, rerank, LLM pick) narrow it.
// The GitHub client and the embedding function are passed in, so this file has no "@/..." imports and is built by
// tsc as well as the RepoRadar bundler.

import fs from 'node:fs';
import path from 'node:path';
import type { Candidate, SearchFilters } from '../upstream/src/lib/types.js';

/** The part of an Octokit instance this file uses (`octokit.graphql`, `octokit.request`). */
export interface GitHubClient {
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
  request(route: string, params?: Record<string, unknown>): Promise<{ data: unknown }>;
}

/** Embeds texts into vectors (e.g. RepoRadar's `embedMany`). */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

// ---------------------------------------------------------------------------------------------------------------
// Query building

/** Names that end in "s" without being plurals (declared first: the word sets below are stemmed at load). */
const NOT_PLURAL = new Set('postgres kubernetes windows macos ios express news analytics physics graphics jenkins series'.split(' '));

const STOPWORDS = new Set(
  ('a an and are as at be been but by can could do does for from had has have how i if in into is it its just ' +
    'let like lot make makes many may me might more most much my need needs no not of on one or our out over ' +
    'please should so some than that the their them then there these they this those through to too up us use ' +
    'used uses using want wants was we well what when where which while who why will with without would you your ' +
    'also any anything every other only own same such very via within able best good great new nice quick ' +
    'looking look recommend recommendation suggest suggestion alternative alternatives help helps open source ' +
    'opensource github repo repository project library')
    .split(' '),
);

/** Words that describe every repository; matching on them only adds noise. Compared after stemming. */
const GENERIC = new Set(
  ('app application tool tooling software program utility util service platform solution system thing stuff ' +
    'convert converter conversion find get simple easy free way something file document data online offline ' +
    'basic small lightweight light fast modern powerful cool awesome working work run runs support supports ' +
    'kind type sort lets allow allows able do doing done heavy based')
    .split(' ')
    .map(stem),
);

/** Verbs that are worth searching for but make a poor anchor term. Compared after stemming. */
const VERBS = new Set(
  ('extract parse edit manage create generate build track search read write view merge split compress sync ' +
    'backup download upload monitor translate transcribe record share host deploy analyze analyse ' +
    'visualize render format clean organize schedule automate test lint check send receive store play watch ' +
    'migrate import export scan')
    .split(' ')
    .map(stem),
);

/** Platforms and languages: they narrow a search but never say what the repository does. */
const MODIFIERS = new Set(
  ('cli gui tui web webapp desktop mobile android ios linux windows macos mac cross-platform self-hosted selfhosted ' +
    'local cloud command-line terminal console api sdk framework plugin extension browser server client ' +
    'python javascript typescript java go golang rust ruby php c c++ c# kotlin swift node nodejs dotnet scala ' +
    'elixir haskell lua perl dart r julia bash shell powershell')
    .split(' '),
);

/** Hyphenated words that are one term; any other hyphenated word is split ("javascript-heavy"). */
const COMPOUNDS = new Set(
  ('self-hosted cross-platform command-line open-source real-time end-to-end text-to-speech speech-to-text ' +
    'e-mail e-book peer-to-peer')
    .split(' '),
);

/** Common spellings of the same thing: the first entry is the one GitHub repositories use most. */
const SYNONYMS: Record<string, string[]> = {
  txt: ['text', 'txt'],
  text: ['text', 'txt'],
  word: ['docx', 'word', 'doc'],
  doc: ['docx', 'doc'],
  docx: ['docx', 'word'],
  msword: ['docx', 'word'],
  excel: ['xlsx', 'excel', 'spreadsheet'],
  xls: ['xlsx', 'xls', 'excel'],
  xlsx: ['xlsx', 'excel'],
  spreadsheet: ['spreadsheet', 'xlsx'],
  powerpoint: ['pptx', 'powerpoint', 'slides'],
  ppt: ['pptx', 'ppt'],
  pptx: ['pptx', 'powerpoint'],
  image: ['image', 'png', 'jpg'],
  picture: ['image', 'picture'],
  photo: ['photo', 'image'],
  img: ['image', 'img'],
  jpeg: ['jpg', 'jpeg'],
  jpg: ['jpg', 'jpeg'],
  video: ['video', 'mp4'],
  movie: ['video', 'movie'],
  audio: ['audio', 'mp3', 'wav'],
  sound: ['audio', 'sound'],
  music: ['music', 'audio'],
  ebook: ['ebook', 'epub'],
  epub: ['epub', 'ebook'],
  md: ['markdown'],
  email: ['email', 'mail'],
  'e-mail': ['email', 'mail'],
  js: ['javascript', 'js'],
  ts: ['typescript', 'ts'],
  py: ['python', 'py'],
  golang: ['go', 'golang'],
  k8s: ['kubernetes', 'k8s'],
  db: ['database', 'db'],
  tts: ['tts', 'text-to-speech'],
  stt: ['speech-to-text', 'stt'],
  todo: ['todo', 'task'],
  scraping: ['scraping', 'scraper', 'crawler'],
  scraper: ['scraper', 'scraping', 'crawler'],
  crawler: ['crawler', 'scraper'],
};

/** Light stemming, used to compare words: plurals and -ing/-ed forms map to one key. */
export function stem(word: string): string {
  let w = singular(word);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('er') && !w.endsWith('eer')) w = w.slice(0, -2);
  if (/([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|zz)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** Plural to singular, the only change made to words that go into queries. */
function singular(w: string): string {
  if (w.length <= 3 || NOT_PLURAL.has(w)) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('sses') || w.endsWith('xes') || w.endsWith('ches') || w.endsWith('shes')) return w.slice(0, -2);
  if (w.endsWith('s') && !/(ss|us|is|os)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** List separators ("txt/word", "a, b", "a or b") keep words apart and continue a "to ..." list. */
const SEPARATOR = '|';

function tokenize(need: string): string[] {
  const spaced = need.toLowerCase().replace(/[/,;&]+|\bor\b|\band\b/g, ` ${SEPARATOR} `);
  return (spaced.match(/[\p{L}\p{N}+#.-]+|\|/gu) ?? [])
    .map((t) => (t === SEPARATOR ? t : t.replace(/^[.-]+|[.-]+$/g, '')))
    .flatMap((t) => (t.includes('-') && !COMPOUNDS.has(t) ? t.split('-') : [t]))
    .filter(Boolean);
}

function isContent(token: string): boolean {
  if (token === SEPARATOR || token.length < 2 && !/\d/.test(token)) return false;
  return !STOPWORDS.has(token) && !GENERIC.has(stem(token));
}

export interface NeedTerms {
  /** One entry per concept, most specific first: its alternative spellings, preferred first. */
  concepts: string[][];
  /** The preferred spelling of each concept, e.g. ["pdf", "text", "docx"]. */
  keywords: string[];
  /** Quoted phrases worth matching as a whole, e.g. "pdf to text", "pdf converter". */
  phrases: string[];
  /** Repository-name forms such as pdf2docx. */
  names: string[];
}

/** Splits a need into the concepts, phrases and repository-name forms that the queries are built from. */
export function extractTerms(need: string): NeedTerms {
  const tokens = tokenize(need);
  // Words written with capitals after the first word are names and acronyms (PDF, OCR, MySQL): the most specific.
  const named = new Set(
    (need.match(/[\p{L}\p{N}+#.-]+/gu) ?? []).slice(1).filter((w) => /\p{Lu}/u.test(w)).map((w) => w.toLowerCase()),
  );
  const concepts: { alts: string[]; score: number; order: number }[] = [];
  const seen = new Map<string, (typeof concepts)[number]>();
  const conceptOf = (token: string) => {
    const key = stem(token);
    let concept = seen.get(key);
    if (!concept) {
      const word = singular(token);
      const alts = SYNONYMS[token] ?? SYNONYMS[word] ?? [word];
      const score = (MODIFIERS.has(token) ? -10 : 0) + (VERBS.has(key) ? -5 : 0) + (named.has(token) ? 3 : 0);
      concept = { alts, score, order: concepts.length };
      concepts.push(concept);
      for (const alt of alts) if (!seen.has(stem(alt))) seen.set(stem(alt), concept);
      seen.set(key, concept);
    }
    return concept;
  };
  for (const token of tokens) if (isContent(token)) conceptOf(token);

  const phrases: string[] = [];
  const names: string[] = [];
  const addPhrase = (p: string) => {
    if (!phrases.includes(p)) phrases.push(p);
  };
  const converts = tokens.some((t) => stem(t) === 'convert' || stem(t) === 'conversion');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    // "X to Y[/Z]" and "X into Y": a conversion between two things.
    if ((token === 'to' || token === 'into') && i > 0 && isContent(tokens[i - 1]!)) {
      const source = conceptOf(tokens[i - 1]!);
      source.score += 2;
      const from = source.alts[0]!;
      const targets: string[][] = [];
      for (let j = i + 1; j < tokens.length; j++) {
        const t = tokens[j]!;
        if (t === SEPARATOR) continue;
        if (!isContent(t)) break;
        targets.push(conceptOf(t).alts);
        if (tokens[j + 1] !== SEPARATOR) break;
      }
      for (const alts of targets) {
        for (const alt of alts) {
          addPhrase(`${from} to ${alt}`);
          // Short format names make repository names: pdf2docx, md2pdf.
          if (from.length <= 6 && alt.length <= 6 && !/[\s-]/.test(alt)) names.push(`${from}2${alt}`);
        }
      }
      if (converts) addPhrase(`${from} converter`);
    }
    // Two content words next to each other: "markdown editor", "note taking".
    const next = tokens[i + 1];
    if (next && isContent(token) && isContent(next) && stem(token) !== stem(next)) {
      addPhrase(`${singular(token)} ${singular(next)}`);
    }
  }
  const ranked = [...concepts].sort((a, b) => b.score - a.score || a.order - b.order).map((c) => c.alts);
  if (converts && !phrases.some((p) => p.endsWith(' converter')) && ranked.length) addPhrase(`${ranked[0]![0]} converter`);
  return { concepts: ranked, keywords: ranked.map((c) => c[0]!), phrases, names: [...new Set(names)] };
}

/** GitHub allows at most five AND/OR/NOT operators in one search. */
const MAX_OR_TERMS = 6;

function orGroups(terms: string[]): string[] {
  const groups: string[] = [];
  for (let i = 0; i < terms.length; i += MAX_OR_TERMS) groups.push(terms.slice(i, i + MAX_OR_TERMS).join(' OR '));
  return groups;
}

const quote = (s: string) => `"${s}"`;

/** The search qualifiers for the UI/tool filters. Repeated `license:`/`language:` qualifiers are OR-ed by GitHub. */
export function qualifiersFor(filters: SearchFilters = {}, now: Date = new Date()): string {
  const parts = ['archived:false'];
  if (filters.language) {
    const lang = filters.language.trim().toLowerCase();
    parts.push(`language:${/\s/.test(lang) ? quote(lang) : lang}`);
  }
  for (const licence of filters.license ?? []) if (licence.trim()) parts.push(`license:${licence.trim().toLowerCase()}`);
  if (filters.minStars && filters.minStars > 0) parts.push(`stars:>=${Math.floor(filters.minStars)}`);
  if (filters.pushedWithinDays && filters.pushedWithinDays > 0) {
    const since = new Date(now.getTime() - filters.pushedWithinDays * 86_400_000);
    parts.push(`pushed:>=${since.toISOString().slice(0, 10)}`);
  }
  return parts.join(' ');
}

export interface BuildQueriesOptions {
  /** Upper bound on the number of queries (default 12). */
  maxQueries?: number;
  /** "Now" for `pushedWithinDays` (tests). */
  now?: Date;
}

/**
 * About 6-12 GitHub repository-search queries for a need, highest signal first, each carrying the filter
 * qualifiers. Empty when the need has no searchable words left after the stoplist.
 */
export function buildQueries(need: string, filters: SearchFilters = {}, options: BuildQueriesOptions = {}): string[] {
  const { concepts, phrases, names } = extractTerms(need);
  if (!concepts.length) return [];
  // The most specific concept anchors the queries; the others are paired with it.
  const [anchor, ...others] = concepts as [string[], ...string[][]];
  const raw: string[] = [];

  // Whole phrases ("pdf to text" OR "pdf to docx" ...) and repository names (pdf2docx OR pdf2txt ...).
  raw.push(...orGroups(phrases.map(quote)).slice(0, 2));
  raw.push(...orGroups(names).slice(0, 1));
  // The top concepts at once (more than three rarely match anything), and the anchor with the next one.
  if (others.length > 1) raw.push([anchor[0], ...others.slice(0, 2).map((c) => c[0])].join(' '));
  if (others.length) raw.push(`${anchor[0]} ${others[0]![0]}`);
  // The anchor alone (most starred first): well-known projects whose description skips the details.
  if (!others.length) raw.push(orGroups(anchor)[0]!);
  raw.push(`${orGroups(anchor)[0]} sort:stars`);
  if (others.length) raw.push(`${anchor[0]} ${others[0]![0]} sort:stars`);
  // The anchor with each spelling of each other concept.
  for (const other of others) for (const alt of other.slice(0, 2)) raw.push(`${anchor[0]} ${alt}`);

  const qualifiers = qualifiersFor(filters, options.now);
  const queries = [...new Set(raw.filter(Boolean))].map((q) => `${q} ${qualifiers}`);
  return queries.slice(0, options.maxQueries ?? 12);
}

// ---------------------------------------------------------------------------------------------------------------
// Topic discovery

export interface TopicInfo {
  name: string;
  displayName: string | null;
  shortDescription: string | null;
}

interface TopicCacheFile {
  [keyword: string]: { fetchedAt: number; topics: TopicInfo[] };
}

const TOPIC_CACHE_FILE = 'github-topics.json';
const TOPIC_CACHE_TTL_MS = 7 * 86_400_000;

export interface DiscoverTopicsOptions {
  /** The user's need; each topic is scored against it. */
  need: string;
  filters?: SearchFilters;
  /** The need's phrases (from extractTerms); a topic with the same spelling is kept whatever its score. */
  phrases?: string[];
  /** Topics kept (default 5). */
  maxTopics?: number;
  /** Lowest cosine similarity a topic needs (default 0.4). */
  minScore?: number;
  /** Topics kept are also within this distance of the best one (default 0.15). */
  maxGap?: number;
  now?: Date;
}

export interface DiscoverTopicsDeps {
  client: GitHubClient;
  embed: EmbedFn;
  /** Folder for the week-long topic cache (user data, never the code folder or the cwd). */
  cacheDir: string;
}

export interface DiscoverTopicsResult {
  topics: { name: string; keyword: string; score: number }[];
  /** `topic:` queries with the filter qualifiers. */
  queries: string[];
  /** GitHub calls made (keywords not served from the cache). */
  calls: number;
  cacheHits: number;
}

function readTopicCache(file: string): TopicCacheFile {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as TopicCacheFile;
  } catch {
    return {};
  }
}

/**
 * Finds GitHub topics close to the need: `/search/topics` per keyword (cached for a week), each topic scored by the
 * embedding of its name and short description against the need. The close ones become `topic:` queries.
 */
export async function discoverTopics(
  keywords: string[],
  options: DiscoverTopicsOptions,
  deps: DiscoverTopicsDeps,
): Promise<DiscoverTopicsResult> {
  const now = (options.now ?? new Date()).getTime();
  const file = path.join(deps.cacheDir, TOPIC_CACHE_FILE);
  const cache = readTopicCache(file);
  let calls = 0;
  let cacheHits = 0;
  let dirty = false;

  const byName = new Map<string, { topic: TopicInfo; keyword: string }>();
  for (const keyword of [...new Set(keywords.map((k) => k.toLowerCase()))]) {
    let entry = cache[keyword];
    if (entry && now - entry.fetchedAt < TOPIC_CACHE_TTL_MS) {
      cacheHits++;
    } else {
      calls++;
      try {
        const { data } = await deps.client.request('GET /search/topics', { q: keyword, per_page: 30 });
        const items = ((data as { items?: Record<string, unknown>[] }).items ?? []).map((t) => ({
          name: String(t.name),
          displayName: (t.display_name as string | null) ?? null,
          shortDescription: (t.short_description as string | null) ?? null,
        }));
        entry = { fetchedAt: now, topics: items };
        cache[keyword] = entry;
        dirty = true;
      } catch {
        continue;
      }
    }
    for (const topic of entry.topics) if (!byName.has(topic.name)) byName.set(topic.name, { topic, keyword });
  }
  if (dirty) {
    try {
      fs.mkdirSync(deps.cacheDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(cache));
    } catch {
      // A cache that cannot be written only costs a GitHub call next time.
    }
  }

  const found = [...byName.values()];
  if (!found.length) return { topics: [], queries: [], calls, cacheHits };
  const texts = found.map(({ topic }) => {
    const label = topic.displayName && topic.displayName.toLowerCase() !== topic.name ? topic.displayName : topic.name.replace(/-/g, ' ');
    return topic.shortDescription ? `${label}: ${topic.shortDescription}` : label;
  });
  const [needVec, ...topicVecs] = await deps.embed([options.need, ...texts]);
  const scored = found
    .map((f, i) => ({ name: f.topic.name, keyword: f.keyword, score: cosine(needVec!, topicVecs[i]!) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0]?.score ?? 0;
  const minScore = Math.max(options.minScore ?? 0.4, best - (options.maxGap ?? 0.15));
  // A topic spelled like one of the need's phrases (note-taking, web-scraping) is what the user said: always kept.
  const slugs = new Set((options.phrases ?? []).map((p) => p.toLowerCase().trim().replace(/\s+/g, '-')));
  const exact = scored.filter((t) => slugs.has(t.name));
  const close = scored.filter((t) => !slugs.has(t.name) && t.score >= minScore);
  const topics = [...exact, ...close].slice(0, Math.max(options.maxTopics ?? 5, exact.length));

  // A topic that is just one of the keywords (topic:pdf) is too wide alone; pair it with the other keywords.
  const qualifiers = qualifiersFor(options.filters, options.now);
  const raw: string[] = [];
  for (const t of topics) {
    const others = keywords.filter((k) => stem(k) !== stem(t.name) && !t.name.includes(k.toLowerCase()));
    if (keywords.some((k) => stem(k) === stem(t.name)) && others.length) {
      for (const other of others.slice(0, 2)) raw.push(`topic:${t.name} ${other}`);
    } else {
      raw.push(`topic:${t.name}`);
    }
  }
  return { topics, queries: [...new Set(raw)].map((q) => `${q} ${qualifiers}`), calls, cacheHits };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Pool fetch

const PAGE_SIZE = 100;
/** GitHub search never returns more than 1,000 results for one query. */
const SEARCH_RESULT_CAP = 1000;

const SEARCH_GRAPHQL = `query($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: REPOSITORY, first: $first, after: $after) {
    repositoryCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Repository {
        databaseId nameWithOwner description url
        stargazerCount forkCount pushedAt createdAt updatedAt
        primaryLanguage { name }
        licenseInfo { spdxId }
        repositoryTopics(first: 10) { nodes { topic { name } } }
        isArchived isFork
      }
    }
  }
}`;

interface GraphqlRepo {
  databaseId: number | null;
  nameWithOwner: string;
  description: string | null;
  url: string;
  stargazerCount: number;
  forkCount: number;
  pushedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  primaryLanguage: { name: string } | null;
  licenseInfo: { spdxId: string | null } | null;
  repositoryTopics: { nodes: { topic: { name: string } }[] } | null;
  isArchived: boolean;
  isFork: boolean;
}

interface GraphqlSearch {
  search: {
    repositoryCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (GraphqlRepo | Record<string, never> | null)[];
  };
}

interface RestRepo {
  id: number;
  full_name: string;
  owner: { login: string } | null;
  name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  license: { spdx_id: string | null } | null;
  topics?: string[];
  archived: boolean;
  fork: boolean;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  watchers_count: number;
  created_at: string | null;
  updated_at: string | null;
  pushed_at: string | null;
}

// GraphQL search has no open-issue or watcher counts in this selection: openIssues is 0, as in fetchCandidatesByName,
// and watchers is the star count, which is what the REST search's watchers_count holds.
function fromGraphql(n: GraphqlRepo): Candidate {
  const [owner, name] = n.nameWithOwner.split('/') as [string, string];
  return {
    githubId: n.databaseId ?? 0,
    fullName: n.nameWithOwner,
    owner,
    name,
    htmlUrl: n.url,
    description: n.description,
    primaryLanguage: n.primaryLanguage?.name ?? null,
    licenseSpdx: n.licenseInfo?.spdxId ?? null,
    topics: n.repositoryTopics?.nodes.map((t) => t.topic.name) ?? [],
    isArchived: n.isArchived,
    isFork: n.isFork,
    stars: n.stargazerCount,
    forks: n.forkCount,
    openIssues: 0,
    watchers: n.stargazerCount,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    pushedAt: n.pushedAt,
  };
}

// The same mapping as upstream's toCandidate (RepoRadar/upstream/src/lib/github/search.ts).
function fromRest(item: RestRepo): Candidate {
  return {
    githubId: item.id,
    fullName: item.full_name,
    owner: item.owner?.login ?? item.full_name.split('/')[0]!,
    name: item.name,
    htmlUrl: item.html_url,
    description: item.description,
    primaryLanguage: item.language,
    licenseSpdx: item.license?.spdx_id ?? null,
    topics: item.topics ?? [],
    isArchived: item.archived,
    isFork: item.fork,
    stars: item.stargazers_count,
    forks: item.forks_count,
    openIssues: item.open_issues_count,
    watchers: item.watchers_count,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    pushedAt: item.pushed_at,
  };
}

export interface FetchPoolOptions {
  /** Stop once this many distinct repositories are in the pool (default 2000). */
  poolSize?: number;
  /** Results to page through per query, at most 1000 (default 1000). */
  perQueryMax?: number;
  /** Search calls in flight at once (default 12). A GraphQL search page takes 3-6 s, and parallel calls do not slow
   * each other down, so the wall time is about (calls / concurrency) pages. */
  concurrency?: number;
}

export interface FetchPoolDeps {
  client: GitHubClient;
}

export interface FetchQueryDiagnostic {
  query: string;
  /** GitHub's match count for the query. */
  total: number;
  /** Repositories returned, before dedupe and the archived/fork drop. */
  fetched: number;
  /** Repositories this query was the first to bring into the final pool. */
  added: number;
  pages: number;
  via: 'graphql' | 'rest' | 'graphql+rest';
  error?: string;
}

export interface FetchPoolResult {
  candidates: Candidate[];
  perQuery: FetchQueryDiagnostic[];
  calls: number;
  graphqlCalls: number;
  restCalls: number;
  elapsedMs: number;
  /** Archived repositories and forks left out. */
  dropped: number;
  /** Results that were already in the pool from another query or page. */
  duplicates: number;
  /** Why some or all queries fell back to the REST search. */
  fallbackReasons: string[];
}

interface QueryState {
  index: number;
  query: string;
  page: number;
  cursor: string | null;
  done: boolean;
  busy: boolean;
  rest: boolean;
  usedGraphql: boolean;
  diag: FetchQueryDiagnostic;
}

interface Hit {
  candidate: Candidate;
  /** Sort key: page, then query priority, then position, so the pool order does not depend on timing. */
  key: [number, number, number];
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** REST search takes the sort as parameters; queries carry it inline (`sort:stars`) for GraphQL. */
function restParams(query: string, page: number, perPage: number): Record<string, unknown> {
  const m = /\s*\bsort:([a-z-]+?)(?:-(asc|desc))?(?=\s|$)/.exec(query);
  const params: Record<string, unknown> = { q: m ? query.replace(m[0], '').trim() : query, per_page: perPage, page };
  if (m) {
    params.sort = m[1];
    params.order = m[2] ?? 'desc';
  }
  return params;
}

/**
 * Pages every query through GitHub's GraphQL search (100 per call, up to `perQueryMax` per query), a few calls at a
 * time, first pages of all queries before second pages, until `poolSize` distinct repositories are in. Archived
 * repositories and forks are dropped. A query whose GraphQL call fails continues on the REST search.
 */
export async function fetchPool(queries: string[], options: FetchPoolOptions, deps: FetchPoolDeps): Promise<FetchPoolResult> {
  const started = Date.now();
  const poolSize = options.poolSize ?? 2000;
  const perQueryMax = Math.min(options.perQueryMax ?? SEARCH_RESULT_CAP, SEARCH_RESULT_CAP);
  const maxPages = Math.ceil(perQueryMax / PAGE_SIZE);
  const concurrency = Math.max(1, options.concurrency ?? 12);
  let graphqlCalls = 0;
  let restCalls = 0;
  let dropped = 0;
  let restEverywhere = false;
  const fallbackReasons: string[] = [];
  const hits: Hit[] = [];
  const seen = new Set<string>();

  const states: QueryState[] = [...new Set(queries)].map((query, index) => ({
    index,
    query,
    page: 0,
    cursor: null,
    done: false,
    busy: false,
    rest: false,
    usedGraphql: false,
    diag: { query, total: 0, fetched: 0, added: 0, pages: 0, via: 'graphql' },
  }));

  const fetchPage = async (s: QueryState): Promise<{ items: Candidate[]; total: number; more: boolean }> => {
    const first = Math.min(PAGE_SIZE, perQueryMax - s.page * PAGE_SIZE);
    if (!s.rest && !restEverywhere) {
      try {
        graphqlCalls++;
        s.usedGraphql = true;
        const data = await deps.client.graphql<GraphqlSearch>(SEARCH_GRAPHQL, { q: s.query, first, after: s.cursor });
        const nodes = data.search.nodes.filter((n): n is GraphqlRepo => !!n && 'nameWithOwner' in n);
        s.cursor = data.search.pageInfo.endCursor;
        return { items: nodes.map(fromGraphql), total: data.search.repositoryCount, more: data.search.pageInfo.hasNextPage };
      } catch (e) {
        s.rest = true;
        const status = (e as { status?: number }).status;
        // Without a token GraphQL answers 401 for every call; stop trying it.
        if (status === 401) restEverywhere = true;
        fallbackReasons.push(`${s.query}: ${errorText(e)}`);
      }
    }
    restCalls++;
    // REST pages are numbered; with the same page size they line up with the GraphQL cursor pages.
    const { data } = await deps.client.request('GET /search/repositories', restParams(s.query, s.page + 1, PAGE_SIZE));
    const body = data as { total_count: number; items: RestRepo[] };
    const items = body.items.slice(0, first).map(fromRest);
    return { items, total: body.total_count, more: body.items.length >= PAGE_SIZE };
  };

  const onPage = (s: QueryState, result: { items: Candidate[]; total: number; more: boolean }) => {
    const page = s.page;
    s.page++;
    s.diag.pages++;
    s.diag.total = Math.max(s.diag.total, result.total);
    s.diag.fetched += result.items.length;
    result.items.forEach((candidate, position) => {
      if (candidate.isArchived || candidate.isFork) {
        dropped++;
        return;
      }
      hits.push({ candidate, key: [page, s.index, position] });
      seen.add(candidate.fullName.toLowerCase());
    });
    if (!result.more || !result.items.length || s.page >= maxPages) s.done = true;
  };

  const next = (): QueryState | undefined => {
    let best: QueryState | undefined;
    for (const s of states) {
      if (s.done || s.busy) continue;
      if (!best || s.page < best.page || (s.page === best.page && s.index < best.index)) best = s;
    }
    return best;
  };

  await new Promise<void>((resolve) => {
    let inFlight = 0;
    const pump = () => {
      while (inFlight < concurrency && seen.size < poolSize) {
        const s = next();
        if (!s) break;
        s.busy = true;
        inFlight++;
        fetchPage(s)
          .then((result) => onPage(s, result))
          .catch((e: unknown) => {
            s.done = true;
            s.diag.error = errorText(e);
          })
          .finally(() => {
            s.busy = false;
            inFlight--;
            pump();
          });
      }
      if (inFlight === 0) resolve();
    };
    pump();
  });

  hits.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
  const pool = new Map<string, Candidate>();
  let duplicates = 0;
  for (const hit of hits) {
    const id = hit.candidate.fullName.toLowerCase();
    if (pool.has(id)) {
      duplicates++;
      continue;
    }
    if (pool.size >= poolSize) break;
    pool.set(id, hit.candidate);
    states[hit.key[1]]!.diag.added++;
  }
  for (const s of states) s.diag.via = s.rest ? (s.usedGraphql ? 'graphql+rest' : 'rest') : 'graphql';

  return {
    candidates: [...pool.values()],
    perQuery: states.map((s) => s.diag),
    calls: graphqlCalls + restCalls,
    graphqlCalls,
    restCalls,
    elapsedMs: Date.now() - started,
    dropped,
    duplicates,
    fallbackReasons,
  };
}

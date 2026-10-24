import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildQueries, discoverTopics, fetchPool, type GitHubClient } from '../RepoRadar/headless/fetch.js';

const PDF_NEED = 'Find me an app that converts PDF to txt/word';
const words = (queries: string[]) => new Set(queries.flatMap((q) => q.toLowerCase().split(/[\s"]+/)).filter(Boolean));

test('the PDF need becomes format queries and phrases without the generic words', () => {
  const queries = buildQueries(PDF_NEED);
  assert.ok(queries.length >= 6 && queries.length <= 12, `${queries.length} queries`);
  const all = words(queries);
  for (const w of ['pdf', 'text', 'docx']) assert.ok(all.has(w), `missing ${w}`);
  for (const w of ['app', 'converts', 'find', 'me']) assert.ok(!all.has(w), `noise word ${w}`);
  const joined = queries.join('\n');
  for (const phrase of ['"pdf to text"', '"pdf to docx"', '"pdf converter"']) assert.ok(joined.includes(phrase), `missing ${phrase}`);
  assert.ok(joined.includes('pdf2docx'), 'repository-name form');
  for (const q of queries) assert.ok((q.match(/\b(OR|AND|NOT)\b/g) ?? []).length <= 5, `too many operators: ${q}`);
  assert.deepEqual(buildQueries('find me a simple free app'), [], 'nothing searchable is left');
});

test('filters become search qualifiers on every query', () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const queries = buildQueries(PDF_NEED, { language: 'Python', license: ['MIT', 'Apache-2.0'], minStars: 50, pushedWithinDays: 30 }, { now });
  for (const q of queries) {
    for (const qualifier of ['archived:false', 'language:python', 'license:mit', 'license:apache-2.0', 'stars:>=50', 'pushed:>=2026-09-24']) {
      assert.ok(q.includes(qualifier), `${qualifier} missing from ${q}`);
    }
  }
  assert.ok(buildQueries('markdown editor', { language: 'Jupyter Notebook' })[0]!.includes('language:"jupyter notebook"'));
});

interface FakeRepo {
  name: string;
  archived?: boolean;
  fork?: boolean;
}

/** A GitHub client whose searches return the given repositories, 100 per page, by GraphQL cursor or REST page. */
function fakeClient(results: Record<string, FakeRepo[]>, opts: { graphqlFails?: boolean } = {}) {
  const calls = { graphql: 0, rest: 0, topics: 0 };
  const repoNode = (r: FakeRepo, i: number) => ({
    databaseId: i + 1,
    nameWithOwner: r.name,
    description: `${r.name} description`,
    url: `https://github.com/${r.name}`,
    stargazerCount: 10,
    forkCount: 1,
    pushedAt: '2026-01-01T00:00:00Z',
    createdAt: '2020-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    primaryLanguage: { name: 'Python' },
    licenseInfo: { spdxId: 'MIT' },
    repositoryTopics: { nodes: [{ topic: { name: 'pdf' } }] },
    isArchived: !!r.archived,
    isFork: !!r.fork,
  });
  const client: GitHubClient = {
    async graphql<T>(_query: string, vars: Record<string, unknown> = {}): Promise<T> {
      calls.graphql++;
      if (opts.graphqlFails) throw Object.assign(new Error('Something went wrong while executing your query'), { status: 502 });
      const all = results[String(vars.q)] ?? [];
      const start = vars.after ? Number(vars.after) : 0;
      const end = start + Number(vars.first);
      return {
        search: {
          repositoryCount: all.length,
          pageInfo: { hasNextPage: end < all.length, endCursor: String(end) },
          nodes: all.slice(start, end).map(repoNode),
        },
      } as T;
    },
    async request(route: string, params: Record<string, unknown> = {}) {
      if (route === 'GET /search/topics') {
        calls.topics++;
        return { data: { items: [{ name: 'pdf-converter', display_name: 'PDF converter', short_description: null }, { name: 'word-game', short_description: 'Games with words' }] } };
      }
      calls.rest++;
      const all = results[String(params.q)] ?? [];
      const page = Number(params.page);
      const items = all.slice((page - 1) * 100, page * 100).map((r, i) => ({
        id: i + 1, full_name: r.name, owner: { login: r.name.split('/')[0] }, name: r.name.split('/')[1], html_url: `https://github.com/${r.name}`,
        description: null, language: null, license: null, topics: [], archived: !!r.archived, fork: !!r.fork,
        stargazers_count: 1, forks_count: 0, open_issues_count: 2, watchers_count: 1, created_at: null, updated_at: null, pushed_at: null,
      }));
      return { data: { total_count: all.length, items } };
    },
  };
  return { client, calls };
}

const repos = (prefix: string, n: number): FakeRepo[] => Array.from({ length: n }, (_, i) => ({ name: `${prefix}/r${i}` }));

test('fetchPool pages, dedupes and drops archived repositories and forks', async () => {
  const { client, calls } = fakeClient({
    a: [...repos('a', 150), { name: 'x/archived', archived: true }, { name: 'x/fork', fork: true }, { name: 'shared/one' }],
    b: [{ name: 'shared/one' }, { name: 'Shared/One' }, ...repos('b', 20)],
  });
  const result = await fetchPool(['a', 'b'], { poolSize: 1000 }, { client });
  const names = result.candidates.map((c) => c.fullName);
  assert.equal(names.length, 150 + 1 + 20);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, 'no duplicates');
  assert.ok(!names.includes('x/archived') && !names.includes('x/fork'));
  assert.equal(result.dropped, 2);
  assert.equal(result.duplicates, 2);
  assert.equal(calls.graphql, 3, 'two pages of "a", one of "b"');
  assert.equal(result.calls, 3);
  // First pages of every query come before second pages, so "b" is the first to bring in shared/one.
  assert.deepEqual(result.perQuery.map((q) => [q.query, q.total, q.pages, q.added]), [['a', 153, 2, 150], ['b', 22, 1, 21]]);
  assert.equal(names[100], 'shared/one');
  const c = result.candidates[0]!;
  assert.deepEqual([c.owner, c.name, c.htmlUrl, c.primaryLanguage, c.licenseSpdx, c.topics, c.stars, c.watchers], ['a', 'r0', 'https://github.com/a/r0', 'Python', 'MIT', ['pdf'], 10, 10]);
});

test('fetchPool stops at the pool size', async () => {
  const { client, calls } = fakeClient({ a: repos('a', 1000), b: repos('b', 1000), c: repos('c', 1000) });
  const result = await fetchPool(['a', 'b', 'c'], { poolSize: 250, concurrency: 1 }, { client });
  assert.equal(result.candidates.length, 250);
  assert.equal(calls.graphql, 3, 'one page of each query is enough');
  assert.deepEqual(result.perQuery.map((q) => q.added), [100, 100, 50]);
});

test('fetchPool falls back to the REST search, with the same paging and sort, when GraphQL fails', async () => {
  const seen: Record<string, unknown>[] = [];
  const { client, calls } = fakeClient({ pdf: repos('a', 120) }, { graphqlFails: true });
  const request = client.request.bind(client);
  client.request = async (route, params = {}) => (seen.push(params), request(route, params));
  const result = await fetchPool(['pdf sort:stars'], {}, { client });
  assert.equal(result.candidates.length, 120);
  assert.equal(calls.graphql, 1, 'GraphQL is not retried for the query that failed');
  assert.deepEqual(seen.map((p) => [p.q, p.page, p.sort, p.order]), [['pdf', 1, 'stars', 'desc'], ['pdf', 2, 'stars', 'desc']]);
  assert.equal(result.perQuery[0]!.via, 'graphql+rest');
  assert.equal(result.fallbackReasons.length, 1);
  assert.equal(result.candidates[0]!.openIssues, 2);
});

test('discoverTopics keeps close topics and reuses its week-long cache', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appforge-topics-'));
  const { client, calls } = fakeClient({});
  // A fake embedding: one dimension per word of interest.
  const dims = ['pdf', 'convert', 'game'];
  const embed = async (texts: string[]) => texts.map((t) => dims.map((d) => (t.toLowerCase().includes(d) ? 1 : 0.01)));
  const deps = { client, embed, cacheDir };
  const now = new Date('2026-10-24T12:00:00Z');
  const first = await discoverTopics(['pdf', 'text', 'docx'], { need: PDF_NEED, now }, deps);
  assert.deepEqual(first.topics.map((t) => t.name), ['pdf-converter']);
  assert.deepEqual(first.queries, ['topic:pdf-converter archived:false']);
  assert.equal(first.calls, 3);
  assert.ok(fs.existsSync(path.join(cacheDir, 'github-topics.json')));

  const again = await discoverTopics(['pdf', 'text', 'docx'], { need: PDF_NEED, now: new Date(now.getTime() + 6 * 86_400_000) }, deps);
  assert.equal(calls.topics, 3, 'no new GitHub calls within a week');
  assert.equal(again.cacheHits, 3);
  assert.deepEqual(again.queries, first.queries);

  const later = await discoverTopics(['pdf'], { need: PDF_NEED, phrases: ['word game'], now: new Date(now.getTime() + 8 * 86_400_000) }, deps);
  assert.equal(calls.topics, 4, 'a week-old entry is fetched again');
  assert.deepEqual(later.topics.map((t) => t.name), ['word-game', 'pdf-converter'], 'a topic spelled like a phrase of the need is kept');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildQueries, extractTerms, fetchPool, type GitHubClient } from '../RepoRadar/headless/fetch.js';
import { rankCandidates, type RankCandidate } from '../RepoRadar/headless/rank.js';
import { PROFILES, PROFILE_NAMES, REFERENCE, downloadMB, estimateSeconds, resolveModels } from '../server/src/models.js';

test('queries keep the words that matter and drop the ones every repository shares', () => {
  const q = buildQueries('Find me an app that converts PDF to txt/word', { license: ['MIT'] });
  assert.ok(q.length >= 5 && q.every((x) => x.includes('archived:false') && x.includes('license:mit')));
  assert.ok(!q.some((x) => /\b(app|converts|find)\b/.test(x)), q.join(' | '));
  const t = extractTerms('Find me an app that converts PDF to txt/word');
  assert.deepEqual(t.keywords.slice(0, 3), ['pdf', 'text', 'docx']);
  assert.ok(t.phrases.includes('pdf to text') && t.phrases.includes('pdf to docx') && t.names.includes('pdf2docx'));
});

test('the pool drops archived repos and forks, removes duplicates and stops at poolSize', async () => {
  const node = (name: string, extra = {}) => ({ databaseId: name.length, nameWithOwner: name, description: null, url: '', stargazerCount: 1, forkCount: 0, pushedAt: null, createdAt: null, updatedAt: null, isArchived: false, isFork: false, primaryLanguage: null, licenseInfo: null, repositoryTopics: { nodes: [] }, ...extra });
  const client = {
    graphql: async (_q: string, v?: Record<string, unknown>) => ({
      search: { repositoryCount: 3, nodes: v!.q === 'a' ? [node('o/1'), node('o/2', { isFork: true }), node('o/3', { isArchived: true })] : [node('o/1'), node('o/4'), node('o/5')] },
    }),
    request: async () => ({ data: {} }),
  } as unknown as GitHubClient;
  const r = await fetchPool(['a', 'b'], { poolSize: 2 }, { client });
  assert.deepEqual(r.candidates.map((c) => c.fullName), ['o/1', 'o/4']);
});

const repo = (fullName: string, description: string, stars = 1000): RankCandidate => ({ fullName, description, topics: [], stars, forks: Math.round(stars / 10), pushedAt: new Date().toISOString() });
// Fake models: bag-of-words vectors, and a "cross-encoder" that counts need words in the doc.
const vocab = ['pdf', 'text', 'docx', 'image', 'gif', 'habit'];
const vec = (t: string) => {
  const w = t.toLowerCase().split(/[^a-z]+/);
  const v = new Float32Array(vocab.map((x) => w.filter((y) => y === x).length));
  return v.map((x) => x / (Math.hypot(...v) || 1));
};
const deps = {
  embed: async (texts: string[]) => texts.map(vec),
  rerank: async (q: string, docs: string[]) => docs.map((d) => new Set(d.toLowerCase().split(/[^a-z]+/).filter((w) => vocab.includes(w) && q.includes(w))).size / 3),
};

test('stage 2 drops repos below the similarity floor, stage 3 the low cross-encoder scores, best first', async () => {
  const pool = [repo('a/pdf-to-text', 'PDF to text and docx'), repo('b/images-to-pdf', 'images into a PDF'), repo('c/gif', 'gif maker'), repo('e/pdf-docx', 'PDF to docx', 50)];
  const { ranked, stats } = await rankCandidates('pdf to text or docx', pool, { minSimilarity: 0.3, rerankPool: 3, minRerankScore: 0.4, finalists: 2 }, deps);
  assert.equal(stats.belowSimilarity, 1);
  assert.equal(stats.belowRerankScore, 1, 'images-to-pdf shares only "pdf" with the need');
  assert.deepEqual(ranked.map((r) => r.candidate.fullName), ['a/pdf-to-text', 'e/pdf-docx']);
});

test('established projects reach the cross-encoder even when many tiny repos match the words more literally', async () => {
  const tiny = Array.from({ length: 30 }, (_, i) => repo(`u${i}/habit-tracker`, 'habit habit habit', 0));
  const famous = repo('isoron/uhabits', 'Loop: keep long-term positive habit routines', 10_000);
  const { stats } = await rankCandidates('habit', [...tiny, famous], { minSimilarity: 0.1, rerankPool: 9, minRerankScore: 0, finalists: 5 }, deps);
  assert.ok(stats.shortlist.includes('isoron/uhabits'));
});

test('profiles: bigger ones download more, settings override them, and the estimate scales with the probe', () => {
  assert.ok(PROFILE_NAMES.every((n, i) => i === 0 || downloadMB(n) > downloadMB(PROFILE_NAMES[i - 1]!)));
  const r = resolveModels({ modelProfile: 'nope', embedModel: '', rerankModel: 'msmarco-l6', llmModel: 'C:\\m\\mine.gguf', poolSize: 0, rerankPool: 0 });
  assert.equal(r.profile, 'best');
  assert.equal(r.rerank.id, 'Xenova/ms-marco-MiniLM-L-6-v2');
  assert.equal(r.llm.file, 'mine.gguf');
  assert.equal(r.poolSize, PROFILES.best.poolSize);
  const saved = { probe: REFERENCE.probeMs, timings: PROFILES.small.timings };
  REFERENCE.probeMs = 100;
  PROFILES.small.timings = { github: 10, encoders: 4, llmGpu: 6, llmCpu: 40 };
  const slow = estimateSeconds('small', { probeMs: 200, gpu: false })!; // 10 + 8 + 80 s
  assert.ok(slow.low <= 98 && slow.high >= 98);
  Object.assign(REFERENCE, { probeMs: saved.probe });
  PROFILES.small.timings = saved.timings;
});

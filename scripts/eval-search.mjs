// Search-quality eval for repo_search: the gold prompts (tests/search-gold.json) through the same fetch and ranking
// code as the MCP tool (RepoRadar/headless/search.ts), scored with RepoRadar's metrics. Every GitHub answer and model
// output is cached on disk, so a rerun only computes what changed (new weights: seconds; a new model: its own step).
//   node scripts/eval-search.mjs                                   best profile, every prompt
//   node scripts/eval-search.mjs --profiles small,balanced,best --prompts pdf,habit --tag x   KEY=VALUE = env
//   --parallel 3   searches at once (the default): one's GitHub fetch overlaps another's reranking
//   --fresh        ignore the caches (to measure real seconds per search)
// The evidence step (releases, issues) does not change the order and is not run; `node scripts/smoke.mjs repos` covers
// the whole tool. Caches and the report go to <data folder>/cache/eval/. Needs `npm run build` and a GitHub login.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const say = (line) => process.stdout.write(`${line}\n`);
console.log = console.info = (...a) => process.stderr.write(`${a.join(' ')}\n`);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const opts = { tag: 'run', prompts: '', profiles: 'best', parallel: '3', fresh: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--fresh') opts.fresh = true;
  else if (a.startsWith('--')) opts[a.slice(2)] = process.argv[++i];
  else if (a.includes('=')) process.env[a.slice(0, a.indexOf('='))] = a.slice(a.indexOf('=') + 1);
}

// A throwaway data folder (default settings, its own SQLite) linked to the downloaded models.
const { dataDir, paths } = await imp('dist/server/src/paths.js');
const realData = dataDir();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'appforge-eval-'));
const link = path.join(home, 'models');
process.env.APPFORGE_HOME = home;
process.env.APPFORGE_NO_UPDATE_CHECK = '1';
fs.symlinkSync(path.join(realData, 'models'), link, 'junction');
const { radar, rerankPath } = await imp('dist/RepoRadar/src/radar.js');
const { githubToken } = await imp('dist/server/src/github.js');
const { loadConfig } = await imp('dist/server/src/config.js');
const { resolveModels } = await imp('dist/server/src/models.js');
const { findRepos, EXPAND } = await imp('dist/RepoRadar/headless/search.js');
const enc = await imp('dist/RepoRadar/headless/encoders.js');
const { computeMetrics, poolRecall } = await imp('RepoRadar/upstream/scripts/eval/metrics.mjs');
enc.setModelsDir(paths.models);
const token = githubToken();
if (!token) throw new Error('No GitHub login: run `gh auth login`.');

// The disk cache: one file per GitHub answer, embedding batch or reranker call, named by a hash of the request.
const cacheDir = path.join(realData, 'cache', 'eval', 'cache');
fs.mkdirSync(cacheDir, { recursive: true });
const hits = { hit: 0, miss: 0 };
const key = (...parts) => crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex');
async function cached(file, compute, write = JSON.stringify, read = (b) => JSON.parse(b.toString('utf8'))) {
  const f = path.join(cacheDir, file);
  if (!opts.fresh && fs.existsSync(f)) {
    hits.hit++;
    return read(fs.readFileSync(f));
  }
  hits.miss++;
  const v = await compute();
  fs.writeFileSync(f, write(v));
  return v;
}
const api = async (method, route, body) => {
  const r = await fetch(`https://api.github.com${route}`, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'AppForge-eval' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok || j.errors) throw new Error(`GitHub ${r.status}: ${j.errors?.[0]?.message ?? j.message ?? r.statusText}`);
  return j;
};
const client = {
  graphql: (query, variables) => cached(`gh-${key(query, JSON.stringify(variables ?? {}))}.json`, async () => (await api('POST', '/graphql', { query, variables })).data),
  request: (route, params) => cached(`gh-${key(route, JSON.stringify(params ?? {}))}.json`, async () => ({ data: await api('GET', `${route.split(' ')[1]}?${new URLSearchParams(Object.entries(params ?? {}).map(([k, v]) => [k, String(v)]))}`) })),
};
// Float32 vectors: a 4-byte dimension, then the numbers.
const packVecs = (vs) => Buffer.concat([Buffer.from(new Uint32Array([vs[0]?.length ?? 0]).buffer), ...vs.map((v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength))]);
const unpackVecs = (b) => {
  const dim = b.readUInt32LE(0);
  const all = new Float32Array(b.buffer.slice(b.byteOffset + 4, b.byteOffset + b.byteLength));
  return Array.from({ length: dim ? all.length / dim : 0 }, (_, i) => all.slice(i * dim, (i + 1) * dim));
};

const gold = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'search-gold.json'), 'utf8')).prompts;
const want = opts.prompts ? opts.prompts.toLowerCase().split(',') : [];
const items = gold.filter((p) => !want.length || want.some((w) => p.prompt.toLowerCase().includes(w)));
const r = await radar();
const lc = (s) => s.toLowerCase();
const spec = (m) => ({ id: m.id, pooling: m.pooling, readme: m.readme, gguf: rerankPath(m) });

async function evaluate(profile, item) {
  const c = loadConfig().repos;
  const m = resolveModels({ ...c, modelProfile: profile });
  const s = { poolSize: m.poolSize, minSimilarity: c.minSimilarity, rerankPool: m.rerankPool, minRerankScore: c.minRerankScore, rerankWeight: m.rerankWeight, rerankScale: m.rerankScale, finalists: c.finalists, expandTopics: EXPAND.topics, expandPool: EXPAND.pool, cacheDir };
  const started = Date.now();
  const reference = await cached(`ref-${key(item.prompt)}.json`, () => r.reference(item.prompt));
  const found = await findRepos(item.prompt, {}, s, {
    client,
    reference,
    embed: (texts) => cached(`emb-${key(m.embed.id, ...texts)}.bin`, () => enc.embed(spec(m.embed), texts), packVecs, unpackVecs),
    rerank: (q, docs) => cached(`rr-${key(m.rerank.id + (process.env.APPFORGE_RERANK_PREFIX === 'off' ? '' : '|prefix'), q, ...docs)}.json`, () => enc.rerank(spec(m.rerank), q, docs)),
  });
  const names = found.ranked.map((x) => x.candidate.fullName);
  const met = computeMetrics(item, found.ranked.map((x) => ({ fullName: x.candidate.fullName, stars: x.candidate.stars, future: 0.5 })));
  const all = new Set([...item.must_include, ...item.nice_to_have].map(lc));
  const grade = (n) => (item.must_include.map(lc).includes(lc(n)) ? 2 : all.has(lc(n)) ? 1 : 0);
  const best = (list) => computeMetrics(item, list.filter((n) => grade(n) > 0).sort((a, b) => grade(b) - grade(a)).slice(0, 10).map((fullName) => ({ fullName, stars: 1, future: 0.5 }))).ndcg10;
  return {
    prompt: item.prompt, profile, ndcg: met.ndcg10, must: met.mustRecall ?? 0, traps: met.trapLeak ?? 0,
    pool: poolRecall(item, found.candidates.map((x) => x.fullName))?.recall ?? 0,
    short: poolRecall(item, found.rank.shortlist)?.recall ?? 0,
    top10: all.size ? names.filter((n) => all.has(lc(n))).length / all.size : 0,
    ceil10: best(names), ceil150: best(found.rank.shortlist),
    deepest: Math.max(...names.map((n) => found.rank.shortlist.indexOf(n))),
    results: names.length, poolSize: found.candidates.length, queries: found.queries, topics: found.topics, expansion: found.expansion, seconds: (Date.now() - started) / 1000, top: names,
  };
}

const profiles = opts.profiles.split(',');
say(`eval tag=${opts.tag} profiles=${profiles.join(',')} prompts=${items.length}${opts.fresh ? ' (no cache)' : ''}`);
const rows = [];
const t0 = Date.now();
for (const profile of profiles) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.max(1, Number(opts.parallel)) }, async () => {
    for (let item; (item = queue.shift()); ) {
      const row = await evaluate(profile, item).catch((e) => ({ prompt: item.prompt, profile, ndcg: 0, must: 0, traps: 0, pool: 0, short: 0, top10: 0, ceil10: 0, ceil150: 0, results: 0, poolSize: 0, expansion: [], seconds: 0, top: [], error: String(e?.message ?? e) }));
      rows.push(row);
      process.stderr.write(`  ${profile} ${item.prompt.slice(0, 40).padEnd(40)} ndcg=${row.ndcg.toFixed(2)} ${row.seconds.toFixed(0)}s${row.error ? ` FAILED: ${row.error}` : ''}\n`);
    }
  }));
}

const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const f2 = (v) => v.toFixed(2);
const summary = profiles.map((p) => {
  const rs = rows.filter((x) => x.profile === p);
  const nd = rs.map((x) => x.ndcg).sort((a, b) => a - b);
  const sd = Math.sqrt(avg(nd.map((x) => (x - avg(nd)) ** 2)));
  return { profile: p, ndcg: avg(nd), median: nd[Math.floor(nd.length / 2)], worst: nd[0], stdev: sd, must: avg(rs.map((x) => x.must)), pool: avg(rs.map((x) => x.pool)), short: avg(rs.map((x) => x.short)), top10: avg(rs.map((x) => x.top10)), ceil10: avg(rs.map((x) => x.ceil10)), ceil150: avg(rs.map((x) => x.ceil150)), traps: rs.reduce((n, x) => n + x.traps, 0), results: avg(rs.map((x) => x.results)), failed: rs.filter((x) => x.error).length };
});
say('\nprofile    nDCG  median worst stdev | must  pool  short top10 | ceil10 ceil150 | traps results failed');
for (const x of summary) say(`${x.profile.padEnd(9)}  ${f2(x.ndcg)}  ${f2(x.median)}   ${f2(x.worst)}  ${f2(x.stdev)} | ${f2(x.must)}  ${f2(x.pool)}  ${f2(x.short)}  ${f2(x.top10)} |  ${f2(x.ceil10)}   ${f2(x.ceil150)} |  ${String(x.traps).padStart(3)}  ${x.results.toFixed(1).padStart(6)}  ${x.failed}`);
say(`\nnDCG per prompt (${profiles.join(' / ')}):`);
for (const it of items) say(`  ${it.prompt.slice(0, 50).padEnd(50)} ${profiles.map((p) => f2(rows.find((x) => x.profile === p && x.prompt === it.prompt)?.ndcg ?? 0)).join('  ')}`);
const file = path.join(realData, 'cache', 'eval', `${opts.tag}.json`);
fs.writeFileSync(file, JSON.stringify({ tag: opts.tag, at: new Date().toISOString(), summary, rows }, null, 2) + '\n');
say(`\n${((Date.now() - t0) / 1000).toFixed(0)} s, cache ${hits.hit} hits / ${hits.miss} computed; report: ${file}`);
try {
  fs.rmdirSync(link); // removes the junction, never its target
  fs.rmSync(home, { recursive: true, force: true });
} catch {
  /* the SQLite file may still be open; the OS cleans its temp folder */
}
process.exit(0);

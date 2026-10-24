// Search-quality eval for repo_search: runs the gold prompts through the built pipeline (the same entry the MCP tool
// uses) and scores them with RepoRadar's own metrics (RepoRadar/upstream/scripts/eval/metrics.mjs).
//   node scripts/eval-search.mjs                          every prompt in tests/search-gold.json, tag "run"
//   node scripts/eval-search.mjs --tag baseline --prompts pdf,habit --repeats 2
//   node scripts/eval-search.mjs --tag big-pool APPFORGE_REPOS_POOLSIZE=1000   KEY=VALUE pairs become env (A/B runs)
// Uses a throwaway data folder (fresh caches, so runs are comparable) that links to your downloaded models. The
// report goes to <data folder>/cache/eval/<tag>.json. Needs `npm run build` and a GitHub login.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The pipeline logs with console.log; keep stdout for this report.
const say = (line) => process.stdout.write(`${line}\n`);
console.log = console.info = (...a) => process.stderr.write(`${a.join(' ')}\n`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = (p) => pathToFileURL(path.join(root, 'dist', p)).href;

const opts = { tag: 'run', prompts: '', repeats: 1, gold: path.join(root, 'tests', 'search-gold.json') };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) opts[a.slice(2)] = process.argv[++i];
  else if (a.includes('=')) process.env[a.slice(0, a.indexOf('='))] = a.slice(a.indexOf('=') + 1);
}

// The real data folder (for the report and the models) before switching to a throwaway one for the run itself.
const { dataDir, paths } = await import(dist('server/src/paths.js'));
const realData = dataDir();
const realModels = path.join(realData, 'models');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'appforge-eval-'));
process.env.APPFORGE_HOME = home;
process.env.APPFORGE_NO_UPDATE_CHECK = '1';
if (fs.existsSync(realModels)) fs.symlinkSync(realModels, path.join(home, 'models'), 'junction');

const { githubToken } = await import(dist('server/src/github.js'));
const { startSearch, getSearch } = await import(dist('RepoRadar/src/radar.js'));
const { computeMetrics, aggregate, poolRecall } = await import(pathToFileURL(path.join(root, 'RepoRadar', 'upstream', 'scripts', 'eval', 'metrics.mjs')).href);

const token = githubToken();
if (!token) throw new Error('No GitHub login: run `gh auth login` or set GITHUB_TOKEN.');

/** GitHub quota left (core / search / graphql); /rate_limit itself is free. */
async function quota() {
  const r = await fetch('https://api.github.com/rate_limit', { headers: { authorization: `Bearer ${token}`, 'user-agent': 'appforge-eval' } });
  const j = await r.json();
  return Object.fromEntries(['core', 'search', 'graphql'].map((k) => [k, j.resources?.[k]?.remaining ?? null]));
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}

/** Seconds per pipeline stage, from the "✓ <stage>" lines the pipeline logs for this search. */
function stageSeconds(id) {
  const tag = `pipeline:${id.slice(0, 8)}`;
  const out = {};
  for (const e of readJsonl(path.join(paths.cache, 'logs', 'pipeline.log'))) {
    if (e.tag === tag && typeof e.durationMs === 'number') out[String(e.msg).replace(/^✓\s*/, '')] = e.durationMs / 1000;
  }
  return out;
}

let peakRss = 0;
const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 250);

async function runOnce(prompt) {
  const before = await quota();
  const started = Date.now();
  const id = await startSearch(prompt, {});
  let s;
  for (;;) {
    s = await getSearch(id);
    if (!s || s.status === 'completed' || s.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const seconds = (Date.now() - started) / 1000;
  const after = await quota();
  const used = Object.fromEntries(Object.keys(before).map((k) => [k, before[k] != null && after[k] != null ? before[k] - after[k] : null]));
  const results = (s?.results ?? []).map((r) => ({
    fullName: r.repo?.fullName ?? '',
    stars: r.metrics?.stars ?? 0,
    fit: r.scores?.fit ?? 0,
    future: r.scores?.future ?? 0,
    source: r.analysis?.source ?? '?',
  }));
  const diag = readJsonl(path.join(paths.cache, 'logs', 'search-diagnostics.jsonl')).filter((d) => d.searchQueryId === id).at(-1);
  return { id, status: s?.status ?? 'missing', error: s?.error ?? null, seconds, githubCalls: used, stages: stageSeconds(id), results, pool: diag?.candidatePool ?? [], queries: diag?.activeQueries?.length ? diag.activeQueries : (diag?.heuristicQueries ?? []) };
}

const gold = JSON.parse(fs.readFileSync(opts.gold, 'utf8'));
const filters = opts.prompts ? opts.prompts.toLowerCase().split(',') : [];
const items = gold.prompts.filter((p) => !filters.length || filters.some((f) => p.prompt.toLowerCase().includes(f)));
const repeats = Number(opts.repeats) || 1;
say(`eval tag=${opts.tag} prompts=${items.length} repeats=${repeats}`);

const rows = [];
const allSeconds = [];
for (const item of items) {
  const runs = [];
  for (let r = 0; r < repeats; r++) {
    const run = await runOnce(item.prompt);
    const m = computeMetrics(item, run.results.slice(0, 15));
    const pr = poolRecall(item, run.pool);
    runs.push({ ...run, metrics: m, poolRecall: pr?.recall ?? null, poolMissing: pr?.missing ?? [], top: run.results.slice(0, 15).map((x) => x.fullName) });
    allSeconds.push(run.seconds);
    say(
      `  ${item.prompt.slice(0, 44).padEnd(44)} ndcg=${m.ndcg10.toFixed(2)} must=${(m.mustRecall ?? 0).toFixed(2)} pool=${(pr?.recall ?? 0).toFixed(2)} ` +
        `trap=${m.trapLeak} n=${run.results.length} pool#=${run.pool.length} ${run.seconds.toFixed(0)}s gh=${JSON.stringify(run.githubCalls)}${run.status !== 'completed' ? ` ${run.status}: ${run.error}` : ''}`,
    );
  }
  const mean = (f) => runs.reduce((s, x) => s + (f(x) ?? 0), 0) / runs.length;
  rows.push({
    prompt: item.prompt,
    ndcg10: mean((x) => x.metrics.ndcg10), recall15: mean((x) => x.metrics.recall15), mustRecall: mean((x) => x.metrics.mustRecall),
    mrr: mean((x) => x.metrics.mrr), trapLeak: mean((x) => x.metrics.trapLeak), junk: mean((x) => x.metrics.junk),
    allRelevant: mean((x) => x.metrics.allRelevant), poolRecall: mean((x) => x.poolRecall), seconds: mean((x) => x.seconds),
    runs,
  });
}
clearInterval(sampler);

const sorted = [...allSeconds].sort((a, b) => a - b);
const agg = {
  ...aggregate(rows),
  poolRecall: rows.reduce((s, r) => s + r.poolRecall, 0) / (rows.length || 1),
  secondsP50: sorted[Math.floor(sorted.length / 2)] ?? null,
  secondsMax: sorted.at(-1) ?? null,
  peakRssMB: Math.round(peakRss / 1048576),
};
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(APPFORGE_REPOS_|RERANK_MODEL|GITHUB_PER_PAGE|MAX_CANDIDATES|FUNNEL_TOP_N|CROSS_ENCODER_RERANK)/.test(k)));
const report = { tag: opts.tag, generatedAt: new Date().toISOString(), env, aggregate: agg, rows };
const outDir = path.join(realData, 'cache', 'eval');
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `${opts.tag}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');

const f = (v, d = 3) => (typeof v === 'number' ? v.toFixed(d) : '-');
say(`\n${opts.tag}: nDCG@10=${f(agg.ndcg10)} mustRecall=${f(agg.mustRecall)} recall@15=${f(agg.recall15)} poolRecall=${f(agg.poolRecall)} ` +
  `MRR=${f(agg.mrr)} trapLeak=${f(agg.trapLeak, 2)} junk=${f(agg.junk, 2)} p50=${f(agg.secondsP50, 0)}s max=${f(agg.secondsMax, 0)}s peakRSS=${agg.peakRssMB}MB`);
say(`report: ${file}`);
// Remove the models link itself first, so cleaning up can never reach the real models folder.
const link = path.join(home, 'models');
try {
  fs.rmdirSync(link);
} catch {
  try {
    fs.unlinkSync(link);
  } catch {
    /* no link */
  }
}
if (!fs.existsSync(link)) {
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    /* the SQLite file may still be open; the OS cleans the temp folder */
  }
}
process.exit(0);

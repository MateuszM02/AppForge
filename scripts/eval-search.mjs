// Search-quality eval for repo_search: runs the gold prompts through the built pipeline (the same entry the MCP tool
// uses) and scores them with RepoRadar's own metrics (RepoRadar/upstream/scripts/eval/metrics.mjs).
//   node scripts/eval-search.mjs                          every prompt in tests/search-gold.json, tag "run"
//   node scripts/eval-search.mjs --tag best --prompts pdf,habit APPFORGE_REPOS_MODELPROFILE=small   KEY=VALUE = env
//   --parallel 2   runs two searches at once (one's GitHub fetch overlaps the other's LLM pick): quicker for quality
//                  checks, but the seconds per search are then not representative
// Uses a throwaway data folder (fresh caches, so runs are comparable) linked to your downloaded models. The report
// goes to <data folder>/cache/eval/<tag>.json. Needs `npm run build` and a GitHub login.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The pipeline logs with console.log; keep stdout for this report.
const say = (line) => process.stdout.write(`${line}\n`);
console.log = console.info = (...a) => process.stderr.write(`${a.join(' ')}\n`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const opts = { tag: 'run', prompts: '', parallel: '1' };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) opts[a.slice(2)] = process.argv[++i];
  else if (a.includes('=')) process.env[a.slice(0, a.indexOf('='))] = a.slice(a.indexOf('=') + 1);
}

const { dataDir, paths } = await imp('dist/server/src/paths.js');
const realData = dataDir();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'appforge-eval-'));
const link = path.join(home, 'models');
process.env.APPFORGE_HOME = home;
process.env.APPFORGE_NO_UPDATE_CHECK = '1';
fs.symlinkSync(path.join(realData, 'models'), link, 'junction');

const { startSearch, getSearch } = await imp('dist/RepoRadar/src/radar.js');
const { computeMetrics, aggregate, poolRecall } = await imp('RepoRadar/upstream/scripts/eval/metrics.mjs');
const gold = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'search-gold.json'), 'utf8'));
const filters = opts.prompts ? opts.prompts.toLowerCase().split(',') : [];
const items = gold.prompts.filter((p) => !filters.length || filters.some((f) => p.prompt.toLowerCase().includes(f)));
let peakRss = 0;
const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 250);
say(`eval tag=${opts.tag} prompts=${items.length}`);

const rows = [];
async function run(item) {
  const started = Date.now();
  const id = await startSearch(item.prompt, {});
  let s;
  while ((s = await getSearch(id)) && s.status !== 'completed' && s.status !== 'failed') await new Promise((r) => setTimeout(r, 1000));
  const seconds = (Date.now() - started) / 1000;
  const results = (s?.results ?? []).map((r) => ({ fullName: r.repo?.fullName ?? '', stars: r.metrics?.stars ?? 0, future: r.scores?.future ?? 0 }));
  const diags = fs.readFileSync(path.join(paths.cache, 'logs', 'search-diagnostics.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const m = computeMetrics(item, results.slice(0, 15));
  const diag = diags.filter((d) => d.searchQueryId === id).at(-1);
  const pool = poolRecall(item, diag?.candidatePool ?? [])?.recall ?? null;
  // Shortlist recall: the expected repos that survived the embedding stage into the cross-encoder's input.
  const shortlist = poolRecall(item, diag?.funnelSurvivors ?? [])?.recall ?? null;
  rows.push({ prompt: item.prompt, ...m, poolRecall: pool, shortlistRecall: shortlist, seconds, stages: s?.stats?.seconds, llm: s?.stats?.llm, top: results.slice(0, 15).map((r) => r.fullName) });
  say(`  ${item.prompt.slice(0, 44).padEnd(44)} ndcg=${m.ndcg10.toFixed(2)} must=${(m.mustRecall ?? 0).toFixed(2)} pool=${(pool ?? 0).toFixed(2)} trap=${m.trapLeak} ${seconds.toFixed(0)}s ${JSON.stringify(s?.stats?.seconds ?? {})} llm=${s?.stats?.llm}${s?.status === 'failed' ? ` FAILED: ${s.error}` : ''}`);
}
const queue = [...items];
await Promise.all(Array.from({ length: Math.max(1, Number(opts.parallel)) }, async () => {
  while (queue.length) await run(queue.shift());
}));
clearInterval(sampler);

const sec = rows.map((r) => r.seconds).sort((a, b) => a - b);
const mean = (k) => rows.reduce((t, r) => t + (r[k] ?? 0), 0) / (rows.length || 1);
const agg = { ...aggregate(rows), poolRecall: mean("poolRecall"), shortlistRecall: mean("shortlistRecall"), secondsP50: sec[Math.floor(sec.length / 2)], peakRssMB: Math.round(peakRss / 1048576) };
const file = path.join(realData, 'cache', 'eval', `${opts.tag}.json`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ tag: opts.tag, at: new Date().toISOString(), aggregate: agg, rows }, null, 2) + '\n');
const f = (v, d = 3) => (typeof v === 'number' ? v.toFixed(d) : '-');
say(`\n${opts.tag}: nDCG@10=${f(agg.ndcg10)} mustRecall=${f(agg.mustRecall)} recall@15=${f(agg.recall15)} poolRecall=${f(agg.poolRecall)} shortlistRecall=${f(agg.shortlistRecall)} trapLeak=${f(agg.trapLeak, 2)} p50=${f(agg.secondsP50, 0)}s peakRSS=${agg.peakRssMB}MB`);
say(`report: ${file}`);
// Remove the models link itself first (rmdir removes a junction, never its target), then the throwaway folder.
try {
  fs.rmdirSync(link);
  fs.rmSync(home, { recursive: true, force: true });
} catch {
  /* the SQLite file may still be open; the OS cleans its temp folder */
}
process.exit(0);

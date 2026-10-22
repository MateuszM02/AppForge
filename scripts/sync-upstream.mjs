// Updates a vendored upstream folder to a newer upstream commit, keeping local changes.
//
//   node scripts/sync-upstream.mjs <part> [commit]      part: memory | skill-browser | RepoRadar | camofox-browser
//
// It downloads two tarballs from codeload.github.com (no API quota): the commit recorded in <part>/UPSTREAM.md
// (the base) and the new commit (default: the default branch). For every vendored file:
//   unchanged here       -> replaced by the new version
//   changed here         -> 3-way merged with `git merge-file` (conflict markers if both sides changed the same lines)
//   deleted upstream     -> deleted here unless it was changed here
// Then UPSTREAM.md gets the new commit. Review `git diff`, rebuild and test before committing.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARTS = {
  memory: { repo: 'kitfunso/hippo-memory', include: ['src/', 'bin/', 'LICENSE', 'README.md', 'package.json', 'tsconfig.json'] },
  'skill-browser': { repo: 'gengirish/skills-mcp', include: ['src/', 'data/', 'sources.json', 'LICENSE', 'README.md', 'package.json', 'tsconfig.json'] },
  RepoRadar: { repo: 'Panther114/RepoRadar', include: [''], exclude: ['public/', 'tests/', '.github/'] },
  'camofox-browser': {
    repo: 'jo-inc/camofox-browser',
    include: ['server.js', 'postinstall.js', 'package.json', 'camofox.config.json', 'openapi.json', 'LICENSE', 'README.md', 'lib/', 'bin/', 'plugins/'],
  },
};

const [part, wanted] = process.argv.slice(2);
const cfg = PARTS[part];
if (!cfg) {
  console.error(`Usage: node scripts/sync-upstream.mjs <${Object.keys(PARTS).join('|')}> [commit]`);
  process.exit(2);
}
const upstreamMd = path.join(root, part, 'UPSTREAM.md');
const md = fs.readFileSync(upstreamMd, 'utf8');
const base = /commit `([0-9a-f]{40})`/.exec(md)?.[1];
if (!base) throw new Error(`No commit recorded in ${upstreamMd}`);
const target =
  wanted ?? execFileSync('git', ['ls-remote', `https://github.com/${cfg.repo}.git`, 'HEAD'], { encoding: 'utf8' }).split('\t')[0].trim();
if (target === base) {
  console.log(`${part} is already at ${base}.`);
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `appforge-sync-${part}-`));
async function extract(sha, name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  const res = await fetch(`https://codeload.github.com/${cfg.repo}/tar.gz/${sha}`);
  if (!res.ok) throw new Error(`download of ${sha} failed: ${res.status}`);
  const file = path.join(tmp, `${name}.tgz`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  execFileSync('tar', ['-xzf', file, '-C', dir, '--strip-components=1']);
  return dir;
}

function list(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk('');
  return out.filter((f) => cfg.include.some((i) => (i.endsWith('/') || i === '' ? f.startsWith(i) : f === i)) && !(cfg.exclude ?? []).some((x) => f.startsWith(x)));
}

const baseDir = await extract(base, 'base');
const newDir = await extract(target, 'new');
const local = path.join(root, part, 'upstream');
// Line endings may differ after a git checkout on Windows; they do not count as a change.
const bytes = (p) => Buffer.from(fs.readFileSync(p).filter((c) => c !== 13));
const same = (a, b) => fs.existsSync(a) && fs.existsSync(b) && bytes(a).equals(bytes(b));
const report = { updated: 0, added: 0, merged: [], conflicts: [], deleted: 0, keptLocal: [] };

for (const f of list(newDir)) {
  const l = path.join(local, f);
  const b = path.join(baseDir, f);
  const n = path.join(newDir, f);
  if (!fs.existsSync(l) || !fs.existsSync(b) || same(l, b)) {
    if (!fs.existsSync(l)) report.added++;
    else if (!same(l, n)) report.updated++;
    fs.mkdirSync(path.dirname(l), { recursive: true });
    fs.copyFileSync(n, l);
  } else if (!same(b, n)) {
    try {
      execFileSync('git', ['merge-file', '-L', 'appforge', '-L', 'base', '-L', 'upstream', l, b, n]);
      report.merged.push(f);
    } catch {
      report.conflicts.push(f);
    }
  }
}
const inNew = new Set(list(newDir));
for (const f of list(baseDir)) {
  if (inNew.has(f)) continue;
  const l = path.join(local, f);
  if (same(l, path.join(baseDir, f))) {
    fs.rmSync(l);
    report.deleted++;
  } else if (fs.existsSync(l)) report.keptLocal.push(f);
}

fs.writeFileSync(upstreamMd, md.replace(base, target));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${part}: ${base.slice(0, 7)} -> ${target.slice(0, 7)}`);
console.log(JSON.stringify(report, null, 2));
console.log('Next: review `git diff`, resolve conflicts if any, `npm run build`, `npm test`, `npm run smoke`.');

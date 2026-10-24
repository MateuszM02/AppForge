import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.APPFORGE_RADAR_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'appforge-radar-'));
const { prisma } = await import('../RepoRadar/headless/prisma-shim.js');
type M = Record<string, (args?: unknown) => Promise<any>>;
const db = prisma as unknown as Record<string, M>;

test('the Prisma shim covers the calls the RepoRadar pipeline makes', async () => {
  const repo = await db.repo!.upsert!({
    where: { githubId: BigInt(42) },
    create: { githubId: BigInt(42), fullName: 'a/b', htmlUrl: 'https://github.com/a/b' },
    update: { fullName: 'a/b' },
    select: { id: true },
  });
  assert.ok(repo.id);
  const again = await db.repo!.upsert!({ where: { githubId: BigInt(42) }, create: {}, update: { description: 'x' }, select: { id: true } });
  assert.equal(again.id, repo.id, 'upsert finds the row by a BigInt key');

  const q = await db.searchQuery!.create!({ data: { rawPrompt: 'p', normalizedPrompt: 'p' } });
  await db.searchJob!.create!({ data: { searchQueryId: q.id, status: 'queued', progress: 0 } });
  assert.equal((await db.searchJob!.updateMany!({ where: { searchQueryId: q.id }, data: { status: 'running', progress: 30 } })).count, 1);
  const job = await db.searchJob!.findFirst!({ where: { searchQueryId: q.id }, orderBy: { createdAt: 'desc' } });
  assert.equal(job.status, 'running');
  assert.ok(job.createdAt instanceof Date);

  for (const rank of [2, 1]) await db.searchResult!.create!({ data: { searchQueryId: q.id, repoId: repo.id, rank, totalScore: rank / 10 } });
  const results = await db.searchResult!.findMany!({ where: { searchQueryId: q.id }, orderBy: { rank: 'asc' }, include: { repo: true } });
  assert.deepEqual(results.map((r: { rank: number }) => r.rank), [1, 2]);
  assert.equal(results[0].repo.fullName, 'a/b');

  await db.repoEnrichment!.upsert!({ where: { repoId: repo.id }, create: { repoId: repo.id, evidenceJson: { readme: 'r' } }, update: {} });
  const fresh = await db.repoEnrichment!.findMany!({ where: { repoId: { in: [repo.id, 'nope'] }, enrichedAt: { gte: new Date(Date.now() - 60_000) } } });
  assert.equal(fresh.length, 1);
  const stale = await db.repoEnrichment!.findMany!({ where: { repoId: { in: [repo.id] }, enrichedAt: { gte: new Date(Date.now() + 60_000) } } });
  assert.equal(stale.length, 0);

  await db.repoSnapshot!.create!({ data: { repoId: repo.id, stars: 1 } });
  assert.equal(await db.repoSnapshot!.count!({}), 0, 'history tables are not kept');
});

test('the RepoRadar bundle never writes to stdout, which belongs to the MCP transport', () => {
  const bundle = fs.readFileSync(path.join(import.meta.dirname, '..', 'reporadar', 'headless.mjs'), 'utf8');
  assert.ok(!bundle.includes('process.stdout.write('), 'upstream logger lines must go to stderr');
});

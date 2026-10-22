import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MemoryService, type MemoryLimits } from '../memory/src/memory.js';

function service(limits: Partial<MemoryLimits> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appforge-mem-'));
  const all: MemoryLimits = { maxEntries: 500, maxMB: 5, keepArchive: true, starterPack: false, ...limits };
  return { dir, mem: new MemoryService(dir, () => all), limits: all };
}

test('the entry limit archives the weakest unpinned memories', async () => {
  const { dir, mem } = service({ maxEntries: 5 });
  await mem.init();
  const pinned = await mem.write({ kind: 'preference', title: 'Pinned preference about tabs', body: 'Use tabs.', scope: 'global', pinned: true });
  const ids: string[] = [];
  for (let i = 0; i < 9; i++) {
    const r = await mem.write({ kind: 'fact', title: `Fact number ${i} about topic ${'abcdefghi'[i]}`, body: `Detail ${i} ${'xyz'.repeat(i)}`, scope: 'global' });
    ids.push(r.id);
  }
  const left = mem.list();
  assert.equal(left.length, 5);
  assert.ok(left.some((i) => i.id === pinned.id), 'pinned memory survives');
  assert.ok(left.some((i) => i.id === ids[8]), 'the memory just written survives');
  const archive = fs.readdirSync(path.join(dir, 'archive'));
  assert.equal(archive.length, 1);
  const archived = fs.readFileSync(path.join(dir, 'archive', archive[0]!), 'utf8');
  assert.equal((archived.match(/^## /gm) ?? []).length, 5);
  assert.match(fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8'), /5 active memories \(limit 5 entries/);
});

test('near-duplicates are merged and project memories stay in their project', async () => {
  const { mem } = service();
  await mem.init();
  const project = { key: 'demo-1234abcd', name: 'demo', dir: null, remote: null };
  const a = await mem.write({ kind: 'decision', title: 'Use SQLite for the cache', body: 'Small, no server.', scope: 'project', project });
  const b = await mem.write({ kind: 'decision', title: 'Use SQLite for the cache', body: 'Small, no server.', scope: 'project', project });
  assert.equal(b.duplicateOf, a.id);
  assert.match(a.id, /^project:demo-1234abcd:mem_/);
  const other = { key: 'other-99999999', name: 'other', dir: null, remote: null };
  assert.equal((await mem.recall({ query: 'sqlite cache', scope: 'project', project: other, budgetTokens: 1000 })).length, 0);
  assert.equal((await mem.recall({ query: 'sqlite cache', scope: 'all', project, budgetTokens: 1000 }))[0]?.id, a.id);
});

test('the starter pack is seeded once and reset --empty removes it for good', async () => {
  const { mem } = service({ starterPack: true });
  await mem.init();
  const seeded = mem.list().length;
  assert.ok(seeded >= 10);
  await mem.init();
  assert.equal(mem.list().length, seeded);
  await mem.reset({ empty: true });
  await mem.init();
  assert.equal(mem.list().length, 0);
});

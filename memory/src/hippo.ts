// The only file that talks to the vendored hippo-memory engine (memory/upstream). Everything else in AppForge
// goes through these few functions, so an upstream sync only has to keep this file compiling.

import fs from 'node:fs';
import { cliApiContext, cliRequest } from '../upstream/src/cli/api-context.js';
import { forget, outcome, remember, retrieve } from '../upstream/src/api/index.js';
import { initStore } from '../upstream/src/store/open.js';
import { loadAllEntries, readEntry } from '../upstream/src/store/entry-reads.js';
import { DEFAULT_TENANT_ID } from '../upstream/src/util/env.js';
import { calculateStrength, type MemoryEntry } from '../upstream/src/core/memory.js';
import { textOverlap } from '../upstream/src/util/tokenize.js';

export { textOverlap };

export type { MemoryEntry };

export interface RecallHit {
  id: string;
  content: string;
  score: number;
  strength: number;
}

const initialized = new Set<string>();

/** Creates the hippo store in `root` once per process (cheap afterwards). */
export function openRoot(root: string): void {
  if (initialized.has(root)) return;
  fs.mkdirSync(root, { recursive: true });
  // hippo prints progress for a fresh store; stdout belongs to the MCP transport, so it goes to stderr.
  withStdoutOnStderr(() => initStore(root));
  initialized.add(root);
}

function ctx(root: string) {
  openRoot(root);
  return cliApiContext(root, DEFAULT_TENANT_ID);
}

export async function hippoRemember(
  root: string,
  content: string,
  tags: string[],
  opts: { pinned?: boolean; weak?: boolean } = {},
): Promise<{ id: string; warnings: string[]; duplicateOf?: string | null }> {
  const local = {
    ...(opts.pinned ? { pinned: true } : {}),
    // A weak memory starts at half strength and decays twice as fast unless it proves useful.
    ...(opts.weak ? { weaken: { strength: 0.5, halfLifeFactor: 0.5 } } : {}),
  };
  const result = await cliRequest(() => remember(ctx(root), { content, tags, local }));
  return { id: result.id, warnings: result.warnings ?? [], duplicateOf: result.duplicate?.memoryId };
}

export async function hippoRecall(root: string, query: string, limit: number): Promise<RecallHit[]> {
  const result = await cliRequest(() => retrieve(ctx(root), { query, limit }));
  return result.results.map((r) => ({ id: r.id, content: r.content, score: r.score, strength: r.strength }));
}

export async function hippoOutcome(root: string, id: string, good: boolean): Promise<boolean> {
  const result = await cliRequest(() => outcome(ctx(root), [id], good));
  return result.appliedIds.includes(id);
}

export async function hippoForget(root: string, id: string): Promise<void> {
  await cliRequest(() => forget(ctx(root), id));
}

export function hippoRead(root: string, id: string): MemoryEntry | null {
  openRoot(root);
  return readEntry(root, id);
}

/** Current (not superseded, not archived) memories of a store. */
export function hippoList(root: string): MemoryEntry[] {
  openRoot(root);
  return loadAllEntries(root).filter((e) => e.kind !== 'superseded' && e.kind !== 'archived' && !e.superseded_by);
}

/** Strength now (0..1): decays with time since last use, grows with use and good feedback. */
export function hippoStrength(entry: MemoryEntry): number {
  return calculateStrength(entry);
}

function withStdoutOnStderr<T>(run: () => T): T {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
    (process.stderr.write as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
  try {
    return run();
  } finally {
    process.stdout.write = original;
  }
}

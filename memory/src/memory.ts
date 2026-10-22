// AppForge memory: hippo stores (one global, one per project) plus what AppForge adds on top:
// a user-set size limit with archiving, de-duplication, a starter pack, and INDEX.md / FORMAT.md so any LLM (or
// person) can read the memory as plain files without AppForge.
//
// Layout under the memory folder:
//   global/                     hippo store for memories that apply everywhere (preferences, general lessons)
//   projects/<key>/             hippo store per project, plus PROJECT.json naming the project
//   archive/<yyyy-mm>.md        memories evicted by the size limit (when memory.keepArchive is on)
//   INDEX.md, FORMAT.md         generated overview and format description

import fs from 'node:fs';
import path from 'node:path';
import {
  hippoForget,
  hippoList,
  hippoOutcome,
  hippoRead,
  hippoRecall,
  hippoRemember,
  hippoStrength,
  textOverlap,
  type MemoryEntry,
} from './hippo.js';
import { STARTER } from './starter.js';
import { FORMAT_MD } from './format.js';

export const MEMORY_KINDS = ['preference', 'lesson', 'decision', 'fact', 'pattern', 'pitfall'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type Scope = 'global' | 'project';

export interface ProjectRef {
  key: string;
  name: string;
  dir: string | null;
  remote: string | null;
}

export interface MemoryLimits {
  maxEntries: number;
  maxMB: number;
  keepArchive: boolean;
  starterPack: boolean;
}

export interface MemoryItem {
  id: string;
  scope: Scope;
  project?: string;
  kind: MemoryKind | 'note';
  title: string;
  body: string;
  tags: string[];
  strength: number;
  pinned: boolean;
  created: string;
  lastUsed: string;
  uses: number;
  file: string;
}

export interface WriteInput {
  kind: MemoryKind;
  title: string;
  body: string;
  tags?: string[];
  scope: Scope;
  project?: ProjectRef;
  pinned?: boolean;
}

export interface WriteResult {
  id: string;
  duplicateOf?: string;
  evicted: Array<{ id: string; title: string }>;
  warnings: string[];
}

interface Located {
  scope: Scope;
  projectKey?: string;
  root: string;
  hippoId: string;
}

const STARTER_TAG = 'starter';

export class MemoryService {
  constructor(
    readonly dir: string,
    private readonly limits: () => MemoryLimits,
  ) {}

  // ---- locations and ids ------------------------------------------------------------------------------------

  private globalRoot(): string {
    return path.join(this.dir, 'global');
  }

  private projectRoot(key: string): string {
    return path.join(this.dir, 'projects', key);
  }

  private makeId(scope: Scope, hippoId: string, projectKey?: string): string {
    return scope === 'global' ? `global:${hippoId}` : `project:${projectKey}:${hippoId}`;
  }

  private locate(id: string): Located {
    const parts = id.trim().split(':');
    if (parts[0] === 'global' && parts.length === 2) return { scope: 'global', root: this.globalRoot(), hippoId: parts[1]! };
    if (parts[0] === 'project' && parts.length === 3) {
      return { scope: 'project', projectKey: parts[1]!, root: this.projectRoot(parts[1]!), hippoId: parts[2]! };
    }
    throw new Error(`Unknown memory id "${id}". Ids look like "global:mem_1a2b3c" or "project:<key>:mem_1a2b3c".`);
  }

  private projectKeys(): string[] {
    try {
      return fs
        .readdirSync(path.join(this.dir, 'projects'), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  }

  private projectName(key: string): string {
    try {
      return (JSON.parse(fs.readFileSync(path.join(this.projectRoot(key), 'PROJECT.json'), 'utf8')) as ProjectRef).name;
    } catch {
      return key;
    }
  }

  private rememberProject(p: ProjectRef): void {
    const root = this.projectRoot(p.key);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'PROJECT.json'), JSON.stringify(p, null, 2) + '\n');
  }

  /** Every store with its scope, for listing and limits. */
  private allStores(): Located[] {
    const out: Located[] = [];
    if (fs.existsSync(this.globalRoot())) out.push({ scope: 'global', root: this.globalRoot(), hippoId: '' });
    for (const key of this.projectKeys()) out.push({ scope: 'project', projectKey: key, root: this.projectRoot(key), hippoId: '' });
    return out;
  }

  // ---- conversions ------------------------------------------------------------------------------------------

  private toItem(e: MemoryEntry, where: Located): MemoryItem {
    const [first, ...rest] = e.content.split('\n');
    const kind = (e.tags.find((t) => (MEMORY_KINDS as readonly string[]).includes(t)) as MemoryKind | undefined) ?? 'note';
    return {
      id: this.makeId(where.scope, e.id, where.projectKey),
      scope: where.scope,
      project: where.projectKey ? this.projectName(where.projectKey) : undefined,
      kind,
      title: (first ?? '').trim(),
      body: rest.join('\n').trim(),
      tags: e.tags.filter((t) => t !== kind),
      strength: round(hippoStrength(e)),
      pinned: e.pinned,
      created: e.created,
      lastUsed: e.last_retrieved,
      uses: e.retrieval_count,
      file: path.relative(this.dir, path.join(where.root, e.layer, `${e.id}.md`)).replace(/\\/g, '/'),
    };
  }

  // ---- public API -------------------------------------------------------------------------------------------

  /** Creates the folders, FORMAT.md and (once) the starter pack. Safe to call often. */
  async init(): Promise<void> {
    fs.mkdirSync(this.globalRoot(), { recursive: true });
    const format = path.join(this.dir, 'FORMAT.md');
    if (!fs.existsSync(format) || fs.readFileSync(format, 'utf8') !== FORMAT_MD) fs.writeFileSync(format, FORMAT_MD);
    const marker = path.join(this.dir, '.starter-seeded');
    if (this.limits().starterPack && !fs.existsSync(marker) && hippoList(this.globalRoot()).length === 0) {
      for (const s of STARTER) {
        await hippoRemember(this.globalRoot(), `${s.title}\n\n${s.body}`, [s.kind, STARTER_TAG, ...s.tags], { weak: true });
      }
      fs.writeFileSync(marker, new Date().toISOString() + '\n');
    }
    this.writeIndex();
  }

  async write(input: WriteInput): Promise<WriteResult> {
    const title = input.title.trim().split('\n')[0]!.slice(0, 200);
    const body = input.body.trim();
    if (!title) throw new Error('A memory needs a title (one line saying what it is about).');
    if (input.scope === 'project' && !input.project) throw new Error('A project memory needs a project.');
    const root = input.scope === 'global' ? this.globalRoot() : this.projectRoot(input.project!.key);
    if (input.project && input.scope === 'project') this.rememberProject(input.project);
    const where: Located = { scope: input.scope, projectKey: input.project?.key, root, hippoId: '' };
    const content = body ? `${title}\n\n${body}` : title;

    // Near-identical memory already there: strengthen it instead of storing a second copy. (A plain scan, not a
    // recall, so checking does not count as using the other memories.)
    if (fs.existsSync(root)) {
      const twin = hippoList(root).find((e) => textOverlap(e.content, content) >= 0.85);
      if (twin) {
        await hippoOutcome(root, twin.id, true);
        const twinId = this.makeId(where.scope, twin.id, where.projectKey);
        return { id: twinId, duplicateOf: twinId, evicted: [], warnings: [] };
      }
    }

    const tags = [input.kind, ...(input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)];
    const res = await hippoRemember(root, content, Array.from(new Set(tags)), { pinned: input.pinned });
    const id = this.makeId(where.scope, res.id, where.projectKey);
    const evicted = await this.enforceLimits(new Set([id]));
    this.writeIndex();
    return { id, evicted, warnings: res.warnings };
  }

  /** Ranked memories for a query, cut to a token budget (about 4 characters per token). */
  async recall(opts: { query: string; scope: Scope | 'all'; project?: ProjectRef; budgetTokens: number; limit?: number }): Promise<MemoryItem[] & { truncated?: number }> {
    const stores: Located[] = [];
    if (opts.scope !== 'project') stores.push({ scope: 'global', root: this.globalRoot(), hippoId: '' });
    if (opts.scope !== 'global' && opts.project && fs.existsSync(this.projectRoot(opts.project.key))) {
      stores.push({ scope: 'project', projectKey: opts.project.key, root: this.projectRoot(opts.project.key), hippoId: '' });
    }
    const limit = opts.limit ?? 10;
    const hits: Array<{ score: number; item: MemoryItem }> = [];
    for (const s of stores) {
      if (!fs.existsSync(s.root)) continue;
      for (const h of await hippoRecall(s.root, opts.query, limit)) {
        const e = hippoRead(s.root, h.id);
        if (e) hits.push({ score: h.score, item: this.toItem(e, s) });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    const out: MemoryItem[] & { truncated?: number } = [];
    let used = 0;
    for (const { item } of hits.slice(0, limit)) {
      const cost = Math.ceil((item.title.length + item.body.length + 60) / 4);
      if (out.length > 0 && used + cost > opts.budgetTokens) {
        out.truncated = (out.truncated ?? 0) + 1;
        continue;
      }
      used += cost;
      out.push(item);
    }
    return out;
  }

  read(id: string): MemoryItem {
    const where = this.locate(id);
    const e = hippoRead(where.root, where.hippoId);
    if (!e || e.kind === 'superseded' || e.kind === 'archived') throw new Error(`No memory ${id}.`);
    return this.toItem(e, where);
  }

  /** Replaces a memory's text or tags (stored as a new memory; the old one is forgotten). */
  async update(id: string, patch: { title?: string; body?: string; tags?: string[]; kind?: MemoryKind }): Promise<WriteResult> {
    const old = this.read(id);
    const where = this.locate(id);
    const project = where.projectKey
      ? ((): ProjectRef => {
          try {
            return JSON.parse(fs.readFileSync(path.join(where.root, 'PROJECT.json'), 'utf8')) as ProjectRef;
          } catch {
            return { key: where.projectKey!, name: where.projectKey!, dir: null, remote: null };
          }
        })()
      : undefined;
    await hippoForget(where.root, where.hippoId);
    const res = await this.write({
      kind: patch.kind ?? (old.kind === 'note' ? 'fact' : old.kind),
      title: patch.title ?? old.title,
      body: patch.body ?? old.body,
      tags: patch.tags ?? old.tags.filter((t) => t !== STARTER_TAG),
      scope: where.scope,
      project,
      pinned: old.pinned,
    });
    return res;
  }

  /** "helpful" makes a memory stronger, "wrong" weaker (it then ranks lower and fades sooner). */
  async feedback(id: string, helpful: boolean): Promise<void> {
    const where = this.locate(id);
    this.read(id);
    await hippoOutcome(where.root, where.hippoId, helpful);
  }

  async forget(id: string): Promise<MemoryItem> {
    const item = this.read(id);
    const where = this.locate(id);
    await hippoForget(where.root, where.hippoId);
    this.writeIndex();
    return item;
  }

  list(filter: { scope?: Scope | 'all'; projectKey?: string } = {}): MemoryItem[] {
    const out: MemoryItem[] = [];
    for (const s of this.allStores()) {
      if (filter.scope && filter.scope !== 'all' && s.scope !== filter.scope) continue;
      if (filter.projectKey && s.scope === 'project' && s.projectKey !== filter.projectKey) continue;
      for (const e of hippoList(s.root)) out.push(this.toItem(e, s));
    }
    return out;
  }

  stats() {
    const items = this.list();
    const bytes = items.reduce((n, i) => n + Buffer.byteLength(i.title) + Buffer.byteLength(i.body), 0);
    const limits = this.limits();
    const byScope: Record<string, number> = {};
    for (const i of items) {
      const k = i.scope === 'global' ? 'global' : `project ${i.project}`;
      byScope[k] = (byScope[k] ?? 0) + 1;
    }
    return {
      entries: items.length,
      textMB: round(bytes / 1_048_576, 3),
      diskMB: round(dirSize(this.dir) / 1_048_576, 2),
      limits: { maxEntries: limits.maxEntries, maxMB: limits.maxMB },
      usedPercent: round(Math.max(items.length / limits.maxEntries, bytes / 1_048_576 / limits.maxMB) * 100, 1),
      byScope,
      starter: items.filter((i) => i.tags.includes(STARTER_TAG)).length,
      pinned: items.filter((i) => i.pinned).length,
      archiveMB: round(dirSize(path.join(this.dir, 'archive')) / 1_048_576, 2),
      folder: this.dir,
    };
  }

  /** Merges near-duplicates (keeps the stronger one) and enforces the limits. */
  async consolidate(): Promise<{ merged: Array<{ removed: string; kept: string }>; evicted: Array<{ id: string; title: string }> }> {
    const merged: Array<{ removed: string; kept: string }> = [];
    for (const s of this.allStores()) {
      const items = hippoList(s.root).map((e) => ({ e, item: this.toItem(e, s) }));
      const gone = new Set<string>();
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i]!;
          const b = items[j]!;
          if (gone.has(a.e.id) || gone.has(b.e.id)) continue;
          if (textOverlap(a.e.content, b.e.content) < 0.85) continue;
          const [keep, drop] = a.item.pinned || a.item.strength >= b.item.strength ? [a, b] : [b, a];
          if (drop.item.pinned) continue;
          await hippoForget(s.root, drop.e.id);
          await hippoOutcome(s.root, keep.e.id, true);
          gone.add(drop.e.id);
          merged.push({ removed: drop.item.id, kept: keep.item.id });
        }
      }
    }
    const evicted = await this.enforceLimits(new Set());
    this.writeIndex();
    return { merged, evicted };
  }

  /** Removes every memory (global and all projects), then re-seeds the starter pack unless `empty`. */
  async reset(opts: { empty: boolean }): Promise<number> {
    const items = this.list();
    for (const item of items) {
      const where = this.locate(item.id);
      await hippoForget(where.root, where.hippoId);
    }
    const marker = path.join(this.dir, '.starter-seeded');
    if (opts.empty) fs.writeFileSync(marker, 'reset --empty\n');
    else fs.rmSync(marker, { force: true });
    await this.init();
    return items.length;
  }

  // ---- limits -----------------------------------------------------------------------------------------------

  /**
   * Over the limit: the least valuable unpinned memories leave first. Value = current strength (decays when unused,
   * grows with use and good feedback), halved for starter entries and for ones marked wrong more than helpful.
   */
  private async enforceLimits(protect: Set<string>): Promise<Array<{ id: string; title: string }>> {
    const { maxEntries, maxMB, keepArchive } = this.limits();
    const maxBytes = maxMB * 1_048_576;
    const pool: Array<{ where: Located; e: MemoryEntry; item: MemoryItem; value: number; bytes: number }> = [];
    for (const s of this.allStores()) {
      for (const e of hippoList(s.root)) {
        const item = this.toItem(e, s);
        let value = item.strength * (1 + Math.log1p(item.uses));
        if (item.tags.includes(STARTER_TAG)) value *= 0.5;
        if (e.outcome_negative > e.outcome_positive) value *= 0.5;
        pool.push({ where: s, e, item, value, bytes: Buffer.byteLength(e.content) });
      }
    }
    let count = pool.length;
    let bytes = pool.reduce((n, p) => n + p.bytes, 0);
    if (count <= maxEntries && bytes <= maxBytes) return [];
    const victims = pool.filter((p) => !p.item.pinned && !protect.has(p.item.id)).sort((a, b) => a.value - b.value);
    const evicted: Array<{ id: string; title: string }> = [];
    for (const v of victims) {
      if (count <= maxEntries && bytes <= maxBytes) break;
      if (keepArchive) this.archive(v.item);
      await hippoForget(v.where.root, v.e.id);
      evicted.push({ id: v.item.id, title: v.item.title });
      count--;
      bytes -= v.bytes;
    }
    return evicted;
  }

  private archive(item: MemoryItem): void {
    const dir = path.join(this.dir, 'archive');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().slice(0, 7)}.md`);
    const where = item.scope === 'global' ? 'global' : `project ${item.project}`;
    const block = [
      `## ${item.title}`,
      '',
      `- id: ${item.id} (${where}), kind: ${item.kind}, tags: ${item.tags.join(', ') || '-'}`,
      `- created ${item.created}, last used ${item.lastUsed}, uses ${item.uses}, strength ${item.strength}`,
      `- archived ${new Date().toISOString()} because the memory limit was reached`,
      '',
      item.body,
      '',
    ].join('\n');
    if (!fs.existsSync(file)) fs.writeFileSync(file, '# Archived AppForge memories\n\nEvicted by the size limit; not searched. Restore one by writing it again with memory_write.\n\n');
    fs.appendFileSync(file, block + '\n');
  }

  // ---- INDEX.md ---------------------------------------------------------------------------------------------

  writeIndex(): void {
    try {
      const items = this.list().sort((a, b) => b.strength - a.strength);
      const limits = this.limits();
      const groups = new Map<string, MemoryItem[]>();
      for (const i of items) {
        const k = i.scope === 'global' ? 'Global' : `Project: ${i.project}`;
        groups.set(k, [...(groups.get(k) ?? []), i]);
      }
      const lines = [
        '# AppForge memory index',
        '',
        `Generated ${new Date().toISOString()}. ${items.length} active memories (limit ${limits.maxEntries} entries / ${limits.maxMB} MB).`,
        'Each line: [kind] title, id, strength (0-1), file. The format of the files is described in FORMAT.md.',
        '',
      ];
      for (const [group, list] of groups) {
        lines.push(`## ${group}`, '');
        for (const i of list) lines.push(`- [${i.kind}] ${i.title} | ${i.id} | ${i.strength}${i.pinned ? ' | pinned' : ''} | ${i.file}`);
        lines.push('');
      }
      fs.writeFileSync(path.join(this.dir, 'INDEX.md'), lines.join('\n'));
    } catch {
      // the index is a convenience; never fail a write because of it
    }
  }
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      total += d.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
  } catch {
    // missing folder
  }
  return total;
}

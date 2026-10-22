// Stands in for @prisma/client so RepoRadar's pipeline runs without PostgreSQL/pgvector or Docker.
// The bundler (scripts/build-reporadar.mjs) points "@prisma/client" and "@/lib/db" here; the upstream code is
// unchanged. It implements just the Prisma calls the pipeline makes, over one SQLite file in the AppForge cache:
// every model is a table of JSON documents. RepoRadar computes vector similarity in JS, so no vector index is needed.
// Write-only history tables (snapshots, READMEs, embeddings) are not kept at all, to keep the file small.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Doc = Record<string, unknown>;
type Where = Record<string, unknown>;

/** Models whose rows are never read back by the headless pipeline. */
const DISCARDED = new Set(['repoSnapshot', 'repoReadme', 'siteVisitor']);
/** Unique keys used in `where` of findUnique / upsert / update. */
const DATE_FIELDS = new Set(['createdAt', 'updatedAt', 'fetchedAt', 'enrichedAt', 'pushedAt', 'firstSeenAt', 'lastSeenAt']);
/** Fields with a now() default per model (from the upstream schema). */
const NOW_DEFAULTS: Record<string, string[]> = {
  repo: ['fetchedAt'],
  repoEnrichment: ['enrichedAt'],
  searchCandidateCache: ['createdAt'],
  searchQuery: ['createdAt'],
  searchResult: ['createdAt'],
  modelAnalysis: ['createdAt'],
  searchJob: ['createdAt', 'updatedAt'],
};
const DEFAULTS: Record<string, Doc> = {
  searchJob: { status: 'queued', progress: 0 },
  repo: { isArchived: false, isFork: false },
};

/** Keys the pipeline looks rows up by; SQLite indexes them so lookups stay fast as the cache grows. */
const INDEXED = ['githubId', 'fullName', 'repoId', 'searchQueryId', 'inputHash', 'queryHash'];

function dbFile(): string {
  const dir = process.env.APPFORGE_RADAR_DB_DIR || path.join(process.cwd(), '.reporadar');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'reporadar.db');
}

let db: DatabaseSync | null = null;
function open(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(dbFile());
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS docs (model TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (model, id));
  `);
  for (const key of INDEXED) db.exec(`CREATE INDEX IF NOT EXISTS docs_${key} ON docs (model, json_extract(data, '$.${key}'))`);
  // Caches older than 30 days are not worth their disk space.
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
  db.prepare(`DELETE FROM docs WHERE model IN ('searchCandidateCache','repoEnrichment','modelAnalysis','searchResult','searchJob','searchQuery')
              AND COALESCE(json_extract(data,'$.createdAt'), json_extract(data,'$.enrichedAt')) < ?`).run(cutoff);
  return db;
}

function encode(doc: Doc): string {
  return JSON.stringify(doc, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function decode(s: string): Doc {
  const d = JSON.parse(s) as Doc;
  for (const k of Object.keys(d)) if (DATE_FIELDS.has(k) && typeof d[k] === 'string') d[k] = new Date(d[k] as string);
  return d;
}

function norm(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.getTime();
  return v;
}

function matches(doc: Doc, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    const val = norm(doc[k]);
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ('in' in c && !(c.in as unknown[]).map(norm).includes(val)) return false;
      if ('gte' in c && !((val as number) >= (norm(c.gte) as number))) return false;
      if ('lte' in c && !((val as number) <= (norm(c.lte) as number))) return false;
      if ('gt' in c && !((val as number) > (norm(c.gt) as number))) return false;
      if ('lt' in c && !((val as number) < (norm(c.lt) as number))) return false;
      if ('equals' in c && norm(c.equals) !== val) return false;
      if ('not' in c && norm(c.not) === val) return false;
    } else if (norm(cond) !== val) {
      return false;
    }
  }
  return true;
}

function pick(doc: Doc, select?: Record<string, boolean>): Doc {
  if (!select) return doc;
  const out: Doc = {};
  for (const [k, on] of Object.entries(select)) if (on) out[k] = doc[k];
  return out;
}

class Model {
  constructor(private readonly name: string) {}

  /** Rows that may match: plain equality and "in" conditions are filtered in SQL, the rest by matches(). */
  private all(where?: Where): Doc[] {
    if (DISCARDED.has(this.name)) return [];
    const sql = ['SELECT data FROM docs WHERE model = ?'];
    const params: Array<string | number> = [this.name];
    for (const [k, cond] of Object.entries(where ?? {})) {
      const field = k === 'id' ? 'id' : `json_extract(data, '$.${k}')`;
      const v = norm(cond);
      if (typeof v === 'string' || (typeof v === 'number' && !(cond instanceof Date))) {
        sql.push(`AND ${field} = ?`);
        params.push(v);
      } else if (cond && typeof cond === 'object' && Array.isArray((cond as { in?: unknown[] }).in)) {
        const list = ((cond as { in: unknown[] }).in).map(norm).filter((x): x is string | number => typeof x === 'string' || typeof x === 'number');
        if (!list.length) return [];
        sql.push(`AND ${field} IN (${list.map(() => '?').join(',')})`);
        params.push(...list);
      }
    }
    return (open().prepare(sql.join(' ')).all(...params) as Array<{ data: string }>).map((r) => decode(r.data));
  }

  private save(doc: Doc): void {
    if (DISCARDED.has(this.name)) return;
    if ('updatedAt' in doc || NOW_DEFAULTS[this.name]?.includes('updatedAt')) doc.updatedAt = new Date();
    open().prepare('INSERT OR REPLACE INTO docs (model, id, data) VALUES (?, ?, ?)').run(this.name, String(doc.id), encode(doc));
  }

  private withDefaults(data: Doc): Doc {
    const doc: Doc = { id: crypto.randomUUID(), ...(DEFAULTS[this.name] ?? {}) };
    for (const f of NOW_DEFAULTS[this.name] ?? []) doc[f] = new Date();
    return { ...doc, ...data };
  }

  private sorted(rows: Doc[], orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>): Doc[] {
    const keys = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return rows.sort((a, b) => {
      for (const o of keys) {
        const [k, dir] = Object.entries(o)[0]!;
        const x = norm(a[k]) as number;
        const y = norm(b[k]) as number;
        if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
      }
      return 0;
    });
  }

  private include(doc: Doc, include?: Record<string, boolean>): Doc {
    if (!include) return doc;
    const out = { ...doc };
    for (const [rel, on] of Object.entries(include)) {
      if (!on) continue;
      const fk = doc[`${rel}Id`];
      out[rel] = fk ? (models[rel]?.all({ id: fk }).at(0) ?? null) : null;
    }
    return out;
  }

  async create(args: { data: Doc; select?: Record<string, boolean> }): Promise<Doc> {
    const doc = this.withDefaults(args.data);
    this.save(doc);
    return pick(doc, args.select);
  }

  async findUnique(args: { where: Where; select?: Record<string, boolean>; include?: Record<string, boolean> }): Promise<Doc | null> {
    return this.findFirst(args);
  }

  async findFirst(args: { where?: Where; orderBy?: Record<string, 'asc' | 'desc'>; select?: Record<string, boolean>; include?: Record<string, boolean> } = {}): Promise<Doc | null> {
    const row = this.sorted(this.all(args.where).filter((d) => matches(d, args.where)), args.orderBy)[0];
    return row ? pick(this.include(row, args.include), args.select) : null;
  }

  async findMany(args: { where?: Where; orderBy?: Record<string, 'asc' | 'desc'>; select?: Record<string, boolean>; include?: Record<string, boolean>; take?: number } = {}): Promise<Doc[]> {
    const rows = this.sorted(this.all(args.where).filter((d) => matches(d, args.where)), args.orderBy);
    return rows.slice(0, args.take ?? rows.length).map((r) => pick(this.include(r, args.include), args.select));
  }

  async update(args: { where: Where; data: Doc; select?: Record<string, boolean> }): Promise<Doc> {
    const row = this.all(args.where).find((d) => matches(d, args.where));
    if (!row) throw new Error(`${this.name}: record to update not found`);
    const doc = { ...row, ...args.data };
    this.save(doc);
    return pick(doc, args.select);
  }

  async updateMany(args: { where?: Where; data: Doc }): Promise<{ count: number }> {
    const rows = this.all(args.where).filter((d) => matches(d, args.where));
    for (const r of rows) this.save({ ...r, ...args.data });
    return { count: rows.length };
  }

  async upsert(args: { where: Where; create: Doc; update: Doc; select?: Record<string, boolean> }): Promise<Doc> {
    const row = this.all(args.where).find((d) => matches(d, args.where));
    const doc = row ? { ...row, ...args.update } : this.withDefaults(args.create);
    this.save(doc);
    return pick(doc, args.select);
  }

  async delete(args: { where: Where }): Promise<Doc | null> {
    const row = this.all(args.where).find((d) => matches(d, args.where));
    if (row) open().prepare('DELETE FROM docs WHERE model = ? AND id = ?').run(this.name, String(row.id));
    return row ?? null;
  }

  async deleteMany(args: { where?: Where } = {}): Promise<{ count: number }> {
    const rows = this.all(args.where).filter((d) => matches(d, args.where));
    for (const r of rows) open().prepare('DELETE FROM docs WHERE model = ? AND id = ?').run(this.name, String(r.id));
    return { count: rows.length };
  }

  async count(args: { where?: Where } = {}): Promise<number> {
    return this.all(args.where).filter((d) => matches(d, args.where)).length;
  }
}

const models: Record<string, Model> = {};
for (const m of ['repo', 'repoEnrichment', 'repoSnapshot', 'repoReadme', 'repoEmbedding', 'searchCandidateCache', 'searchQuery', 'searchResult', 'modelAnalysis', 'searchJob', 'siteVisitor']) {
  models[m] = new Model(m);
}

export class PrismaClient {
  constructor(_opts?: unknown) {
    Object.assign(this, models);
  }
  /** Raw SQL is only used upstream to store embeddings, which the headless pipeline does not keep. */
  async $executeRawUnsafe(): Promise<number> {
    return 0;
  }
  async $queryRawUnsafe(): Promise<unknown[]> {
    return [];
  }
  async $queryRaw(): Promise<unknown[]> {
    return [];
  }
  async $disconnect(): Promise<void> {}
  async $connect(): Promise<void> {}
}

/** Prisma's namespace export; the pipeline only uses it for types. */
export const Prisma = {};

// "@/lib/db" is also mapped here: the pipeline imports `prisma` from it.
export const prisma = new PrismaClient() as unknown as Record<string, Model> & PrismaClient;

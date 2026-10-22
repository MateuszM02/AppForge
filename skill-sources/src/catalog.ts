// The local skill/plugin catalog: one SQLite file (cache/skills.db) with a full-text index. skill-sources fills it
// from GitHub (sync.ts); skill-browser searches it. Nothing from the source repos is stored except names,
// descriptions and where each item lives.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type ItemKind = 'skill' | 'plugin' | 'command' | 'agent' | 'mcp';

/** Where an item's files are: a GitHub repo folder (or single file) at a commit. */
export interface ItemLocation {
  owner: string;
  repo: string;
  /** Commit SHA (preferred) or branch/tag. */
  ref: string;
  /** Folder (skill, plugin) or file (command, agent, .mcp.json) inside the repo; "" = repo root. */
  path: string;
}

export interface CatalogItem {
  id: string;
  source: string;
  kind: ItemKind;
  name: string;
  description: string;
  /** For components: the plugin they belong to. */
  plugin: string | null;
  category: string | null;
  license: string | null;
  homepage: string | null;
  /** Null when the files are not on GitHub (then only the homepage is known). */
  location: ItemLocation | null;
  /** Extra facts: plugin components, MCP server config, marketplace name, ... */
  extra: Record<string, unknown>;
}

export class Catalog {
  private db: DatabaseSync;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sources (key TEXT PRIMARY KEY, sha TEXT, synced_at INTEGER, items INTEGER, error TEXT);
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
        plugin TEXT, category TEXT, license TEXT, homepage TEXT, location TEXT, extra TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS items_source ON items(source);
      CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(id UNINDEXED, name, description, plugin, category, tokenize = 'porter unicode61');
    `);
  }

  sourceState(key: string): { sha: string | null; syncedAt: number | null; items: number; error: string | null } {
    const r = this.db.prepare('SELECT sha, synced_at, items, error FROM sources WHERE key = ?').get(key) as
      | { sha: string | null; synced_at: number | null; items: number; error: string | null }
      | undefined;
    return { sha: r?.sha ?? null, syncedAt: r?.synced_at ?? null, items: r?.items ?? 0, error: r?.error ?? null };
  }

  markChecked(key: string, error: string | null = null): void {
    this.db
      .prepare('INSERT INTO sources (key, synced_at, items, error) VALUES (?, ?, 0, ?) ON CONFLICT(key) DO UPDATE SET synced_at = excluded.synced_at, error = excluded.error')
      .run(key, Date.now(), error);
  }

  /** Replaces every item of a source in one transaction. */
  replaceSource(key: string, sha: string, items: CatalogItem[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM items_fts WHERE id IN (SELECT id FROM items WHERE source = ?)').run(key);
      this.db.prepare('DELETE FROM items WHERE source = ?').run(key);
      const ins = this.db.prepare(
        'INSERT OR REPLACE INTO items (id, source, kind, name, description, plugin, category, license, homepage, location, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      );
      const fts = this.db.prepare('INSERT INTO items_fts (id, name, description, plugin, category) VALUES (?,?,?,?,?)');
      for (const it of items) {
        ins.run(it.id, key, it.kind, it.name, it.description, it.plugin, it.category, it.license, it.homepage, it.location ? JSON.stringify(it.location) : null, JSON.stringify(it.extra));
        fts.run(it.id, it.name.replace(/[-_]/g, ' ') + ' ' + it.name, it.description, it.plugin ?? '', it.category ?? '');
      }
      this.db
        .prepare('INSERT INTO sources (key, sha, synced_at, items, error) VALUES (?, ?, ?, ?, NULL) ON CONFLICT(key) DO UPDATE SET sha = excluded.sha, synced_at = excluded.synced_at, items = excluded.items, error = NULL')
        .run(key, sha, Date.now(), items.length);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  removeSource(key: string): void {
    this.db.prepare('DELETE FROM items_fts WHERE id IN (SELECT id FROM items WHERE source = ?)').run(key);
    this.db.prepare('DELETE FROM items WHERE source = ?').run(key);
    this.db.prepare('DELETE FROM sources WHERE key = ?').run(key);
  }

  private row(r: Record<string, unknown>): CatalogItem {
    return {
      id: r.id as string,
      source: r.source as string,
      kind: r.kind as ItemKind,
      name: r.name as string,
      description: r.description as string,
      plugin: (r.plugin as string | null) ?? null,
      category: (r.category as string | null) ?? null,
      license: (r.license as string | null) ?? null,
      homepage: (r.homepage as string | null) ?? null,
      location: r.location ? (JSON.parse(r.location as string) as ItemLocation) : null,
      extra: JSON.parse((r.extra as string) || '{}') as Record<string, unknown>,
    };
  }

  get(id: string): CatalogItem | null {
    const r = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.row(r) : null;
  }

  /** Items whose name is exactly `name` (ids are long; agents often pass the name). */
  byName(name: string): CatalogItem[] {
    return (this.db.prepare('SELECT * FROM items WHERE lower(name) = lower(?)').all(name) as Record<string, unknown>[]).map((r) => this.row(r));
  }

  components(plugin: string, source: string): CatalogItem[] {
    return (this.db.prepare('SELECT * FROM items WHERE plugin = ? AND source = ?').all(plugin, source) as Record<string, unknown>[]).map((r) => this.row(r));
  }

  /**
   * Full-text search (BM25; name weighs most). Words are matched as prefixes and any word may match, so
   * "pdf form" finds "pdf" skills that never say "form".
   */
  search(query: string, filters: { kind?: ItemKind; sources?: string[]; limit?: number } = {}): Array<CatalogItem & { score: number }> {
    const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filters.kind) {
      where.push('i.kind = ?');
      params.push(filters.kind);
    }
    if (filters.sources?.length) {
      where.push(`i.source IN (${filters.sources.map(() => '?').join(',')})`);
      params.push(...filters.sources);
    }
    const limit = filters.limit ?? 20;
    if (words.length === 0) {
      const sql = `SELECT i.* FROM items i ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.kind, i.name LIMIT ?`;
      return (this.db.prepare(sql).all(...params, limit) as Record<string, unknown>[]).map((r) => ({ ...this.row(r), score: 0 }));
    }
    const match = words.map((w) => `"${w}"*`).join(' OR ');
    const sql = `SELECT i.*, bm25(items_fts, 0, 10.0, 3.0, 2.0, 1.0) AS rank FROM items_fts JOIN items i ON i.id = items_fts.id
      WHERE items_fts MATCH ? ${where.length ? 'AND ' + where.join(' AND ') : ''} ORDER BY rank LIMIT ?`;
    return (this.db.prepare(sql).all(match, ...params, limit) as Record<string, unknown>[]).map((r) => ({
      ...this.row(r),
      score: Math.round(-(r.rank as number) * 100) / 100,
    }));
  }

  counts(): Array<{ source: string; kind: string; n: number }> {
    return this.db.prepare('SELECT source, kind, COUNT(*) AS n FROM items GROUP BY source, kind ORDER BY source, kind').all() as Array<{
      source: string;
      kind: string;
      n: number;
    }>;
  }

  close(): void {
    this.db.close();
  }
}

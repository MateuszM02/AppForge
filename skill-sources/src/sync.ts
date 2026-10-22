// Fills the catalog from GitHub without downloading the source repos:
//   1 API call   commit SHA of the default branch (ETag: free when nothing changed)
//   1 API call   the recursive file list at that SHA (only when the SHA changed)
//   raw files    SKILL.md / command / agent front matter and marketplace.json from raw.githubusercontent.com
//                (no API quota; cached forever per SHA)
// Sources are either "skills" repos (folders with SKILL.md) or Claude plugin marketplaces
// (.claude-plugin/marketplace.json listing plugins in the repo or in other repos).

import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ghHeadSha, ghRaw, ghTree, parseRepo, type TreeEntry } from '../../server/src/github.js';
import { logger } from '../../server/src/log.js';
import type { SkillSourceConfig } from '../../server/src/config.js';
import type { Catalog, CatalogItem, ItemLocation } from './catalog.js';

const log = logger('skills-sync');

export interface SyncReport {
  source: string;
  status: 'unchanged' | 'updated' | 'skipped' | 'failed';
  sha?: string;
  items?: number;
  error?: string;
}

/** Front matter of a Markdown file (between the first two "---" lines), or {} when there is none or it is broken. */
export function frontMatter(md: string): Record<string, unknown> {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  try {
    const v = parseYaml(m[1]!) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    // Some descriptions contain unquoted ": " that strict YAML rejects; fall back to "key: value" lines.
    const out: Record<string, unknown> = {};
    for (const line of m[1]!.split(/\r?\n/)) {
      const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (kv) out[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '');
    }
    return out;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function firstParagraph(md: string): string {
  const body = md.replace(/^﻿?---[\s\S]*?\n---\s*/, '');
  const para = body
    .split(/\r?\n\r?\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith('#'));
  return (para ?? '').replace(/\s+/g, ' ').slice(0, 300);
}

async function pool<T, R>(items: T[], n: number, run: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await run(items[i]!);
      }
    }),
  );
  return out;
}

const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
const baseName = (p: string) => p.split('/').pop()!.replace(/\.md$/i, '');

/** SKILL.md files under `prefix` -> skill items. */
async function skillsUnder(
  src: SkillSourceConfig,
  sha: string,
  tree: TreeEntry[],
  prefix: string,
  plugin: string | null,
  idPrefix: string,
): Promise<CatalogItem[]> {
  const files = tree.filter((t) => t.type === 'blob' && /(^|\/)SKILL\.md$/.test(t.path) && (prefix === '' || t.path.startsWith(prefix)));
  const items = await pool(files, 8, async (f): Promise<CatalogItem | null> => {
    const md = await ghRaw(src.owner, src.repo, sha, f.path);
    if (!md) return null;
    const fm = frontMatter(md);
    const dir = dirOf(f.path);
    const name = str(fm.name) ?? baseName(dir);
    const licenseFile = tree.find((t) => t.path === `${dir}/LICENSE.txt` || t.path === `${dir}/LICENSE`)?.path ?? null;
    return {
      id: `${idPrefix}skill/${plugin ? plugin + '/' : ''}${name}`,
      source: src.key,
      kind: 'skill',
      name,
      description: str(fm.description) ?? firstParagraph(md),
      plugin,
      category: null,
      license: str(fm.license) ?? (licenseFile ? `see ${licenseFile}` : null),
      homepage: `https://github.com/${src.owner}/${src.repo}/tree/${sha}/${dir}`,
      location: { owner: src.owner, repo: src.repo, ref: sha, path: dir },
      extra: { files: tree.filter((t) => t.type === 'blob' && t.path.startsWith(dir + '/')).length },
    };
  });
  return items.filter((i): i is CatalogItem => i !== null);
}

/** commands/*.md, agents/*.md and .mcp.json of a plugin folder in the same repo. */
async function pluginComponents(src: SkillSourceConfig, sha: string, tree: TreeEntry[], dir: string, plugin: string): Promise<CatalogItem[]> {
  const prefix = dir ? dir + '/' : '';
  const out: CatalogItem[] = await skillsUnder(src, sha, tree, prefix + 'skills/', plugin, `${src.key}/`);
  const mdFiles = tree.filter((t) => t.type === 'blob' && new RegExp(`^${escapeRe(prefix)}(commands|agents)/[^/]+\\.md$`).test(t.path));
  const md = await pool(mdFiles, 8, async (f): Promise<CatalogItem | null> => {
    const text = await ghRaw(src.owner, src.repo, sha, f.path);
    if (text === null) return null;
    const fm = frontMatter(text);
    const kind = f.path.slice(prefix.length).startsWith('commands/') ? 'command' : 'agent';
    const name = str(fm.name) ?? baseName(f.path);
    return {
      id: `${src.key}/${kind}/${plugin}:${name}`,
      source: src.key,
      kind,
      name: kind === 'command' ? `/${plugin}:${name}` : name,
      description: str(fm.description) ?? firstParagraph(text),
      plugin,
      category: null,
      license: null,
      homepage: `https://github.com/${src.owner}/${src.repo}/blob/${sha}/${f.path}`,
      location: { owner: src.owner, repo: src.repo, ref: sha, path: f.path },
      extra: {},
    };
  });
  out.push(...md.filter((i): i is CatalogItem => i !== null));
  const mcpFile = tree.find((t) => t.path === `${prefix}.mcp.json`);
  if (mcpFile) {
    const raw = await ghRaw(src.owner, src.repo, sha, mcpFile.path);
    try {
      const cfg = JSON.parse(raw ?? '{}') as { mcpServers?: Record<string, unknown> } & Record<string, unknown>;
      const servers = (cfg.mcpServers ?? cfg) as Record<string, unknown>;
      for (const [name, def] of Object.entries(servers)) {
        out.push({
          id: `${src.key}/mcp/${plugin}:${name}`,
          source: src.key,
          kind: 'mcp',
          name,
          description: `MCP server "${name}" from the ${plugin} plugin`,
          plugin,
          category: null,
          license: null,
          homepage: `https://github.com/${src.owner}/${src.repo}/blob/${sha}/${mcpFile.path}`,
          location: { owner: src.owner, repo: src.repo, ref: sha, path: mcpFile.path },
          extra: { server: def },
        });
      }
    } catch {
      log.warn(`unreadable ${mcpFile.path} in ${src.owner}/${src.repo}`);
    }
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface MarketplacePlugin {
  name: string;
  description?: string;
  category?: string;
  homepage?: string;
  author?: { name?: string };
  license?: string;
  source: string | { source: string; url?: string; repo?: string; path?: string; ref?: string; sha?: string };
  skills?: string[];
}

/** Where a marketplace plugin's files are, for the three source forms marketplaces use. */
export function pluginLocation(src: SkillSourceConfig, sha: string, p: MarketplacePlugin): ItemLocation | null {
  const s = p.source;
  if (typeof s === 'string') return { owner: src.owner, repo: src.repo, ref: sha, path: s.replace(/^\.\/?/, '').replace(/\/$/, '') };
  const url = s.url ?? (s.repo ? `https://github.com/${s.repo}` : null);
  if (!url || !/github\.com/i.test(url)) return null;
  const { owner, repo } = parseRepo(url.replace(/^.*github\.com[/:]/i, ''));
  return { owner, repo, ref: s.sha ?? s.ref ?? 'HEAD', path: (s.path ?? '').replace(/^\.\/?/, '').replace(/\/$/, '') };
}

async function marketplaceItems(src: SkillSourceConfig, sha: string, tree: TreeEntry[]): Promise<CatalogItem[]> {
  const raw = await ghRaw(src.owner, src.repo, sha, '.claude-plugin/marketplace.json');
  if (!raw) return [];
  const mkt = JSON.parse(raw) as { name: string; plugins: MarketplacePlugin[] };
  const out: CatalogItem[] = [];
  for (const p of mkt.plugins ?? []) {
    const loc = pluginLocation(src, sha, p);
    const inRepo = typeof p.source === 'string';
    const pluginItem: CatalogItem = {
      id: `${src.key}/plugin/${p.name}`,
      source: src.key,
      kind: 'plugin',
      name: p.name,
      description: p.description ?? '',
      plugin: null,
      category: p.category ?? null,
      license: p.license ?? null,
      homepage: p.homepage ?? (loc ? `https://github.com/${loc.owner}/${loc.repo}/tree/${loc.ref}/${loc.path}` : null),
      location: loc,
      extra: {
        marketplace: mkt.name,
        marketplaceRepo: `${src.owner}/${src.repo}`,
        author: p.author?.name ?? null,
        inRepo,
        claudeInstall: `/plugin install ${p.name}@${mkt.name}`,
      },
    };
    out.push(pluginItem);
    if (inRepo && loc) {
      // A marketplace entry can name its skills explicitly (anthropics/skills does), else look in <plugin>/skills.
      if (p.skills?.length) {
        for (const s of p.skills) {
          const dir = [loc.path, s.replace(/^\.\/?/, '')].filter(Boolean).join('/');
          out.push(...(await skillsUnder(src, sha, tree, dir + '/', p.name, `${src.key}/`)));
        }
      } else {
        out.push(...(await pluginComponents(src, sha, tree, loc.path, p.name)));
      }
      pluginItem.extra.components = out.filter((i) => i.plugin === p.name).map((i) => `${i.kind}:${i.name}`);
    }
  }
  return out;
}

export async function syncSource(catalog: Catalog, src: SkillSourceConfig, opts: { force?: boolean; maxAgeHours: number }): Promise<SyncReport> {
  const state = catalog.sourceState(src.key);
  if (!opts.force && state.syncedAt && Date.now() - state.syncedAt < opts.maxAgeHours * 3600_000 && state.sha) {
    return { source: src.key, status: 'skipped', sha: state.sha, items: state.items };
  }
  try {
    const sha = await ghHeadSha(src.owner, src.repo);
    if (sha === state.sha && !opts.force) {
      catalog.markChecked(src.key);
      return { source: src.key, status: 'unchanged', sha, items: state.items };
    }
    const tree = await ghTree(src.owner, src.repo, sha);
    let items: CatalogItem[];
    if (src.kind === 'marketplace') {
      items = await marketplaceItems(src, sha, tree);
    } else {
      items = await skillsUnder(src, sha, tree, '', null, `${src.key}/`);
      // A skills repo can also be a marketplace (anthropics/skills is): add its plugin bundles too.
      if (tree.some((t) => t.path === '.claude-plugin/marketplace.json')) {
        const seen = new Set(items.map((i) => i.location?.path));
        for (const it of await marketplaceItems(src, sha, tree)) {
          if (it.kind === 'skill' && seen.has(it.location?.path)) continue;
          items.push(it);
        }
      }
    }
    const unique = new Map(items.map((i) => [i.id, i]));
    catalog.replaceSource(src.key, sha, [...unique.values()]);
    log.info(`${src.key}: ${unique.size} items at ${sha.slice(0, 7)}`);
    return { source: src.key, status: 'updated', sha, items: unique.size };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    catalog.markChecked(src.key, error);
    return { source: src.key, status: 'failed', error, items: state.items };
  }
}

/** The community catalog bundled with the vendored skills-mcp (no network). */
export function loadCommunityCatalog(catalog: Catalog, file: string): SyncReport {
  const key = 'community';
  const stat = fs.statSync(file);
  const version = `local-${stat.size}-${Math.round(stat.mtimeMs)}`;
  if (catalog.sourceState(key).sha === version) return { source: key, status: 'unchanged', items: catalog.sourceState(key).items };
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    skills: Array<{ id: string; name: string; description: string; tags: string[]; owner: string; repoName: string; branch: string; repoPath: string; repoLabel: string }>;
  };
  const items: CatalogItem[] = data.skills.map((s) => ({
    id: `community/skill/${s.id}`,
    source: key,
    kind: 'skill',
    name: s.name,
    description: s.description ?? '',
    plugin: null,
    category: s.tags?.[0] ?? null,
    license: null,
    homepage: `https://github.com/${s.owner}/${s.repoName}/tree/${s.branch}/${dirOf(s.repoPath)}`,
    location: { owner: s.owner, repo: s.repoName, ref: s.branch, path: dirOf(s.repoPath) },
    extra: { from: s.repoLabel, tags: s.tags },
  }));
  catalog.replaceSource(key, version, items);
  return { source: key, status: 'updated', items: items.length };
}

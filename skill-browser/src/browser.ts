// The skill/plugin browser: search the local catalog, show an item, install it for a client.
// Installing only writes files (SKILL.md folders, command/agent Markdown); it never runs anything from a skill.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lint } from '@skillmds/core';
import { ghHeadSha, ghRaw, ghRawBuffer, ghTree, type TreeEntry } from '../../server/src/github.js';
import { paths, repoRoot } from '../../server/src/paths.js';
import type { Config, SkillSourceConfig } from '../../server/src/config.js';
import { Catalog, type CatalogItem, type ItemKind, type ItemLocation } from '../../skill-sources/src/catalog.js';
import { loadCommunityCatalog, syncSource, type SyncReport } from '../../skill-sources/src/sync.js';

export const CLIENTS = ['vscode', 'claude', 'cursor', 'codex', 'gemini', 'generic'] as const;
export type Client = (typeof CLIENTS)[number];

/** Where each client looks for skills (user level, project level). */
export function skillDirs(client: Client, projectDir: string | null): { user: string; project: string | null } {
  const home = os.homedir();
  const p = (rel: string) => (projectDir ? path.join(projectDir, rel) : null);
  switch (client) {
    case 'vscode':
      return { user: path.join(home, '.copilot', 'skills'), project: p('.github/skills') };
    case 'claude':
      return { user: path.join(home, '.claude', 'skills'), project: p('.claude/skills') };
    case 'cursor':
      return { user: path.join(home, '.cursor', 'skills'), project: p('.cursor/skills') };
    case 'gemini':
      return { user: path.join(home, '.gemini', 'skills'), project: p('.gemini/skills') };
    case 'codex':
    case 'generic':
      return { user: path.join(home, '.agents', 'skills'), project: p('.agents/skills') };
  }
}

const COMMUNITY_FILE = path.join(repoRoot, 'skill-browser', 'upstream', 'data', 'catalog.json');

export class SkillBrowser {
  private catalog: Catalog;

  constructor(private readonly config: () => Config) {
    this.catalog = new Catalog(path.join(paths.cache, 'skills.db'));
  }

  sources(): SkillSourceConfig[] {
    return this.config().skills.sources;
  }

  enabledSourceKeys(): string[] {
    const keys = this.sources().filter((s) => s.enabled).map((s) => s.key);
    if (this.config().skills.communityCatalog) keys.push('community');
    return keys;
  }

  /** Brings enabled sources up to date (cheap when nothing changed). */
  async sync(opts: { force?: boolean; source?: string } = {}): Promise<SyncReport[]> {
    const reports: SyncReport[] = [];
    for (const s of this.sources()) {
      if (opts.source && s.key !== opts.source) continue;
      if (!s.enabled) {
        reports.push({ source: s.key, status: 'skipped', error: 'disabled' });
        continue;
      }
      reports.push(await syncSource(this.catalog, s, { force: opts.force, maxAgeHours: this.config().skills.syncHours }));
    }
    if (this.config().skills.communityCatalog && (!opts.source || opts.source === 'community') && fs.existsSync(COMMUNITY_FILE)) {
      reports.push(loadCommunityCatalog(this.catalog, COMMUNITY_FILE));
    }
    return reports;
  }

  /** Syncs first when a source was never synced, so the first search just works. */
  private async ensureSynced(): Promise<void> {
    const missing = this.sources().filter((s) => s.enabled && !this.catalog.sourceState(s.key).sha);
    if (missing.length || (this.config().skills.communityCatalog && !this.catalog.sourceState('community').sha)) await this.sync();
  }

  async search(query: string, opts: { kind?: ItemKind; source?: string; limit?: number }) {
    await this.ensureSynced();
    const sources = opts.source ? [opts.source] : this.enabledSourceKeys();
    const hits = this.catalog.search(query, { kind: opts.kind, sources, limit: opts.limit ?? 15 });
    if (!hits.length) this.throwIfUnsynced(sources);
    return hits;
  }

  /** "Nothing found" is misleading when a source could not be loaded at all: say why instead. */
  private throwIfUnsynced(keys: string[]): void {
    const broken = keys
      .map((k) => ({ k, s: this.catalog.sourceState(k) }))
      .filter(({ s }) => !s.sha && s.error);
    if (broken.length) throw new Error(`Could not load skill sources: ${broken.map(({ k, s }) => `${k}: ${s.error}`).join('; ')}`);
  }

  /** By id, or by exact name when that is unambiguous. */
  async find(idOrName: string): Promise<CatalogItem> {
    await this.ensureSynced();
    const byId = this.catalog.get(idOrName);
    if (byId) return byId;
    const named = this.catalog.byName(idOrName).filter((i) => this.enabledSourceKeys().includes(i.source));
    if (named.length === 1) return named[0]!;
    if (!named.length) this.throwIfUnsynced(this.enabledSourceKeys());
    if (named.length > 1) throw new Error(`"${idOrName}" matches several items; use one of these ids: ${named.map((n) => n.id).join(', ')}`);
    throw new Error(`No skill or plugin "${idOrName}". Search with skill_search first.`);
  }

  private async treeAt(loc: ItemLocation): Promise<{ sha: string; tree: TreeEntry[] }> {
    const sha = /^[0-9a-f]{40}$/.test(loc.ref) ? loc.ref : await ghHeadSha(loc.owner, loc.repo, loc.ref);
    return { sha, tree: await ghTree(loc.owner, loc.repo, sha) };
  }

  /** Everything an agent needs to judge an item: its main text, its files, its components and licence. */
  async details(idOrName: string): Promise<Record<string, unknown>> {
    const item = await this.find(idOrName);
    const loc = item.location;
    const out: Record<string, unknown> = { ...item };
    if (!loc) return { ...out, note: 'Files are not on GitHub; see the homepage.' };
    if (item.kind === 'skill') {
      const { sha, tree } = await this.treeAt(loc);
      out.files = tree.filter((t) => t.type === 'blob' && t.path.startsWith(loc.path + '/')).map((t) => t.path.slice(loc.path.length + 1));
      out.content = await ghRaw(loc.owner, loc.repo, sha, `${loc.path}/SKILL.md`);
    } else if (item.kind === 'plugin') {
      const { sha, tree } = await this.treeAt(loc);
      const prefix = loc.path ? loc.path + '/' : '';
      const inPlugin = tree.filter((t) => t.type === 'blob' && t.path.startsWith(prefix));
      out.components = {
        skills: inPlugin.filter((t) => /\/SKILL\.md$/.test(t.path)).map((t) => t.path.slice(prefix.length).replace(/\/SKILL\.md$/, '')),
        commands: inPlugin.filter((t) => new RegExp(`^${prefix}commands/[^/]+\\.md$`).test(t.path)).map((t) => path.posix.basename(t.path, '.md')),
        agents: inPlugin.filter((t) => new RegExp(`^${prefix}agents/[^/]+\\.md$`).test(t.path)).map((t) => path.posix.basename(t.path, '.md')),
        mcp: inPlugin.some((t) => t.path === `${prefix}.mcp.json`) ? JSON.parse((await ghRaw(loc.owner, loc.repo, sha, `${prefix}.mcp.json`)) ?? '{}') : null,
        hooks: inPlugin.some((t) => t.path.startsWith(`${prefix}hooks/`)),
      };
      const readme = await ghRaw(loc.owner, loc.repo, sha, `${prefix}README.md`);
      out.readme = readme ? truncate(readme, 6000) : null;
    } else {
      const text = await ghRaw(loc.owner, loc.repo, loc.ref, loc.path);
      out.content = item.kind === 'mcp' ? item.extra.server : text;
    }
    return out;
  }

  /** Lints a SKILL.md (or the SKILL.md in a folder) with the skillmd engine. */
  lintPath(p: string) {
    const file = fs.statSync(p).isDirectory() ? path.join(p, 'SKILL.md') : p;
    return { file, ...lint(fs.readFileSync(file, 'utf8')) };
  }

  async install(
    idOrName: string,
    opts: { client: Client; scope: 'user' | 'project'; projectDir: string | null; overwrite?: boolean; acceptRisks?: boolean },
  ): Promise<Record<string, unknown>> {
    const item = await this.find(idOrName);
    if (!item.location) throw new Error(`${item.name} has no files on GitHub; see ${item.homepage}`);
    if (item.kind === 'skill') return this.installSkill(item, opts);
    if (item.kind === 'plugin') return this.installPlugin(item, opts);
    if (item.kind === 'mcp') {
      const def = item.extra.server;
      return {
        installed: false,
        note: 'MCP servers are added to the client configuration, which AppForge does not change on its own. Ask the user, then add it:',
        vscode: `code --add-mcp '${JSON.stringify({ name: item.name, ...(def as object) })}'`,
        claude: `claude mcp add-json ${item.name} '${JSON.stringify(def)}'`,
        config: def,
      };
    }
    return this.installMarkdown(item, opts);
  }

  private targetDir(client: Client, scope: 'user' | 'project', projectDir: string | null): string {
    const dirs = skillDirs(client, projectDir);
    if (scope === 'project') {
      if (!dirs.project) throw new Error('scope "project" needs an open project folder (pass project).');
      return dirs.project;
    }
    return dirs.user;
  }

  private async installSkill(
    item: CatalogItem,
    opts: { client: Client; scope: 'user' | 'project'; projectDir: string | null; overwrite?: boolean; acceptRisks?: boolean },
  ): Promise<Record<string, unknown>> {
    const loc = item.location!;
    const { sha, tree } = await this.treeAt(loc);
    const skillMd = await ghRaw(loc.owner, loc.repo, sha, `${loc.path}/SKILL.md`);
    if (!skillMd) throw new Error(`SKILL.md not found for ${item.id}`);
    const check = lint(skillMd);
    // Code blocks alone count as "executes scripts" for skillmd; that is reported, but only installs from untrusted
    // places and reading secrets need the user's OK.
    const risky = check.security.flags.filter((f) => f === 'untrusted_install' || f === 'reads_secrets');
    if (risky.length && !opts.acceptRisks) {
      return {
        installed: false,
        needsConfirmation: true,
        reason: `This skill ${risky.join(', ').replace(/_/g, ' ')}. Ask the user; call again with acceptRisks=true to install anyway.`,
        findings: check.security.findings.slice(0, 10),
        license: item.license,
      };
    }
    const dest = path.join(this.targetDir(opts.client, opts.scope, opts.projectDir), safeName(item.name));
    if (fs.existsSync(dest) && !opts.overwrite) {
      return { installed: false, reason: `${dest} already exists; call again with overwrite=true to replace it.` };
    }
    const files = tree.filter((t) => t.type === 'blob' && t.path.startsWith(loc.path + '/'));
    if (files.length > 300) throw new Error(`${item.name} has ${files.length} files; refusing to install that many.`);
    const tmp = `${dest}.appforge-tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const f of files) {
      const rel = f.path.slice(loc.path.length + 1);
      const target = path.join(tmp, ...rel.split('/'));
      if (!target.startsWith(tmp)) continue;
      const buf = await ghRawBuffer(loc.owner, loc.repo, sha, f.path);
      if (!buf) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf);
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(tmp, dest);
    return {
      installed: true,
      kind: 'skill',
      name: item.name,
      path: dest,
      files: files.length,
      lint: { score: check.score, problems: check.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message) },
      securityFlags: check.security.flags,
      license: item.license,
      source: `https://github.com/${loc.owner}/${loc.repo}/tree/${sha}/${loc.path}`,
      next: `The client picks it up in a new chat (VS Code: Chat > Skills; Claude Code: /skills).`,
    };
  }

  private async installPlugin(
    item: CatalogItem,
    opts: { client: Client; scope: 'user' | 'project'; projectDir: string | null; overwrite?: boolean; acceptRisks?: boolean },
  ): Promise<Record<string, unknown>> {
    const marketplaceRepo = item.extra.marketplaceRepo as string | undefined;
    const claude = {
      addMarketplace: marketplaceRepo ? `/plugin marketplace add ${marketplaceRepo}` : null,
      install: item.extra.claudeInstall ?? null,
    };
    if (opts.client === 'claude') {
      return {
        installed: false,
        note: 'Claude Code installs plugins itself. Run these two commands in Claude Code (the first only once):',
        ...claude,
      };
    }
    // Other clients: install the plugin's skills one by one; commands/agents/MCP servers are listed for the user.
    const details = await this.details(item.id);
    const comps = details.components as { skills: string[]; commands: string[]; agents: string[]; mcp: unknown; hooks: boolean } | undefined;
    const loc = item.location!;
    const installed: unknown[] = [];
    for (const rel of comps?.skills ?? []) {
      const skillItem: CatalogItem = {
        ...item,
        id: `${item.id}/${rel}`,
        kind: 'skill',
        name: path.posix.basename(rel),
        location: { ...loc, path: [loc.path, rel].filter(Boolean).join('/') },
      };
      installed.push(await this.installSkill(skillItem, opts));
    }
    return {
      installedSkills: installed,
      notInstalled: {
        commands: comps?.commands ?? [],
        agents: comps?.agents ?? [],
        mcp: comps?.mcp ?? null,
        hooks: comps?.hooks ?? false,
      },
      note:
        opts.client === 'vscode'
          ? `VS Code can also install the whole plugin: Command Palette > "Chat: Install Plugin From Source" > ${marketplaceRepo ?? item.homepage}.`
          : 'Commands, agents, hooks and MCP servers are Claude-plugin features; set them up by hand if the client supports them.',
      claude,
    };
  }

  private async installMarkdown(
    item: CatalogItem,
    opts: { client: Client; scope: 'user' | 'project'; projectDir: string | null; overwrite?: boolean },
  ): Promise<Record<string, unknown>> {
    const loc = item.location!;
    const text = await ghRaw(loc.owner, loc.repo, loc.ref, loc.path);
    if (!text) throw new Error(`Could not fetch ${loc.path}`);
    const base = path.posix.basename(loc.path, '.md');
    let dest: string;
    if (opts.client === 'claude') {
      const root = opts.scope === 'user' ? path.join(os.homedir(), '.claude') : path.join(requireDir(opts.projectDir), '.claude');
      dest = path.join(root, item.kind === 'command' ? 'commands' : 'agents', `${base}.md`);
    } else if (opts.client === 'vscode') {
      const root = path.join(requireDir(opts.projectDir), '.github');
      dest = item.kind === 'command' ? path.join(root, 'prompts', `${base}.prompt.md`) : path.join(root, 'agents', `${base}.agent.md`);
    } else {
      return { installed: false, note: `${opts.client} has no standard place for Claude ${item.kind}s; here is the file.`, content: text };
    }
    if (fs.existsSync(dest) && !opts.overwrite) return { installed: false, reason: `${dest} already exists; pass overwrite=true.` };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
    return { installed: true, kind: item.kind, path: dest, note: opts.client === 'vscode' ? 'Written to the project (.github); VS Code reads it in a new chat.' : undefined };
  }

  status() {
    return {
      sources: [
        ...this.sources().map((s) => ({ ...s, ...this.catalog.sourceState(s.key) })),
        ...(this.config().skills.communityCatalog ? [{ key: 'community', ...this.catalog.sourceState('community') }] : []),
      ],
      counts: this.catalog.counts(),
    };
  }

  removeSourceData(key: string): void {
    this.catalog.removeSource(key);
  }

  close(): void {
    this.catalog.close();
  }
}

function requireDir(dir: string | null): string {
  if (!dir) throw new Error('This needs an open project folder (pass project).');
  return dir;
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80) || 'skill';
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s;
}

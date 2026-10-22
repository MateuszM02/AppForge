// MCP tools of the skills group: find, inspect and install agent skills and Claude plugins.

import { z } from 'zod';
import { fail, json, safe, text, type ForgeContext } from '../../server/src/context.js';
import { loadConfig, setSetting, type SkillSourceConfig } from '../../server/src/config.js';
import { parseRepo } from '../../server/src/github.js';
import { CLIENTS, SkillBrowser } from './browser.js';

let browser: SkillBrowser | null = null;

export function skillBrowser(): SkillBrowser {
  browser ??= new SkillBrowser(() => loadConfig());
  return browser;
}

const KINDS = ['skill', 'plugin', 'command', 'agent', 'mcp'] as const;

function short(d: string, n = 220): string {
  const one = d.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
}

export function registerSkillTools(ctx: ForgeContext): void {
  const { server } = ctx;
  ctx.onClose(() => browser?.close());

  server.registerTool(
    'skill_search',
    {
      title: 'Search skills and plugins',
      description:
        "Search agent skills (SKILL.md folders), Claude plugins and their commands, agents and MCP servers. Sources: Anthropic's " +
        'anthropics/skills and anthropics/claude-plugins-official by default (more with skill_sources). Use before a ' +
        'specialised task (documents, testing, design, MCP servers, deployment, ...). Then skill_get to read one, skill_install to add it.',
      inputSchema: {
        query: z.string().describe('What the skill should do, e.g. "fill pdf forms" or "playwright web testing". Empty lists everything.'),
        kind: z.enum(KINDS).optional().describe('Only this kind of item.'),
        source: z.string().optional().describe('Only this source key (see skill_sources).'),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (a) => {
      const hits = await skillBrowser().search(a.query, a);
      if (!hits.length) return text(`Nothing matches "${a.query}". Try other words, or enable more sources (skill_sources).`);
      return text(
        hits
          .map((h) => `- ${h.kind} ${h.name}${h.plugin ? ` (plugin ${h.plugin})` : ''}: ${short(h.description)}\n  id: ${h.id}`)
          .join('\n'),
      );
    }),
  );

  server.registerTool(
    'skill_get',
    {
      title: 'Show a skill or plugin',
      description: 'Full SKILL.md (or plugin README and components, or command/agent text), file list, licence and source link.',
      inputSchema: { id: z.string().describe('An id from skill_search (or an exact name).') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (a) => json(await skillBrowser().details(a.id))),
  );

  server.registerTool(
    'skill_install',
    {
      title: 'Install a skill or plugin',
      description:
        'Install for a client. Skills are copied into the client\'s skills folder (vscode: ~/.copilot/skills or ' +
        '.github/skills; claude: ~/.claude/skills or .claude/skills; ...). Plugins: Claude Code gets the /plugin ' +
        'commands to run; other clients get the plugin\'s skills installed. Never runs code from the skill. A skill that downloads ' +
        'from untrusted places or reads secrets needs acceptRisks=true, which you should only pass after the user agreed.',
      inputSchema: {
        id: z.string(),
        client: z.enum(CLIENTS).describe('The agent that should use it: vscode (Copilot), claude (Claude Code), cursor, codex, gemini, generic (.agents/skills).'),
        scope: z.enum(['user', 'project']).optional().describe('user (default): every project; project: only the open project.'),
        project: z.string().optional().describe('Project folder for scope=project. Default: the open workspace.'),
        overwrite: z.boolean().optional(),
        acceptRisks: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async (a) => {
      const scope = a.scope ?? 'user';
      const project = scope === 'project' || a.project ? await ctx.project(a.project) : null;
      return json(
        await skillBrowser().install(a.id, { client: a.client, scope, projectDir: project?.dir ?? null, overwrite: a.overwrite, acceptRisks: a.acceptRisks }),
      );
    }),
  );

  server.registerTool(
    'skill_lint',
    {
      title: 'Check a SKILL.md',
      description: 'Lint a local skill (folder or SKILL.md) with the skillmd engine: format problems, a 0-100 quality score and what it can do (scripts, network, secrets).',
      inputSchema: { path: z.string().describe('Absolute path to a skill folder or SKILL.md file.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async (a) => json(skillBrowser().lintPath(a.path))),
  );

  server.registerTool(
    'skills_sync',
    {
      title: 'Refresh skill sources',
      description: 'Check the skill sources on GitHub for changes and update the local catalog (normally automatic once a day).',
      inputSchema: { source: z.string().optional(), force: z.boolean().optional().describe('Rebuild even if nothing changed.') },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    safe(async (a) => json(await skillBrowser().sync({ force: a.force ?? true, source: a.source }))),
  );

  server.registerTool(
    'skill_sources',
    {
      title: 'Manage skill sources',
      description:
        'List, add, enable, disable or remove skill sources. A source is a GitHub repo with SKILL.md folders (kind "skills") ' +
        'or a Claude plugin marketplace (kind "marketplace"). "community" turns on the bundled catalog of ~9,000 community skills. ' +
        'Change sources only when the user asks.',
      inputSchema: {
        action: z.enum(['list', 'add', 'enable', 'disable', 'remove']),
        key: z.string().optional().describe('Source key; for add, a short name of your choice.'),
        repo: z.string().optional().describe('For add: "owner/name" or a GitHub URL.'),
        kind: z.enum(['skills', 'marketplace']).optional().describe('For add (default skills).'),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    safe(async (a) => {
      const sb = skillBrowser();
      const sources: SkillSourceConfig[] = structuredClone(loadConfig().skills.sources);
      if (a.action === 'list') return json(sb.status());
      if (a.key === 'community') {
        if (a.action === 'add' || a.action === 'enable') setSetting('skills.communityCatalog', true);
        else {
          setSetting('skills.communityCatalog', false);
          sb.removeSourceData('community');
        }
        return text(`Community catalog ${a.action === 'add' || a.action === 'enable' ? 'enabled' : 'disabled'}.`);
      }
      if (!a.key) return fail(`${a.action} needs key.`);
      const i = sources.findIndex((s) => s.key === a.key);
      if (a.action === 'add') {
        if (!a.repo) return fail('add needs repo ("owner/name").');
        if (i >= 0) return fail(`Source ${a.key} exists already.`);
        const { owner, repo } = parseRepo(a.repo);
        sources.push({ key: a.key, owner, repo, kind: a.kind ?? 'skills', enabled: true });
      } else {
        if (i < 0) return fail(`No source ${a.key}.`);
        if (a.action === 'remove') sources.splice(i, 1);
        else sources[i]!.enabled = a.action === 'enable';
        if (a.action !== 'enable') sb.removeSourceData(a.key);
      }
      setSetting('skills.sources', sources);
      const report = a.action === 'add' || a.action === 'enable' ? await sb.sync({ source: a.key, force: true }) : [];
      return json({ sources: loadConfig().skills.sources, sync: report });
    }),
  );
}

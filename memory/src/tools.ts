// MCP tools and resources of the memory group.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { fail, json, safe, text, type ForgeContext } from '../../server/src/context.js';
import { getSetting, setSetting } from '../../server/src/config.js';
import { paths } from '../../server/src/paths.js';
import { MEMORY_KINDS, MemoryService, type MemoryItem, type Scope } from './memory.js';

let service: MemoryService | null = null;
let ready: Promise<void> | null = null;

/** The one memory service of this process (also used by the CLI). */
export async function memoryService(ctx: Pick<ForgeContext, 'config'>): Promise<MemoryService> {
  if (!service) service = new MemoryService(paths.memory, () => ctx.config().memory);
  ready ??= service.init();
  await ready;
  return service;
}

const DEFAULT_GLOBAL_KINDS = new Set(['preference', 'lesson', 'pattern', 'pitfall']);

function line(i: MemoryItem, withBody: boolean): string {
  const where = i.scope === 'global' ? 'global' : `project ${i.project}`;
  const head = `- [${i.kind}] ${i.title}  (id ${i.id}; ${where}; strength ${i.strength}${i.pinned ? '; pinned' : ''})`;
  if (!withBody || !i.body) return head;
  const body = i.body.length > 400 ? i.body.slice(0, 400) + '… (memory_read for the rest)' : i.body;
  return `${head}\n  ${body.replace(/\n/g, '\n  ')}`;
}

export function registerMemoryTools(ctx: ForgeContext): void {
  const { server } = ctx;
  const mem = () => memoryService(ctx);
  const scopeArg = z.enum(['all', 'global', 'project']);

  server.registerTool(
    'memory_recall',
    {
      title: 'Recall memories',
      description:
        'Search the long-term memory (user preferences, lessons, decisions, pitfalls) for what is relevant to a task. ' +
        'Call it at the start of a task with a few words describing it. Returns the best matches with short bodies, ' +
        'cut to a token budget; use memory_read for a full entry. Each recall makes the returned memories a bit stronger.',
      inputSchema: {
        query: z.string().min(1).describe('A few words about the task or question, e.g. "deploy python app windows installer".'),
        scope: scopeArg.optional().describe('all (default): global + current project; global; project.'),
        project: z.string().optional().describe('Project folder, git URL or name. Default: the open workspace.'),
        budgetTokens: z.number().int().min(100).max(20000).optional().describe('Answer size limit. Default from settings (1500).'),
        limit: z.number().int().min(1).max(50).optional().describe('Most memories to return (default 10).'),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    safe(async (a) => {
      const project = await ctx.project(a.project);
      const items = await (await mem()).recall({
        query: a.query,
        scope: (a.scope ?? 'all') as Scope | 'all',
        project,
        budgetTokens: a.budgetTokens ?? ctx.config().memory.recallBudgetTokens,
        limit: a.limit,
      });
      if (items.length === 0) return text(`No memories match "${a.query}" (project ${project.name}).`);
      const more = items.truncated ? `\n(${items.truncated} more matched but did not fit the token budget.)` : '';
      return text(`Memories for "${a.query}" (project ${project.name}):\n${items.map((i) => line(i, true)).join('\n')}${more}`);
    }),
  );

  server.registerTool(
    'memory_read',
    {
      title: 'Read a memory',
      description: 'Full text and metadata of one memory, by the id memory_recall or memory_list showed.',
      inputSchema: { id: z.string().describe('e.g. "global:mem_1a2b3c4d5e6f" or "project:<key>:mem_..."') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async (a) => json((await mem()).read(a.id))),
  );

  server.registerTool(
    'memory_write',
    {
      title: 'Save a memory',
      description:
        'Save something worth remembering for future sessions: a user preference, a lesson learned, a decision and its ' +
        'reason, a stable fact, a pattern that worked, or a pitfall. One idea per memory, short and specific. Never ' +
        'store secrets. A near-identical memory is strengthened instead of duplicated. Scope defaults to global for ' +
        'preference/lesson/pattern/pitfall and to the current project for decision/fact.',
      inputSchema: {
        kind: z.enum(MEMORY_KINDS),
        title: z.string().min(3).max(200).describe('One line saying what it is about.'),
        body: z.string().max(4000).describe('The details: what, why, when it applies.'),
        tags: z.array(z.string()).max(8).optional(),
        scope: z.enum(['global', 'project']).optional(),
        project: z.string().optional().describe('Project folder, git URL or name. Default: the open workspace.'),
        pinned: z.boolean().optional().describe('Pinned memories are never removed by the size limit.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async (a) => {
      const scope = a.scope ?? (DEFAULT_GLOBAL_KINDS.has(a.kind) ? 'global' : 'project');
      const project = scope === 'project' ? await ctx.project(a.project) : undefined;
      const res = await (await mem()).write({ ...a, scope, project });
      const parts = [res.duplicateOf ? `Already remembered as ${res.id}; made it stronger instead.` : `Saved ${res.id} (${scope}${project ? ` ${project.name}` : ''}).`];
      if (res.evicted.length) parts.push(`Memory limit reached; archived: ${res.evicted.map((e) => `"${e.title}"`).join(', ')}.`);
      if (res.warnings.length) parts.push(`Warnings: ${res.warnings.join('; ')}`);
      return text(parts.join(' '));
    }),
  );

  server.registerTool(
    'memory_update',
    {
      title: 'Update a memory',
      description: 'Correct or extend a memory. Fields left out stay as they are. The memory gets a new id.',
      inputSchema: {
        id: z.string(),
        title: z.string().min(3).max(200).optional(),
        body: z.string().max(4000).optional(),
        tags: z.array(z.string()).max(8).optional(),
        kind: z.enum(MEMORY_KINDS).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async (a) => {
      const { id, ...patch } = a;
      const res = await (await mem()).update(id, patch);
      return text(`Updated: ${id} is now ${res.id}.`);
    }),
  );

  server.registerTool(
    'memory_feedback',
    {
      title: 'Rate a memory',
      description:
        'Tell the memory whether a recalled entry helped. helpful=true makes it stronger; helpful=false (wrong or ' +
        'outdated) makes it rank lower and fade sooner. Use memory_update or memory_forget to fix or drop it.',
      inputSchema: { id: z.string(), helpful: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async (a) => {
      await (await mem()).feedback(a.id, a.helpful);
      return text(`Noted: ${a.id} was ${a.helpful ? 'helpful' : 'not helpful'}.`);
    }),
  );

  server.registerTool(
    'memory_forget',
    {
      title: 'Forget a memory',
      description: 'Delete one memory that is wrong or no longer wanted.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      const item = await (await mem()).forget(a.id);
      return text(`Forgot ${a.id} ("${item.title}").`);
    }),
  );

  server.registerTool(
    'memory_list',
    {
      title: 'List memories',
      description: 'Titles of stored memories (no search), strongest first. For browsing; use memory_recall to find something.',
      inputSchema: {
        scope: scopeArg.optional().describe('all (default), global or project (the current one).'),
        project: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional().describe('Default 50.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      const scope = a.scope ?? 'all';
      const project = scope === 'project' ? await ctx.project(a.project) : undefined;
      const items = (await mem())
        .list({ scope, projectKey: project?.key })
        .sort((x, y) => y.strength - x.strength)
        .slice(0, a.limit ?? 50);
      return text(items.length ? items.map((i) => line(i, false)).join('\n') : 'No memories yet.');
    }),
  );

  server.registerTool(
    'memory_stats',
    {
      title: 'Memory usage',
      description: 'How many memories there are, how much of the user-set limit they use, and where they are stored.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () => json((await mem()).stats())),
  );

  server.registerTool(
    'memory_config',
    {
      title: 'Memory settings',
      description:
        'Read or change memory settings: maxEntries (count limit), maxMB (text size limit), recallBudgetTokens, ' +
        'keepArchive, starterPack. Change limits only when the user asks.',
      inputSchema: {
        action: z.enum(['get', 'set']),
        key: z.enum(['maxEntries', 'maxMB', 'recallBudgetTokens', 'keepArchive', 'starterPack']).optional(),
        value: z.union([z.number(), z.boolean()]).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    safe(async (a) => {
      if (a.action === 'get') return json(a.key ? { [a.key]: getSetting(`memory.${a.key}`) } : ctx.config().memory);
      if (!a.key || a.value === undefined) return fail('set needs key and value.');
      if (typeof a.value === 'number' && a.value <= 0) return fail('Limits must be positive.');
      const v = setSetting(`memory.${a.key}`, a.value);
      const extra = a.key === 'maxEntries' || a.key === 'maxMB' ? await (await mem()).consolidate() : null;
      return text(
        `memory.${a.key} = ${String(v)}.` + (extra?.evicted.length ? ` ${extra.evicted.length} memories moved to the archive to fit.` : ''),
      );
    }),
  );

  server.registerTool(
    'memory_consolidate',
    {
      title: 'Tidy memory',
      description: 'Merge near-duplicate memories and apply the size limit now (it is also applied on every write).',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    safe(async () => json(await (await mem()).consolidate())),
  );

  for (const [name, file, description] of [
    ['memory-index', 'INDEX.md', 'One line per stored memory (kind, title, id, strength, file).'],
    ['memory-format', 'FORMAT.md', 'How the memory folder and files are organised, for reading them directly.'],
  ] as const) {
    server.registerResource(name, `appforge://memory/${file.toLowerCase().replace('.md', '')}`, { description, mimeType: 'text/markdown' }, async (uri) => {
      await mem();
      const p = path.join(paths.memory, file);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '' }] };
    });
  }
}

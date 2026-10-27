// The workflow layer: forge_plan (a step-by-step plan that ties the tool groups together), forge_status (what
// works on this machine) and the create-app / improve-app / find-app prompts (slash commands in VS Code and
// Claude Code). Plain text, so any model can follow it.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { json, safe, text, type ForgeContext } from './context.js';
import { githubToken, rateInfo } from './github.js';
import { dataDir, paths, repoRoot } from './paths.js';
import { VERSION } from './version.js';
import { latestKnownVersion } from './update-check.js';

export type Mode = 'create' | 'improve' | 'find';

/** The plan text for a goal. Steps only mention tool groups that are switched on. */
export function planFor(goal: string, mode: Mode, groups: { memory: boolean; skills: boolean; repos: boolean; browser: boolean }): string {
  const steps: string[] = [];
  const add = (on: boolean, s: string) => on && steps.push(s);
  add(groups.memory, `memory_recall "${goal}": earlier preferences, decisions and pitfalls for this kind of work and this project.`);
  if (mode === 'improve') {
    steps.push('Read the project first: README, entry points, build and test commands. Note what the user wants changed and how success is checked.');
    add(groups.repos, 'repo_search for libraries or projects that already solve the improvement (e.g. "accessible date picker for React"); compare 2-3 with repo_compare before adding a dependency.');
  } else {
    add(groups.repos, `repo_search "${goal}" (filters: language, licence, recent activity). If a healthy, permissively licensed project fits, prefer extending or forking it; check it with repo_details and repo_read_file.`);
  }
  add(groups.skills, `skill_search for the specialised parts (e.g. "web testing", "pdf", "mcp server", "frontend design"); read promising ones with skill_get and install the useful ones with skill_install.`);
  add(groups.browser, 'browser_open the official docs of the chosen libraries (exact versions) and anything else you are unsure about; use @google_search macros through browser_navigate when needed.');
  if (mode === 'find') {
    steps.push('Report a short ranked list: what each option does, licence, activity, risks, and which one you recommend and why. Ask before installing or cloning anything.');
  } else {
    steps.push(`Make a short plan (files, dependencies, how to run and test) and confirm open questions with the user before a long build.`);
    steps.push('Build in small verified steps: run the build and tests after each, and run the app itself before saying it works.');
    steps.push('Keep install to one command and write a README that starts with it.');
  }
  add(groups.memory, 'memory_write what is worth keeping: user preferences you learned, decisions and why, and pitfalls that cost time. memory_feedback on recalled memories that helped or were wrong.');
  const title = { create: 'Create', improve: 'Improve', find: 'Find' }[mode];
  return `${title}: ${goal}\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** What is installed and working; shared by forge_status and `appforge doctor`. */
export async function status() {
  const { loadConfig } = await import('./config.js');
  const cfg = loadConfig();
  const { camoufoxInstalled } = await import('../../camofox-browser/src/manager.js');
  const models = paths.models;
  const { resolveModels } = await import('./models.js');
  const rm = resolveModels(cfg.repos);
  const present = {
    embedding: exists(path.join(models, ...rm.embed.id.split('/'))),
    crossEncoder: rm.rerank.gguf ? exists(path.join(models, 'rerank', rm.rerank.gguf.file)) : exists(path.join(models, ...rm.rerank.id.split('/'))),
    llm: rm.llm !== null && (exists(path.join(models, 'llm', rm.llm.file)) || exists(rm.llm.uri)),
  };
  return {
    version: VERSION,
    newerVersion: latestKnownVersion(),
    installFolder: repoRoot,
    dataFolder: dataDir(),
    node: process.version,
    github: { tokenFound: githubToken() !== null, ...rateInfo() },
    groups: cfg.tools,
    browser: { camoufoxDownloaded: camoufoxInstalled() },
    repos: {
      pipelineBuilt: exists(path.join(repoRoot, 'dist', 'reporadar', 'headless.mjs')),
      modelProfile: rm.profile,
      models: {
        embedding: { id: rm.embed.id, downloaded: present.embedding },
        crossEncoder: { id: rm.rerank.id, downloaded: present.crossEncoder },
        llm: rm.llm ? { file: rm.llm.file, downloaded: present.llm, pick: cfg.repos.llm } : { file: null, pick: false },
      },
      modelsDownloaded: present.embedding && present.crossEncoder && (present.llm || !cfg.repos.llm || !rm.llm),
      needsGithubLogin: githubToken() === null,
    },
    memory: { folder: paths.memory, limits: cfg.memory },
    skills: { sources: cfg.skills.sources.map((s) => `${s.key}${s.enabled ? '' : ' (off)'}`), communityCatalog: cfg.skills.communityCatalog },
  };
}

export function registerForgeTools(ctx: ForgeContext): void {
  const { server } = ctx;
  const groups = () => ctx.config().tools;

  server.registerTool(
    'forge_plan',
    {
      title: 'Plan app work',
      description:
        'A step-by-step plan for creating, improving or finding an app with AppForge\'s tools (memory, repo search, skills, browser). ' +
        'Call it at the start of a bigger task, then follow the steps.',
      inputSchema: {
        goal: z.string().min(3).describe('What the user wants, in their words.'),
        mode: z.enum(['create', 'improve', 'find']).describe('create a new app, improve an existing one, or find existing ones.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async (a) => text(planFor(a.goal, a.mode, groups()))),
  );

  server.registerTool(
    'forge_status',
    {
      title: 'AppForge status',
      description: 'What works on this machine: version and updates, GitHub login and quota, browser download, repo search, memory and skill sources.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () => json(await status())),
  );

  const prompts: Array<[Mode, string, string]> = [
    ['create', 'create-app', 'Create a new app: reuse what exists, then build it step by step.'],
    ['improve', 'improve-app', 'Improve the open project: find libraries, skills and docs first.'],
    ['find', 'find-app', 'Find existing apps or libraries that do what you need.'],
  ];
  for (const [mode, name, description] of prompts) {
    server.registerPrompt(
      name,
      { title: description.split(':')[0], description, argsSchema: { goal: z.string().describe('What you want, in your words.') } },
      ({ goal }) => ({
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: `${planFor(goal, mode, groups())}\n\nFollow these steps using the AppForge tools. Goal: ${goal}` },
          },
        ],
      }),
    );
  }
}

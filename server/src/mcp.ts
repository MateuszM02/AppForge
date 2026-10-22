// The MCP server: one stdio server with every tool group, prompts and resources.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { logger, redirectConsoleToStderr } from './log.js';
import { VERSION } from './version.js';
import { registerForgeTools } from './forge.js';
import { registerMemoryTools } from '../../memory/src/tools.js';
import { registerSkillTools } from '../../skill-browser/src/tools.js';
import { registerRepoTools } from '../../RepoRadar/src/tools.js';
import { registerBrowserTools } from '../../camofox-browser/src/tools.js';
import { startupUpdateNotice } from './update-check.js';

const log = logger('server');

/** Sent to the client on connect; most clients add it to the model's system prompt. Model-agnostic on purpose. */
export const INSTRUCTIONS = `AppForge helps you find, create and improve apps. Tool groups:
- memory_*: long-term memory kept on this computer (user preferences, lessons, decisions, pitfalls). Call memory_recall at the start of a task; save what was learned with memory_write at the end.
- repo_*: find existing open-source projects by what they do (repo_search), inspect them without cloning (repo_details, repo_tree, repo_read_file).
- skill_* / skills_sync: find and install agent skills and plugins (Anthropic's official ones by default).
- browser_*: a stealth web browser for reading docs and sites that block bots; pages come back as compact accessibility snapshots with element refs (e1, e2, ...) to click or type into.
- forge_plan gives a step-by-step plan for creating, improving or finding an app with these tools; forge_status shows what works.
Prefer reusing an existing project or skill over building from scratch, and check memory before repeating past work.`;

export function buildServer() {
  const server = new McpServer(
    { name: 'appforge', title: 'AppForge', version: VERSION },
    { instructions: INSTRUCTIONS, capabilities: { tools: {}, prompts: {}, resources: {}, logging: {} } },
  );
  const { ctx, close } = createContext(server);
  const cfg = loadConfig();
  if (cfg.tools.memory) registerMemoryTools(ctx);
  if (cfg.tools.skills) registerSkillTools(ctx);
  if (cfg.tools.repos) registerRepoTools(ctx);
  if (cfg.tools.browser) registerBrowserTools(ctx);
  registerForgeTools(ctx);
  return { server, close };
}

export async function serve(): Promise<void> {
  redirectConsoleToStderr();
  const { server, close } = buildServer();
  let closing = false;
  const shutdown = async (why: string) => {
    if (closing) return;
    closing = true;
    log.info(`shutting down (${why})`);
    await close();
    process.exit(0);
  };
  process.stdin.on('end', () => void shutdown('client closed stdin'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await server.connect(new StdioServerTransport());
  log.info(`AppForge ${VERSION} ready (stdio)`);
  void startupUpdateNotice();
}

// What every tool group gets when it registers its tools. Groups live in their own folders (memory/, skill-browser/,
// camofox-browser/, RepoRadar/) and only depend on this small surface of the server.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RootsListChangedNotificationSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, type Config } from './config.js';
import { logger, type Logger } from './log.js';
import { resolveProject, type ProjectInfo } from './project.js';

export interface ForgeContext {
  server: McpServer;
  config: () => Config;
  log: (scope: string) => Logger;
  /** The project a call is about (explicit argument, then the client's workspace roots, then the cwd). */
  project: (explicit?: string) => Promise<ProjectInfo>;
  /** Called on shutdown (browser processes, open databases). */
  onClose: (fn: () => void | Promise<void>) => void;
}

export function createContext(server: McpServer): { ctx: ForgeContext; close: () => Promise<void> } {
  const closers: Array<() => void | Promise<void>> = [];
  let roots: string[] | null = null;
  // The user opened another folder: ask again next time.
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    roots = null;
  });

  async function clientRoots(): Promise<string[]> {
    if (roots) return roots;
    try {
      if (server.server.getClientCapabilities()?.roots) {
        const res = await server.server.listRoots(undefined, { timeout: 3000 });
        roots = res.roots.map((r) => r.uri);
        return roots;
      }
    } catch {
      // client without roots support or slow to answer: fall back to the cwd
    }
    return [];
  }

  const ctx: ForgeContext = {
    server,
    config: () => loadConfig(),
    log: logger,
    project: async (explicit) => resolveProject(explicit, explicit ? [] : await clientRoots()),
    onClose: (fn) => closers.push(fn),
  };
  return {
    ctx,
    close: async () => {
      for (const fn of closers.reverse()) {
        try {
          await fn();
        } catch {
          // best effort on shutdown
        }
      }
    },
  };
}

/** Plain-text tool answer. */
export function text(t: string): CallToolResult {
  return { content: [{ type: 'text', text: t }] };
}

/** Pretty JSON tool answer (agents read it fine and it stays machine-parseable). */
export function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** A tool failure the agent can read and act on (not a protocol error). */
export function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Wraps a handler so any thrown error becomes a readable tool failure. */
export function safe<A, X = unknown>(run: (args: A, extra: X) => Promise<CallToolResult>): (args: A, extra: X) => Promise<CallToolResult> {
  return async (args: A, extra: X) => {
    try {
      return await run(args, extra);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  };
}

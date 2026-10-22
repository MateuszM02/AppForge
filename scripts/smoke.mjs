// End-to-end smoke test: starts `appforge serve` over stdio like an MCP client does, lists the tools and prompts,
// and calls one or more tools of each group against the real services.
//   node scripts/smoke.mjs                 everything
//   node scripts/smoke.mjs memory skills   only some groups (memory, skills, repos, browser, forge)
// Uses a throwaway data folder (APPFORGE_HOME) unless APPFORGE_SMOKE_REAL=1, so your memory is not touched.
// A GitHub login is needed for the repo_search step; the browser step needs `appforge setup browser`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const groups = process.argv.slice(2);
const want = (g) => groups.length === 0 || groups.includes(g);
const home = process.env.APPFORGE_SMOKE_REAL === '1' ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), 'appforge-smoke-'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'dist', 'server', 'src', 'cli.js'), 'serve'],
  env: { ...process.env, ...(home ? { APPFORGE_HOME: home } : {}), APPFORGE_NO_UPDATE_CHECK: '1' },
  stderr: 'pipe',
});
const stderr = [];
transport.stderr?.on('data', (d) => stderr.push(String(d)));
const client = new Client({ name: 'appforge-smoke', version: '1.0.0' });

let failures = 0;
async function step(name, run) {
  const t = Date.now();
  try {
    const out = await run();
    console.log(`ok   ${name} (${Date.now() - t} ms)${out ? `\n     ${String(out).split('\n').slice(0, 6).join('\n     ')}` : ''}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function call(name, args = {}, timeout = 120_000) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout, resetTimeoutOnProgress: true });
  const textOut = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(textOut);
  return textOut;
}

await client.connect(transport);
await step('initialize + list', async () => {
  const tools = (await client.listTools()).tools.map((t) => t.name);
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
  const resources = (await client.listResources()).resources.map((r) => r.uri);
  if (tools.length < 20) throw new Error(`only ${tools.length} tools: ${tools.join(', ')}`);
  return `${tools.length} tools: ${tools.join(', ')}\nprompts: ${prompts.join(', ')}\nresources: ${resources.join(', ')}`;
});

if (want('forge')) {
  await step('forge_status', () => call('forge_status'));
  await step('forge_plan', () => call('forge_plan', { goal: 'a habit tracker PWA', mode: 'create' }));
  await step('prompt create-app', async () => (await client.getPrompt({ name: 'create-app', arguments: { goal: 'a todo app' } })).messages[0].content.text.slice(0, 120));
}

if (want('memory')) {
  let id;
  await step('memory_stats (starter pack seeded)', () => call('memory_stats'));
  await step('memory_write', async () => {
    const out = await call('memory_write', { kind: 'pitfall', title: 'Smoke test: npm on Windows needs .cmd shims', body: 'spawn("npm") fails without shell:true on Windows; use npm.cmd or shell.' });
    id = /(global:mem_\w+)/.exec(out)?.[1];
    if (!id) throw new Error(out);
    return out;
  });
  await step('memory_recall', async () => {
    const out = await call('memory_recall', { query: 'spawn npm windows' });
    if (!out.includes(id)) throw new Error(`written memory not recalled:\n${out}`);
    return out;
  });
  await step('memory_write duplicate is merged', async () => {
    const out = await call('memory_write', { kind: 'pitfall', title: 'Smoke test: npm on Windows needs .cmd shims', body: 'spawn("npm") fails without shell:true on Windows; use npm.cmd or shell.' });
    if (!out.includes('Already remembered')) throw new Error(out);
    return out;
  });
  await step('memory_feedback', () => call('memory_feedback', { id, helpful: true }));
  await step('memory_forget', () => call('memory_forget', { id }));
  await step('resource memory index', async () => (await client.readResource({ uri: 'appforge://memory/index' })).contents[0].text.split('\n').slice(0, 3).join(' | '));
}

if (want('skills')) {
  await step('skill_search (first call syncs Anthropic sources)', () => call('skill_search', { query: 'pdf forms' }, 300_000));
  await step('skill_search plugins', () => call('skill_search', { query: 'code review', kind: 'plugin', limit: 5 }));
  await step('skill_get', async () => (await call('skill_get', { id: 'anthropic-skills/skill/webapp-testing' })).slice(0, 300));
  if (home) {
    await step('skill_install (generic, into the temp folder)', async () => {
      const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'appforge-proj-'));
      const out = await call('skill_install', { id: 'anthropic-skills/skill/webapp-testing', client: 'generic', scope: 'project', project: proj });
      if (!fs.existsSync(path.join(proj, '.agents', 'skills', 'webapp-testing', 'SKILL.md'))) throw new Error(out);
      return out.slice(0, 300);
    });
  }
}

if (want('repos')) {
  await step('repo_tree', async () => (await call('repo_tree', { repo: 'anthropics/skills' })).slice(0, 300));
  await step('repo_read_file', async () => (await call('repo_read_file', { repo: 'anthropics/skills', path: 'README.md' })).slice(0, 200));
  await step('repo_details', async () => (await call('repo_details', { repo: 'jo-inc/camofox-browser' }, 180_000)).slice(0, 400));
  await step('repo_search', async () => (await call('repo_search', { need: 'markdown editor web component' }, 600_000)).slice(0, 800), 600_000);
}

if (want('browser')) {
  let tab;
  await step('browser_open', async () => {
    const out = await call('browser_open', { url: 'https://example.com' }, 180_000);
    tab = /tab (\S+)/.exec(out)?.[1];
    return out.slice(0, 300);
  });
  if (tab) {
    await step('browser_navigate macro', async () => (await call('browser_navigate', { tabId: tab, macro: '@wikipedia_search', query: 'Model Context Protocol' }, 120_000)).slice(0, 300));
    await step('browser_tabs close all', () => call('browser_tabs', { action: 'close' }));
  }
}

await client.close();
if (home) fs.rmSync(home, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} step(s) failed. Server log tail:\n${stderr.join('').split('\n').slice(-25).join('\n')}`);
  process.exit(1);
}
console.log('\nAll smoke steps passed.');

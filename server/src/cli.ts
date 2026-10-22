#!/usr/bin/env node
// `appforge`: the MCP server (`appforge serve`, what MCP clients run) and a few commands for people.

import { setSetting, getSetting, loadConfig } from './config.js';
import { dataDir, paths } from './paths.js';
import { VERSION } from './version.js';

const HELP = `AppForge ${VERSION}: one local MCP server that helps AI agents find, create and improve apps.

Usage: appforge <command>

  serve                       run the MCP server on stdio (what VS Code / Claude Code start)
  doctor                      check what works and what is missing
  register [clients]          add AppForge to vscode, claude or all (default all)
  unregister [clients]        remove it again
  setup [browser|models|all]  download the Camoufox browser (~300 MB) and the ranking models (~180 MB)
  memory stats|list|consolidate|reset [--empty]|path
  skills sync [--force] | skills list
  config list | config get <key> | config set <key> <value> | config path
  update-check                compare with the newest version on GitHub
  version

Settings, memory and caches live in ${dataDir()}`;

async function main(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv;
  switch (cmd) {
    case 'serve': {
      const { serve } = await import('./mcp.js');
      await serve();
      return -1; // keep running
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      return 0;
    case 'doctor':
      return doctor();
    case 'register':
    case 'unregister': {
      const { registerClients, manualSnippet } = await import('./clients.js');
      const clients = [sub, ...rest].filter(Boolean) as string[];
      const results = registerClients({ clients: clients.length ? clients : ['all'], remove: cmd === 'unregister' });
      for (const r of results) console.log(`${r.client}: ${r.status}${r.detail ? ` (${r.detail})` : ''}`);
      if (cmd === 'register') console.log(`\nOther MCP clients (Cursor, Windsurf, Gemini CLI, ...): add this to their MCP settings:\n${manualSnippet()}`);
      return results.some((r) => r.status === 'failed') ? 1 : 0;
    }
    case 'setup':
      return setup(sub ?? 'all');
    case 'memory':
      return memory(sub, rest);
    case 'skills': {
      const { skillBrowser } = await import('../../skill-browser/src/tools.js');
      const sb = skillBrowser();
      if (sub === 'sync') console.log(JSON.stringify(await sb.sync({ force: rest.includes('--force') }), null, 2));
      else console.log(JSON.stringify(sb.status(), null, 2));
      sb.close();
      return 0;
    }
    case 'config':
      if (sub === 'get' && rest[0]) console.log(JSON.stringify(getSetting(rest[0]), null, 2));
      else if (sub === 'set' && rest[0] && rest[1] !== undefined) {
        const raw = rest.slice(1).join(' ');
        let value: unknown = raw;
        if (/^[[{]/.test(raw.trim())) value = JSON.parse(raw);
        console.log(`${rest[0]} = ${JSON.stringify(setSetting(rest[0], value))}`);
      } else if (sub === 'path') console.log(paths.config);
      else console.log(JSON.stringify(loadConfig(), null, 2));
      return 0;
    case 'update-check': {
      const { fetchLatestVersion, updateCommand } = await import('./update-check.js');
      const { compareVersions } = await import('./version.js');
      const latest = await fetchLatestVersion();
      if (!latest) console.log(`AppForge ${VERSION}. Could not reach GitHub.`);
      else if (compareVersions(latest, VERSION) > 0) console.log(`AppForge ${VERSION}; ${latest} is available. Update with: ${updateCommand()}`);
      else console.log(`AppForge ${VERSION} is up to date.`);
      return 0;
    }
    default:
      console.error(`Unknown command "${cmd}".\n\n${HELP}`);
      return 2;
  }
}

async function setup(what: string): Promise<number> {
  let code = 0;
  if (what === 'browser' || what === 'all') {
    const { camoufoxInstalled, fetchCamoufox } = await import('../../camofox-browser/src/manager.js');
    if (camoufoxInstalled()) console.log('Camoufox browser: already downloaded.');
    else {
      console.log('Downloading the Camoufox browser (about 300 MB)...');
      if (!fetchCamoufox()) {
        console.error('Camoufox download failed; browser_* tools will not work until `appforge setup browser` succeeds.');
        code = 1;
      }
    }
  }
  if (what === 'models' || what === 'all') {
    console.log('Getting the repo-ranking models (about 180 MB the first time)...');
    try {
      const { prefetchModels } = await import('../../RepoRadar/src/radar.js');
      console.log(`Models ready: ${(await prefetchModels()).join(', ')}`);
    } catch (e) {
      console.error(`Model download failed: ${e instanceof Error ? e.message : String(e)}. repo_search downloads them on first use instead.`);
      code = 1;
    }
  }
  return code;
}

async function memory(sub: string | undefined, rest: string[]): Promise<number> {
  const { memoryService } = await import('../../memory/src/tools.js');
  const mem = await memoryService({ config: loadConfig });
  switch (sub) {
    case 'list':
      for (const i of mem.list().sort((a, b) => b.strength - a.strength)) console.log(`[${i.kind}] ${i.title}  (${i.id}, ${i.strength})`);
      return 0;
    case 'consolidate':
      console.log(JSON.stringify(await mem.consolidate(), null, 2));
      return 0;
    case 'reset': {
      const n = await mem.reset({ empty: rest.includes('--empty') });
      console.log(`Removed ${n} memories.${rest.includes('--empty') ? '' : ' The starter guidelines were added again.'}`);
      return 0;
    }
    case 'path':
      console.log(paths.memory);
      return 0;
    default:
      console.log(JSON.stringify(mem.stats(), null, 2));
      return 0;
  }
}

async function doctor(): Promise<number> {
  const { status } = await import('./forge.js');
  const s = await status();
  const ok = (b: boolean) => (b ? 'ok  ' : 'MISSING');
  console.log(`AppForge ${s.version} (Node ${s.node})`);
  console.log(`  install folder: ${s.installFolder}`);
  console.log(`  data folder:    ${s.dataFolder}`);
  if (s.newerVersion) console.log(`  update:         ${s.newerVersion} is available`);
  console.log(`\n  ${ok(s.repos.pipelineBuilt)} repo search pipeline built`);
  console.log(`  ${ok(s.github.tokenFound)} GitHub login (needed for repo_search; run \`gh auth login\` or set GITHUB_TOKEN)`);
  console.log(`  ${ok(s.repos.modelsDownloaded)} ranking models downloaded (\`appforge setup models\`, or on first search)`);
  console.log(`  ${ok(s.browser.camoufoxDownloaded)} Camoufox browser downloaded (\`appforge setup browser\`)`);
  const { memoryService } = await import('../../memory/src/tools.js');
  const st = (await memoryService({ config: loadConfig })).stats();
  console.log(`  ok   memory: ${st.entries} entries, ${st.usedPercent}% of the limit (${st.limits.maxEntries} entries / ${st.limits.maxMB} MB)`);
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const vscodeMcp = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Code', 'User', 'mcp.json');
  const inVsCode = fs.existsSync(vscodeMcp) && fs.readFileSync(vscodeMcp, 'utf8').includes('"appforge"');
  console.log(`  ${ok(inVsCode)} registered in VS Code (\`appforge register vscode\`)`);
  const claudeJson = path.join(os.homedir(), '.claude.json');
  const inClaude = fs.existsSync(claudeJson) && fs.readFileSync(claudeJson, 'utf8').includes('"appforge"');
  console.log(`  ${inClaude ? 'ok  ' : '-   '} registered in Claude Code (\`appforge register claude\`, if you use it)`);
  return s.repos.pipelineBuilt ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);

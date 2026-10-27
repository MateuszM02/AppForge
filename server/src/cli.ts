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
  setup [browser|models|all] [small|balanced|best]
                              download the Camoufox browser (~300 MB) and the repo-search models
                              (a profile: about 0.2 / 1.2 / 2.6 GB; asks which when run in a terminal)
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
      return setup(sub ?? 'all', rest[0]);
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

async function setup(what: string, profileArg?: string): Promise<number> {
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
    try {
      const profile = await chooseProfile(profileArg);
      setSetting('repos.modelProfile', profile);
      const { downloadMB } = await import('./models.js');
      console.log(`Getting the "${profile}" repo-search models (up to ${(downloadMB(profile) / 1000).toFixed(1)} GB the first time)...`);
      const { prefetchModels } = await import('../../RepoRadar/src/radar.js');
      console.log(`Models ready: ${(await prefetchModels(profile)).join(', ')}`);
      await offerCleanup(profile);
    } catch (e) {
      console.error(`Model download failed: ${e instanceof Error ? e.message : String(e)}. Retry with \`appforge setup models\`.`);
      code = 1;
    }
  }
  return code;
}

async function ask(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

/** The GPU node-llama-cpp would use here ("vulkan", "cuda", "metal"), or false for CPU only. */
async function detectGpu(): Promise<string | false> {
  try {
    const { getLlama, LlamaLogLevel } = await import('node-llama-cpp');
    const llama = await getLlama({ gpu: process.env.APPFORGE_GPU === 'off' ? false : 'auto', build: 'never', progressLogs: false, logLevel: LlamaLogLevel.error });
    const gpu = llama.gpu;
    await llama.dispose();
    return gpu;
  } catch {
    return false;
  }
}

/**
 * The model profile: from the command line or APPFORGE_MODELS, else asked in a terminal with a table of sizes, speed
 * estimates for this machine and measured quality (Enter = best), else the configured one.
 */
async function chooseProfile(arg?: string): Promise<import('./models.js').ProfileName> {
  const m = await import('./models.js');
  const given = arg ?? process.env.APPFORGE_MODELS;
  if (given) {
    if (!m.isProfile(given)) throw new Error(`Unknown model profile "${given}": use small, balanced or best.`);
    return given;
  }
  const current = loadConfig().repos.modelProfile;
  if (!process.stdin.isTTY) return m.isProfile(current) ? current : 'best';
  const gpu = await detectGpu();
  const probe = m.probeMs();
  console.log(`\nrepo_search ranks results with two local models. Choose a profile (${m.cpuSummary()}, ${gpu ? `GPU: ${gpu}` : 'no GPU found, so the models run on the CPU'}):\n`);
  console.log('  profile      download   RAM / GPU memory***   time per search*   quality**   models');
  for (const name of m.PROFILE_NAMES) {
    const p = m.PROFILES[name];
    const est = m.estimateSeconds(name, { probeMs: probe, gpu: gpu !== false });
    const time = est ? `${est.low}-${est.high} s` : 'not measured';
    const quality = p.quality != null ? p.quality.toFixed(2) : '-';
    const hw = `${p.hardware.ramGB} / ${p.hardware.vramGB} GB`;
    const models = [m.ENCODERS[p.embed]!.id, m.ENCODERS[p.rerank]!.gguf?.file ?? m.ENCODERS[p.rerank]!.id].map((x) => x.split('/').pop()!.replace(/\.Q\w+\.gguf$/, '')).join(', ');
    console.log(`  ${name.padEnd(11)}  ${`${(m.downloadMB(name) / 1000).toFixed(1)} GB`.padStart(8)}   ${hw.padStart(19)}   ${time.padStart(16)}   ${quality.padStart(9)}   ${models}`);
  }
  console.log(`\n  * estimated for this computer from measurements on a ${m.REFERENCE.machine}`);
  console.log('  ** nDCG@10 on the AppForge search test set (0-1, higher is better)');
  console.log('  *** free RAM it needs, and the GPU memory that holds all its models (less works, more slowly; no GPU works too)\n');
  for (;;) {
    const a = await ask('Profile [small/balanced/best] (Enter = best): ');
    if (!a) return 'best';
    if (m.isProfile(a)) return a;
    console.log('Please type small, balanced or best.');
  }
}

/** Offers to delete downloaded models the chosen profile does not use (only models listed in models.ts). */
async function offerCleanup(profile: import('./models.js').ProfileName): Promise<void> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const m = await import('./models.js');
  const keep = m.PROFILES[profile];
  const unused: string[] = [];
  for (const [key, e] of Object.entries(m.ENCODERS)) {
    const dir = e.gguf ? path.join(paths.models, 'rerank', e.gguf.file) : path.join(paths.models, ...e.id.split('/'));
    if (key !== keep.embed && key !== keep.rerank && fs.existsSync(dir)) unused.push(dir);
  }
  const llms = path.join(paths.models, m.LEGACY_LLM_DIR);
  if (fs.existsSync(llms)) unused.push(llms);
  if (!unused.length) return;
  const size = (p: string): number => {
    const st = fs.statSync(p);
    return st.isDirectory() ? fs.readdirSync(p).reduce((sum, f) => sum + size(path.join(p, f)), 0) : st.size;
  };
  const gb = unused.reduce((sum, p) => sum + size(p), 0) / 1e9;
  if (!process.stdin.isTTY) {
    console.log(`${gb.toFixed(1)} GB of models from other profiles stay in ${paths.models} (run \`appforge setup models\` in a terminal to remove them).`);
    return;
  }
  const a = await ask(`Remove ${gb.toFixed(1)} GB of models the "${profile}" profile does not use? [Y/n] `);
  if (a === '' || a.startsWith('y')) {
    for (const p of unused) fs.rmSync(p, { recursive: true, force: true });
    console.log('Removed.');
  }
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
  console.log(`  ${ok(s.repos.modelsDownloaded)} repo-search models of the "${s.repos.modelProfile}" profile downloaded (\`appforge setup models\` gets or changes them)`);
  console.log(`  ${ok(s.browser.camoufoxDownloaded)} Camoufox browser downloaded (\`appforge setup browser\`)`);
  const { memoryService } = await import('../../memory/src/tools.js');
  const st = (await memoryService({ config: loadConfig })).stats();
  console.log(`  ok   memory: ${st.entries} entries, ${st.usedPercent}% of the limit (${st.limits.maxEntries} entries / ${st.limits.maxMB} MB)`);
  const { registeredIn } = await import('./clients.js');
  const reg = registeredIn();
  console.log(`  ${ok(reg.vscode)} registered in VS Code (\`appforge register vscode\`)`);
  console.log(`  ${reg.claude ? 'ok  ' : '-   '} registered in Claude Code (\`appforge register claude\`, if you use it)`);
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

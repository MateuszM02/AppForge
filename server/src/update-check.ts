// "Is there a newer AppForge?" Compares the running version with the folder it was installed from (pulled but not
// re-installed) and with GitHub (raw package.json, no API quota). Never blocks, never asks for anything.

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { logger } from './log.js';
import { repoRoot } from './paths.js';
import { compareVersions, readVersion, VERSION } from './version.js';

const log = logger('update');
const RAW_PACKAGE = 'https://raw.githubusercontent.com/MateuszM02/AppForge/main/package.json';
let latest: string | null = null;

export function latestKnownVersion(): string | null {
  return latest && compareVersions(latest, VERSION) > 0 ? latest : null;
}

export function updateCommand(): string {
  const isGit = fs.existsSync(path.join(repoRoot, '.git'));
  if (process.platform === 'win32') {
    return isGit
      ? `git -C "${repoRoot}" pull, then powershell -ExecutionPolicy Bypass -File "${path.join(repoRoot, 'install.ps1')}"`
      : 'irm https://raw.githubusercontent.com/MateuszM02/AppForge/main/install.ps1 | iex';
  }
  return isGit ? `git -C "${repoRoot}" pull && sh "${path.join(repoRoot, 'install.sh')}"` : 'curl -fsSL https://raw.githubusercontent.com/MateuszM02/AppForge/main/install.sh | sh';
}

/** Newest version on GitHub, or null when unreachable (6 s timeout). */
export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(RAW_PACKAGE, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'AppForge' } });
    if (!res.ok) return null;
    latest = ((await res.json()) as { version?: string }).version ?? null;
    return latest;
  } catch {
    return null;
  }
}

/** Logged once at server start (the client shows it in the server output). */
export async function startupUpdateNotice(): Promise<void> {
  if (!loadConfig().updateCheck || process.env.APPFORGE_NO_UPDATE_CHECK === '1') return;
  const folder = readVersion(repoRoot);
  if (compareVersions(folder, VERSION) > 0) {
    log.warn(`AppForge ${VERSION} is running but the folder has ${folder}; re-run the installer to finish the update.`);
    return;
  }
  const remote = await fetchLatestVersion();
  if (remote && compareVersions(remote, VERSION) > 0) {
    log.warn(`You are using AppForge ${VERSION} instead of the newest ${remote}. Update with: ${updateCommand()}`);
  }
}

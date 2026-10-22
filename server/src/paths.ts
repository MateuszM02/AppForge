// Where AppForge keeps things. Code lives in the repo folder; everything a user creates (memory, caches, config,
// downloaded models) lives in one per-user data folder, so reinstalling or deleting the repo never loses it.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo / install folder (this file is dist/server/src/paths.js or server/src/paths.ts). */
export const repoRoot = (() => {
  const up2 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  return path.basename(up2) === 'dist' ? path.dirname(up2) : up2;
})();

/** APPFORGE_HOME, else %LOCALAPPDATA%\AppForge, ~/Library/Application Support/AppForge or ~/.local/share/appforge. */
export function dataDir(): string {
  if (process.env.APPFORGE_HOME) return path.resolve(process.env.APPFORGE_HOME);
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'AppForge');
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'AppForge');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'appforge');
}

export const paths = {
  get config() { return path.join(dataDir(), 'config.json'); },
  get memory() { return path.join(dataDir(), 'memory'); },
  get cache() { return path.join(dataDir(), 'cache'); },
  get models() { return path.join(dataDir(), 'models'); },
  get logs() { return path.join(dataDir(), 'logs'); },
  get browser() { return path.join(dataDir(), 'browser'); },
};

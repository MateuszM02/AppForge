// The version lives in one place only: package.json at the repo root. Installers compare it to decide whether to
// rebuild, and `appforge` compares it with the folder it was installed from and with GitHub.

import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './paths.js';

export function readVersion(root: string = repoRoot): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version as string;
  } catch {
    return '0.0.0';
  }
}

/** The version that was built (dist/build.json), which is what runs; package.json is what the folder has. */
function builtVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, 'dist', 'build.json'), 'utf8')).version as string;
  } catch {
    return readVersion();
  }
}

export const VERSION = builtVersion();

/** -1, 0 or 1 like a comparator, for plain x.y.z versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

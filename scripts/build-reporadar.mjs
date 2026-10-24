// Bundles RepoRadar's search pipeline (RepoRadar/upstream/src/lib, unchanged) with the headless entry into
// dist/reporadar/headless.mjs. Import rewrites, so the upstream code needs no edits:
//   @/...                  -> RepoRadar/upstream/src/...
//   @prisma/client, @/lib/db -> RepoRadar/headless/prisma-shim.ts (SQLite instead of PostgreSQL)
//   @xenova/transformers   -> @huggingface/transformers (same API; prebuilt binaries, no install scripts)
//   openai                 -> RepoRadar/headless/openai-local.ts (only the listwise ranker, on a local model)
//   next/cache             -> stub (no Next.js)
//   process.stdout.write   -> process.stderr.write (stdout belongs to the MCP transport)
// npm packages stay external and load from node_modules.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstreamSrc = path.join(root, 'RepoRadar', 'upstream', 'src');
const headless = path.join(root, 'RepoRadar', 'headless');

const redirects = {
  '@prisma/client': path.join(headless, 'prisma-shim.ts'),
  '@/lib/db': path.join(headless, 'prisma-shim.ts'),
  openai: path.join(headless, 'openai-local.ts'),
  'next/cache': path.join(headless, 'next-cache-stub.ts'),
};

const resolvePlugin = {
  name: 'reporadar-paths',
  setup(b) {
    b.onResolve({ filter: /^(@prisma\/client|@\/lib\/db|openai|next\/cache)$/ }, (args) => ({ path: redirects[args.path] }));
    b.onResolve({ filter: /^@xenova\/transformers$/ }, () => ({ path: '@huggingface/transformers', external: true }));
    b.onResolve({ filter: /^@\// }, async (args) => {
      const r = await b.resolve('./' + args.path.slice(2), { resolveDir: upstreamSrc, kind: args.kind });
      return r.errors.length ? { errors: r.errors } : { path: r.path };
    });
    // Upstream writes logs/ under the current directory, which for an MCP server is often the user's project.
    // At bundle time (files on disk unchanged) that directory becomes AppForge's cache folder instead. Its logger
    // also prints info lines with process.stdout.write, which bypasses the console redirect and would put
    // non-protocol lines on the MCP stdio channel, so those go to stderr.
    b.onLoad({ filter: /RepoRadar[\\/]upstream[\\/]src[\\/].*\.ts$/ }, async (args) => {
      const code = await fs.promises.readFile(args.path, 'utf8');
      return {
        contents: code
          .replaceAll('process.cwd()', '(process.env.APPFORGE_RADAR_DB_DIR || process.cwd())')
          .replaceAll('process.stdout.write(', 'process.stderr.write('),
        loader: 'ts',
      };
    });
  },
};

await build({
  entryPoints: [path.join(headless, 'entry.ts')],
  outfile: path.join(root, 'dist', 'reporadar', 'headless.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  plugins: [resolvePlugin],
  logLevel: 'warning',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log('built dist/reporadar/headless.mjs');

// The version this build is of: `appforge` compares it with package.json to spot a pull without a re-install.
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(root, 'dist', 'build.json'), JSON.stringify({ version, builtAt: new Date().toISOString() }, null, 2) + '\n');

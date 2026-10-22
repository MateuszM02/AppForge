# Upstream: hippo-memory

- Repository: https://github.com/kitfunso/hippo-memory (MIT, Copyright (c) 2026 Keith So)
- Version 2.1.0, commit `243673dffb2bd7075c1cefc0f0e0ce3a8f540406`
- Copied: `src/`, `bin/`, `LICENSE`, `README.md`, `package.json`, `tsconfig.json`
- Not copied: docs, benchmarks, tests, UI, website, Python bindings, extensions (not needed at run time)
- Local changes to upstream files: **none**. AppForge calls it only through [src/hippo.ts](src/hippo.ts) and
  compiles `upstream/src` with the root `tsconfig.json`. Its hooks, cron job and HTTP server are not used.

Update: `node scripts/sync-upstream.mjs memory` (see the script for how local changes are kept).

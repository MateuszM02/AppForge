# Upstream: RepoRadar

- Repository: https://github.com/Panther114/RepoRadar (MIT, Copyright (c) 2026 RepoRadar contributors)
- Version 1.1.5, commit `2e967b05ed0683df96aa6d59e63ec0197aef6c52`
- Copied: everything except `public/` (demo media), `tests/` and `.github/`
- Used at run time: `src/lib/**` (the search pipeline), bundled by `scripts/build-reporadar.mjs`
- Not used: the Next.js app (`src/app`, `src/components`), Prisma schema and migrations, Docker files. They are
  kept so the web UI can still be run from `upstream/` the upstream way (PostgreSQL + `pnpm dev`) if wanted.
- Local changes to upstream files: **none**. All adaptations are import rewrites at bundle time (see
  [README.md](README.md)) and the files in [headless/](headless/).

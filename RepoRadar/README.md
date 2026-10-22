# RepoRadar (in AppForge)

Find GitHub repositories by what they do, not by their name, and look inside any repository without cloning it.

The search is [RepoRadar](https://github.com/Panther114/RepoRadar) (MIT), vendored unchanged in
[upstream/](upstream/). RepoRadar is a Next.js web app on PostgreSQL + pgvector; AppForge runs only its search
pipeline, **headless**, with no database server, no Docker and no LLM:

- [headless/prisma-shim.ts](headless/prisma-shim.ts) stands in for Prisma with one SQLite file
  (`cache/reporadar.db`), implementing just the calls the pipeline makes. Vector similarity is computed in JS
  upstream already, so pgvector is not needed. Snapshot/README history tables are not kept.
- [headless/entry.ts](headless/entry.ts) starts a search, reads its results, and builds single-repo evidence.
- [../scripts/build-reporadar.mjs](../scripts/build-reporadar.mjs) bundles it with esbuild into
  `dist/reporadar/headless.mjs`, rewriting imports so the upstream files stay untouched: `@/…` → `upstream/src/…`,
  `@prisma/client` → the shim, `@xenova/transformers` → `@huggingface/transformers` (same API, no install
  scripts), `openai` and `next/cache` → stubs, and `process.cwd()` → AppForge's cache folder (for its logs).
- `NO_LLM_MODE=true` always: ranking is RepoRadar's deterministic scorer plus local embeddings
  (`Xenova/all-MiniLM-L6-v2`) and a cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2`), downloaded once to
  `models/` (~180 MB). The calling agent does any reasoning on top.

## Tools

| Tool | What it does | GitHub login |
|---|---|---|
| `repo_search` | plain-language need → ranked shortlist (fit, future, underrated, risks, evidence). About a minute; returns a job id if it takes longer than `repos.waitSeconds` | required |
| `repo_search_result` | results of a search that was still running | required |
| `repo_details` | one repository: metadata, activity, releases, issues/PRs, contributors, manifests, docs signals, README excerpt, health and risk assessment | full with login; basic facts without |
| `repo_compare` | 2-6 repositories side by side | full with login; basic without |
| `repo_tree` | files and folders of a repository (or a folder of it) | no |
| `repo_read_file` | text of one file, in parts for long files | no |

Why the login: one search makes about 100 GitHub API requests (several search queries, awesome-lists, package
registries, then evidence for the shortlist, partly through GitHub's GraphQL API, which needs a login).
Without a login GitHub allows 60 requests an hour. `gh auth login` (the installer offers it) or `GITHUB_TOKEN`
gives 5,000.

`repo_tree` and `repo_read_file` use `git ls-remote`, raw.githubusercontent.com and cached file lists, so they
work without a login and barely touch the quota.

## Code

- [src/radar.ts](src/radar.ts): loads the bundle with AppForge's settings, tracks running searches, prefetches models.
- [src/tools.ts](src/tools.ts): MCP tools, result formatting, basic details without a login.

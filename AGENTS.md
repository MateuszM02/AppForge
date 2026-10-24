# AppForge: working rules

AppForge (a local MCP server in TypeScript/Node) by MateuszM02. These rules are for people and AI agents changing
this repository; the user-facing docs are in README.md.

## Git

- Commit as the owner: `MateuszM02 <mat.maz.opole@gmail.com>`. One logical change per commit; the message says
  what changed and why.
- Push only after the change is verified (build + relevant tests + the change itself exercised, e.g. with
  `npm run smoke` or a real client), and say what was verified.
- No GitHub Actions / CI: tests run locally, and only the ones a change needs.

## Version

- The version lives only in `package.json`. **Every commit that changes the app** (anything except docs, tests
  and these rule files) bumps it: `0.1.0` -> `0.2.0` (or `0.1.1` for a fix). The installers rebuild only when it
  changed, and running servers warn when the folder or GitHub has a newer one.
- Keep `plugin/.claude-plugin/plugin.json` at the same version.

## Code

- Vendored upstream code lives in `*/upstream/` and is not edited; adapt it from the outside (AppForge's own
  `src/` next to it, the bundler rewrites in `scripts/build-reporadar.mjs`). If an upstream file must change,
  list it in that folder's `UPSTREAM.md`. Update with `node scripts/sync-upstream.mjs <part>`.
- stdout belongs to the MCP transport: log with `logger()` (stderr), never `console.log` in server code.
- Tool descriptions, instructions and prompts must work with any LLM: plain words, no model-specific features.
- Every user-visible path or setting goes through `server/src/paths.ts` / `server/src/config.ts`; user data never
  goes into the code folder or the current directory.

## Build and test

```
npm ci && npm run build      # Node 22.16+; the installer's private Node is in %LOCALAPPDATA%\AppForge\node
npm test                     # unit tests, seconds
node scripts/smoke.mjs <groups>   # memory skills repos browser forge; real services; temp data folder
node scripts/eval-search.mjs      # repo_search quality (nDCG, recall, traps, seconds) on tests/search-gold.json
```

`repo_search` needs a GitHub login (`gh auth login` or `GITHUB_TOKEN`); the browser step needs
`appforge setup browser`.

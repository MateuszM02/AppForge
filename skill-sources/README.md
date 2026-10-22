# skill-sources

Where AppForge's skills and plugins come from, and the local catalog they are indexed into.

By default two Anthropic repositories, read straight from GitHub when needed and **never stored in this
repository**:

| Source key | Repository | Kind | What it contributes |
|---|---|---|---|
| `anthropic-skills` | [anthropics/skills](https://github.com/anthropics/skills) | skills (+ marketplace) | ~18 skills (pdf, docx, webapp-testing, mcp-builder, frontend-design, ...) and their plugin bundles |
| `anthropic-plugins` | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | marketplace | ~315 Claude plugins, plus the skills, commands, agents and MCP servers of the plugins kept in that repo |

More sources (any GitHub repo with `SKILL.md` folders, or any Claude plugin marketplace) are added with the
`skill_sources` tool; the community catalog bundled with [skill-browser](../skill-browser/) is switched on with
`skill_sources add community` or `skills.communityCatalog=true`.

## How a sync works (cheap on purpose)

1. Current commit of the default branch with `git ls-remote` (no API quota; the API with an ETag when Git is
   missing). Unchanged since the last sync: done.
2. The file list at that commit: one API call (`git/trees?recursive=1`), cached forever per commit; when the API
   limit is reached, the list is read from the codeload tarball instead.
3. Front matter of `SKILL.md`, `commands/*.md`, `agents/*.md`, `.mcp.json` and `.claude-plugin/marketplace.json`
   from raw.githubusercontent.com (no API quota), cached forever per commit.
4. Everything goes into `cache/skills.db` (SQLite with a full-text index): name, description, kind, plugin,
   licence, homepage and where the files are (repo, commit, path).

Sources are checked at most every `skills.syncHours` (24) hours, on first use, or with `skills_sync` /
`appforge skills sync --force`. A first sync of both sources takes about 15 seconds.

Marketplace plugins come in three source forms, all handled: a path in the marketplace repo (`./plugins/x`),
`{"source": "url", "url": ..., "sha": ...}` and `{"source": "git-subdir", "url": ..., "path": ..., "sha": ...}`.
Plugins hosted outside GitHub are listed with their homepage only.

## Code

- [src/catalog.ts](src/catalog.ts): the SQLite catalog and its full-text search (BM25, name weighted most).
- [src/sync.ts](src/sync.ts): reading sources from GitHub; also loads the bundled community catalog.

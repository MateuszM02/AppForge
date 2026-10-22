# memory

AppForge's long-term memory for AI agents: fast, local, readable by any LLM, with a size limit you set.

- **Engine**: [hippo-memory](https://github.com/kitfunso/hippo-memory) (MIT), vendored in [upstream/](upstream/):
  SQLite with BM25 search (no model, no network, a recall takes a few milliseconds), Markdown mirrors of every
  memory, strength that decays when unused and grows with use and good feedback.
- **AppForge layer** ([src/](src/)): one global store plus one store per project, a user-set limit with archiving,
  de-duplication, a starter pack, `INDEX.md` / `FORMAT.md`, and the MCP tools.

## Tools

| Tool | What it does |
|---|---|
| `memory_recall` | ranked memories for a query (global + current project), cut to a token budget |
| `memory_read` | one memory in full |
| `memory_write` | save a preference, lesson, decision, fact, pattern or pitfall; near-duplicates are merged |
| `memory_update` | change a memory's text, tags or kind |
| `memory_feedback` | helpful / wrong: changes how strongly it ranks |
| `memory_forget` | delete one memory |
| `memory_list` | titles, strongest first |
| `memory_stats` | usage against the limit, folder |
| `memory_config` | read or change `maxEntries`, `maxMB`, `recallBudgetTokens`, `keepArchive`, `starterPack` |
| `memory_consolidate` | merge near-duplicates and apply the limit now |

Resources: `appforge://memory/index` (INDEX.md) and `appforge://memory/format` (FORMAT.md).

## Scopes and projects

- **global**: preferences and general lessons (default for preference, lesson, pattern, pitfall).
- **project**: decisions and facts about one project (default for decision, fact). The project is the one open in
  the client (MCP roots), keyed by its git remote (two clones share memories) or its folder.

Memory ids say where a memory lives: `global:mem_1a2b3c4d5e6f` or `project:<key>:mem_...`.

## The limit

`memory.maxEntries` (default 500) and `memory.maxMB` (default 5 MB of text) cover all scopes together. After every
write, while either is exceeded, the least valuable memory that is not pinned leaves first. Value = current
strength × (1 + log(1 + uses)), halved for starter guidelines and for memories marked wrong more often than
helpful. Evicted memories are appended to `archive/<yyyy-mm>.md` (or deleted when `memory.keepArchive` is false).
Lowering the limit with `memory_config` applies it at once.

## Starter pack

A new memory starts with ~12 general guidelines (check memory first, look for an existing project or skill before
building, prefer maintained permissive dependencies, verify before claiming done, Windows quoting, no secrets in
git, ...), tagged `starter`. Their half-life is halved, so they fade twice as fast unless they are used, and
they count half when the limit picks what to archive.
`appforge memory reset --empty` removes them for good; `memory.starterPack=false` prevents them.

## Files (for any LLM or person)

See [src/format.ts](src/format.ts), which is written to the memory folder as `FORMAT.md`. In short: `INDEX.md`
lists every memory; each memory is a Markdown file with YAML front matter in `global/` or `projects/<key>/`
(subfolders `buffer`, `episodic`, `semantic`); the first line of the text is the title.

## Code

- [src/hippo.ts](src/hippo.ts): the only file that calls the vendored engine.
- [src/memory.ts](src/memory.ts): stores, limit, archive, de-duplication, index.
- [src/tools.ts](src/tools.ts): MCP tools and resources.
- [src/starter.ts](src/starter.ts), [src/format.ts](src/format.ts): starter pack and FORMAT.md.

# AppForge

One local MCP server that gives any AI coding agent (GitHub Copilot in VS Code, Claude Code, Cursor, Codex,
Gemini CLI, ...) the tools to **find, create and improve apps**:

- **Memory** kept on your computer: your preferences, lessons, decisions and pitfalls, with a size limit you set.
- **Repo search**: find open-source projects by what they do, ranked by fit, health and risk ([RepoRadar](RepoRadar/)).
- **Skills and plugins**: search and install Anthropic's official agent skills and Claude plugins ([skill-browser](skill-browser/)).
- **Stealth browser**: read docs and sites that block bots ([camofox-browser](camofox-browser/)).

Everything runs locally, for free, with no account needed (a GitHub login unlocks repo search).

**Quick start** (Windows, PowerShell):

```powershell
irm https://raw.githubusercontent.com/MateuszM02/AppForge/main/install.ps1 | iex
```

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/MateuszM02/AppForge/main/install.sh | sh
```

Then open VS Code, switch Copilot Chat to **Agent** mode and ask, for example:
*"Use AppForge to find an open-source habit tracker I can extend"* or type `/create-app`.

**Contents:** [Install](#install) · [Update](#update) · [Uninstall](#uninstall) · [Use](#use) · [Tools](#tools) ·
[How it works](#how-it-works) · [Where data lives](#where-data-lives) · [Settings](#settings) ·
[Other MCP clients](#other-mcp-clients) · [Safety and privacy](#safety-and-privacy) · [Develop](#develop) ·
[Why a local MCP server](#why-a-local-mcp-server-and-not-a-hosted-one) · [Credits](#credits)

## Install

The one command above does everything, without administrator rights:

1. Downloads AppForge to `%LOCALAPPDATA%\AppForge\app` (macOS: `~/Library/Application Support/AppForge/app`,
   Linux: `~/.local/share/appforge/app`), with `git clone` when Git is installed, else as a ZIP.
2. Installs a private **Node.js 24 LTS** next to it, checked against nodejs.org's SHA-256 list. Your own Node.js
   (if any) is not touched.
3. Installs the dependencies and builds AppForge.
4. Downloads the **Camoufox** browser (~300 MB) and two small ranking models (~180 MB).
   `APPFORGE_MINIMAL=1` skips this; they are then fetched by `appforge setup` or on first use.
5. Adds the `appforge` command and registers the MCP server in **VS Code** (and VS Code Insiders) and
   **Claude Code**, when they are installed.
6. Offers to install the **GitHub CLI** and log in (Enter = yes). Repo search needs a GitHub login; everything
   else works without one. You can set a `GITHUB_TOKEN` environment variable instead.

Already have the repository (git clone or *Code → Download ZIP*)? Run the installer from it:

```powershell
powershell -ExecutionPolicy Bypass -File AppForge\install.ps1
```

```sh
sh AppForge/install.sh
```

The first time VS Code starts the server it may ask you to trust it (Extensions view → **MCP SERVERS**, or the
tools button in the chat box). Check what works with:

```
appforge doctor
```

## Update

Run the install command again. It updates the code (`git pull` or a fresh download) and rebuilds only when the
version changed. When the server starts it also checks GitHub and writes a notice to the MCP output log when a
newer version exists; `appforge update-check` asks on demand.

## Uninstall

```powershell
irm https://raw.githubusercontent.com/MateuszM02/AppForge/main/uninstall.ps1 | iex
```

```sh
sh ~/.local/share/appforge/app/uninstall.sh     # macOS: ~/Library/Application\ Support/AppForge/app/uninstall.sh
```

It removes the VS Code / Claude Code registrations, the `appforge` command, the private Node.js, the downloaded
code, caches, models and browser profiles. It asks first (Enter = yes) before deleting your **memory and
settings**, and before deleting the Camoufox download (other tools may share it). A folder you cloned yourself is
left alone.

## Use

Talk to your agent normally; it picks the tools. Useful starting points:

| You say | What happens |
|---|---|
| `/create-app a markdown note app with sync` | `forge_plan` workflow: memory → existing repos → skills → docs → build |
| `/improve-app add offline support` | Looks for libraries, skills and docs before changing the open project |
| `/find-app self-hosted alternative to Notion` | Ranked, evidence-based shortlist with risks |
| "Remember that I prefer TypeScript and pnpm" | `memory_write` (global preference) |
| "Is there a skill for filling PDF forms?" | `skill_search` → `skill_get` → `skill_install` |
| "Open the Astro docs page about content collections" | `browser_open` |

The three prompts are MCP prompts: VS Code lists them when you type `/` in the chat (shown with the server
name), Claude Code as `/mcp__appforge__create-app` etc. The same workflows also ship as agent skills that the
agent picks up on its own (see [plugin/](plugin/)).

Commands for you (in a terminal):

```
appforge doctor                    what works, what is missing
appforge memory stats | list | consolidate | reset [--empty]
appforge config set memory.maxEntries 300
appforge skills sync --force
appforge setup [browser|models]    (re)download the browser or models
appforge register | unregister     add / remove AppForge in VS Code and Claude Code
```

## Tools

31 tools in five groups (switch groups off in [Settings](#settings) to keep your agent's tool list short).

| Group | Tools |
|---|---|
| Memory | `memory_recall`, `memory_read`, `memory_write`, `memory_update`, `memory_feedback`, `memory_forget`, `memory_list`, `memory_stats`, `memory_config`, `memory_consolidate` |
| Repos | `repo_search`, `repo_search_result`, `repo_details`, `repo_compare`, `repo_tree`, `repo_read_file` |
| Skills | `skill_search`, `skill_get`, `skill_install`, `skill_lint`, `skills_sync`, `skill_sources` |
| Browser | `browser_open`, `browser_snapshot`, `browser_act`, `browser_navigate`, `browser_extract`, `browser_tabs`, `browser_import_cookies` (+ `browser_evaluate` when enabled) |
| Workflow | `forge_plan`, `forge_status` |

Plus MCP prompts `create-app`, `improve-app`, `find-app` and resources `appforge://memory/index`,
`appforge://memory/format`. Each part's README describes its tools in detail.

## How it works

```
VS Code / Claude Code / any MCP client
        │ stdio (MCP)
        ▼
  server/  appforge serve ── one process, tool groups, prompts, GitHub client with ETag cache
    ├── memory/          hippo-memory engine (SQLite + Markdown) + size limit, archive, starter pack
    ├── skill-sources/   catalog of anthropics/skills + anthropics/claude-plugins-official (GitHub, no clone)
    ├── skill-browser/   search / inspect / install skills and plugins for each client
    ├── RepoRadar/       semantic repo search pipeline, bundled headless with SQLite instead of PostgreSQL
    └── camofox-browser/ Camoufox REST server, started on demand on 127.0.0.1, stopped when idle
```

- **No LLM calls of its own.** The agent you already use does the thinking; AppForge supplies data and actions.
  That keeps it free and works with any model.
- **GitHub without burning quota**: commit checks use `git ls-remote`, file contents come from
  raw.githubusercontent.com, API answers are cached with ETags (a "not modified" answer is free), and file lists
  fall back to the repository tarball when the API limit is reached.
- **Vendored upstreams**: the four third-party parts live in `*/upstream/` folders, unchanged or with changes
  listed in their `UPSTREAM.md`; AppForge's own adapters live next to them.

## Where data lives

All user data is in one folder, never in the code folder:
Windows `%LOCALAPPDATA%\AppForge`, macOS `~/Library/Application Support/AppForge`, Linux `~/.local/share/appforge`
(or `APPFORGE_HOME`).

| Path | What |
|---|---|
| `config.json` | your settings (only what differs from the defaults) |
| `memory/` | the memory: `INDEX.md`, `FORMAT.md`, `global/`, `projects/<key>/`, `archive/` |
| `cache/` | GitHub cache, skill catalog, RepoRadar cache and logs |
| `models/` | the two local ranking models |
| `browser/` | browser profiles, cookies, downloads |
| `node/`, `app/` | the private Node.js and the code (when installed with the one-line command) |

The Camoufox browser itself is in its standard cache (`%LOCALAPPDATA%\camoufox`, `~/Library/Caches/camoufox`,
`~/.cache/camoufox`).

## Settings

`appforge config list` shows everything; `appforge config set <key> <value>` changes one setting; every scalar
setting can also be an environment variable `APPFORGE_<SECTION>_<KEY>` (e.g. `APPFORGE_MEMORY_MAXENTRIES=200`).

| Setting | Default | Meaning |
|---|---|---|
| `memory.maxEntries` | 500 | active memories; over it the weakest unpinned ones move to `memory/archive/` |
| `memory.maxMB` | 5 | total text of active memories |
| `memory.recallBudgetTokens` | 1500 | size of a `memory_recall` answer |
| `memory.keepArchive` | true | keep evicted memories as Markdown (false = delete) |
| `memory.starterPack` | true | seed a new memory with ~12 general guidelines |
| `tools.memory` / `skills` / `repos` / `browser` | true | tool groups |
| `tools.browserEvaluate` | false | allow running JavaScript in pages |
| `skills.communityCatalog` | false | also search ~9,000 community skills (bundled list from skills-mcp) |
| `skills.syncHours` | 24 | how often skill sources are checked for changes |
| `browser.idleMinutes` | 10 | stop the browser after this much idle time |
| `browser.maxSnapshotChars` | 15000 | longest page snapshot returned at once; the rest comes with `browser_snapshot` offset |
| `repos.waitSeconds` | 40 | how long `repo_search` waits before returning a job id |
| `updateCheck` | true | look for a newer AppForge at start |

Other environment variables: `GITHUB_TOKEN` / `GH_TOKEN` (GitHub access), `APPFORGE_HOME` (data folder),
`APPFORGE_LOG_LEVEL` (`debug`, `info`, ...), `APPFORGE_NO_UPDATE_CHECK=1`.

## Other MCP clients

`appforge register` prints the JSON to paste. It looks like this (with your paths):

```json
{
  "mcpServers": {
    "appforge": { "command": "C:\\Users\\you\\AppData\\Local\\AppForge\\node\\node.exe", "args": ["C:\\Users\\you\\AppData\\Local\\AppForge\\app\\dist\\server\\src\\cli.js", "serve"] }
  }
}
```

Cursor: `~/.cursor/mcp.json`; Windsurf: `~/.codeium/windsurf/mcp_config.json`; Gemini CLI: `~/.gemini/settings.json`;
Codex: `codex mcp add appforge -- <command> <args>`. VS Code and Claude Code are tested; the others use the
same standard but were not tested.

To make agents use the memory without being asked, add this to your project's `AGENTS.md` (or `CLAUDE.md`,
`.github/copilot-instructions.md`):

```markdown
Use the AppForge MCP tools: call memory_recall at the start of a task and memory_write for what was learned
at the end; search existing projects (repo_search) and skills (skill_search) before building something new.
```

## Safety and privacy

- Runs on your computer; nothing is sent anywhere except requests to GitHub, the Node.js / model / browser
  download sites, and the web pages you or your agent open.
- The browser listens on 127.0.0.1 only, with a random access key per run. Camofox's crash telemetry (on by
  default upstream) is switched off.
- Skills are installed as files only; nothing from a skill is run. Skills that download from untrusted places or
  read secrets need explicit confirmation (`acceptRisks`), and every install reports the skillmd lint score and
  security flags. Some Anthropic skills (docx, pdf, pptx, xlsx) are source-available, not open source: their
  licence is shown before you install them.
- Memory never leaves the machine. Do not store secrets in it; the tools tell agents the same.
- `browser_evaluate` (arbitrary JavaScript) is off unless you enable it; cookie import only reads a file you name.

## Develop

```
npm ci              # Node 22.16+ (the installer's private Node works: %LOCALAPPDATA%\AppForge\node)
npm run build       # TypeScript + the RepoRadar bundle
npm test            # unit tests (a few seconds)
npm run smoke       # starts the server over stdio and calls tools of every group against real services
node scripts/smoke.mjs memory skills    # only some groups
node scripts/eval-search.mjs --tag try  # repo_search quality on tests/search-gold.json (real GitHub, ~5 min)
```

Layout: [server/](server/) (hub), [memory/](memory/), [skill-sources/](skill-sources/),
[skill-browser/](skill-browser/), [RepoRadar/](RepoRadar/), [camofox-browser/](camofox-browser/),
[plugin/](plugin/) (agent skills + Claude/VS Code plugin), `scripts/`, `tests/`.
Working rules for contributors and agents: [AGENTS.md](AGENTS.md). No CI: tests run locally.

## Why a local MCP server (and not a hosted one)

A hosted, free, unlimited server is not possible on GitHub alone: GitHub Pages serves static files only and
Actions are not a hosting service. More importantly, the memory must stay on your computer, the browser needs a
real machine, and the ranking models need CPU. A local stdio MCP server is free and unlimited for everyone who
installs it, works with every MCP client, and the only quota is GitHub's own (5,000 requests an hour with a login).
Where a client has plugins (Claude Code, VS Code agent plugins), the workflow skills in [plugin/](plugin/) are
also published as a plugin: `/plugin marketplace add MateuszM02/AppForge`, then `/plugin install appforge@appforge`.

## Credits

AppForge builds on these MIT-licensed projects (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)):
[jo-inc/camofox-browser](https://github.com/jo-inc/camofox-browser),
[Panther114/RepoRadar](https://github.com/Panther114/RepoRadar),
[gengirish/skills-mcp](https://github.com/gengirish/skills-mcp),
[kitfunso/hippo-memory](https://github.com/kitfunso/hippo-memory), and
[@skillmds/core](https://github.com/skillmds/skillmd) for skill linting. Skills and plugins are indexed from
[anthropics/skills](https://github.com/anthropics/skills) and
[anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) at run time; none of
their content is stored in this repository.

AppForge is MIT-licensed ([LICENSE](LICENSE)).

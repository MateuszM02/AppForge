# skill-browser

Search, inspect and install agent skills and Claude plugins from the catalog that
[skill-sources](../skill-sources/) keeps.

Based on [skills-mcp](https://github.com/gengirish/skills-mcp) (MIT), vendored in [upstream/](upstream/): its
community catalog (`upstream/data/catalog.json`, ~9,000 skills from 11 GitHub repositories, off by default) and
its list of community sources (`upstream/sources.json`) are used as the opt-in extras. Searching, fetching and
installing were rewritten in [src/](src/) to work on the local SQLite catalog, to fetch files without using GitHub
API quota, to handle plugins, and to lint with [@skillmds/core](https://github.com/skillmds/skillmd) before
installing.

## Tools

| Tool | What it does |
|---|---|
| `skill_search` | full-text search over skills, plugins, commands, agents and MCP servers (`kind`, `source` filters) |
| `skill_get` | the full `SKILL.md` (or plugin README and components, or command/agent text), file list, licence, link |
| `skill_install` | install for a client (below) |
| `skill_lint` | lint a local skill: format problems, a 0-100 quality score, what it can do |
| `skills_sync` | refresh the sources now |
| `skill_sources` | list / add / enable / disable / remove sources (`community` = the bundled catalog) |

## Where `skill_install` puts things

| client | scope `user` | scope `project` |
|---|---|---|
| `vscode` (Copilot) | `~/.copilot/skills/<name>` | `.github/skills/<name>` |
| `claude` (Claude Code) | `~/.claude/skills/<name>` | `.claude/skills/<name>` |
| `cursor` | `~/.cursor/skills/<name>` | `.cursor/skills/<name>` |
| `gemini` | `~/.gemini/skills/<name>` | `.gemini/skills/<name>` |
| `codex`, `generic` | `~/.agents/skills/<name>` | `.agents/skills/<name>` |

- **Skills**: every file of the skill folder is copied (binary-safe) from the exact commit; nothing is run.
  The result shows the skillmd lint score and security flags. Skills that download from untrusted places or read
  secrets are not installed unless the call says `acceptRisks: true` (agents are told to ask you first).
- **Plugins**: for Claude Code you get the two commands to run (`/plugin marketplace add ...`,
  `/plugin install name@marketplace`); for other clients the plugin's skills are installed one by one and its
  commands, agents, hooks and MCP servers are listed. VS Code can also install a whole Claude-format plugin with
  *Chat: Install Plugin From Source*.
- **Commands / agents**: Claude Code → `.claude/commands` / `.claude/agents`; VS Code (project) →
  `.github/prompts/*.prompt.md` / `.github/agents/*.agent.md`.
- **MCP servers**: the configuration is returned with the exact `code --add-mcp` / `claude mcp add-json` command;
  AppForge does not change client settings on its own.

VS Code and Claude Code locations are tested; the others follow each tool's documented convention.

## Code

- [src/browser.ts](src/browser.ts): search, details, install targets, lint.
- [src/tools.ts](src/tools.ts): MCP tools.

# server

The AppForge hub: one stdio MCP server (`appforge serve`) that registers the tool groups of the other folders, plus
the `appforge` command.

| File | Role |
|---|---|
| [src/cli.ts](src/cli.ts) | `appforge` command: `serve`, `doctor`, `register`, `setup`, `memory`, `skills`, `config`, `update-check` |
| [src/mcp.ts](src/mcp.ts) | builds the MCP server: instructions for the model, tool groups by config, stdio transport, shutdown |
| [src/forge.ts](src/forge.ts) | `forge_plan`, `forge_status`, prompts `create-app` / `improve-app` / `find-app` |
| [src/context.ts](src/context.ts) | what a tool group gets: server, config, logger, current project (MCP roots), shutdown hooks; result helpers |
| [src/config.ts](src/config.ts) | defaults, `config.json`, `APPFORGE_<SECTION>_<KEY>` overrides |
| [src/github.ts](src/github.ts) | GitHub client: token discovery, ETag cache, raw files, `git ls-remote`, tarball file lists |
| [src/project.ts](src/project.ts) | which project a call is about (explicit, MCP roots, cwd) and its stable key |
| [src/clients.ts](src/clients.ts) | registration in VS Code (`mcp.json`) and Claude Code (`claude mcp add-json`) |
| [src/update-check.ts](src/update-check.ts) | newer version on GitHub / in the folder |
| [src/paths.ts](src/paths.ts), [src/log.ts](src/log.ts), [src/version.ts](src/version.ts) | data folder, stderr logging, version |

The instructions sent to the client on connect, the tool descriptions and the prompts are plain text that works
with any model; nothing is specific to one LLM.

Rules that keep stdio clean: logs go to stderr (and `logs/appforge.log` in the data folder), `console.log` is
redirected while serving, and the vendored engines' own output is routed to stderr.

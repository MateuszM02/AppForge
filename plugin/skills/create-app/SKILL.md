---
name: create-app
description: Plan and build a new app or tool with the AppForge MCP tools. Use when the user asks to create, build, make or prototype an application, website, CLI, library or bot, before writing any code.
license: MIT
---

# Create an app with AppForge

Needs the AppForge MCP server (tools named `memory_*`, `repo_*`, `skill_*`, `browser_*`, `forge_*`).
If those tools are missing, tell the user to install AppForge: https://github.com/MateuszM02/AppForge

1. `memory_recall` with the goal in a few words. Apply the user's preferences and avoid recorded pitfalls.
2. `repo_search` for the need. If a healthy, permissively licensed project already does most of it, propose
   extending or forking it instead of starting over. Check finalists with `repo_details` / `repo_compare`.
3. `skill_search` for the specialised parts (testing, documents, design, MCP servers, deployment, ...).
   Read with `skill_get`, install the useful ones with `skill_install` (ask before `acceptRisks`).
4. Read the current docs of every library you will use (`browser_open`, `repo_read_file`), at the version you use.
5. Agree on a short plan with the user: stack, files, how to run and test, how it installs (aim for one command).
   Ask open questions now, not halfway through.
6. Build in small steps; run the build, the tests and the app after each step.
7. `memory_write` what is worth keeping: preferences learned, decisions and why, pitfalls that cost time.

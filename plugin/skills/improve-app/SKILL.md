---
name: improve-app
description: Improve, extend, fix or modernise an existing app or repository with the AppForge MCP tools. Use when the user wants a feature, refactor, performance or UX improvement in the project that is open.
license: MIT
---

# Improve an app with AppForge

Needs the AppForge MCP server. If its tools are missing, point the user to https://github.com/MateuszM02/AppForge

1. `memory_recall` (scope all) for this project: past decisions, conventions, pitfalls.
2. Read the project: README, entry points, build/test commands. State what will change and how success is checked.
3. Before writing a new subsystem, `repo_search` for a library that already does it ("accessible date picker for
   React", "SQLite migrations for Node"); compare 2-3 with `repo_compare`; prefer maintained, permissive ones.
4. `skill_search` for a skill that covers the task (code review, testing, frontend design, ...).
5. Check the docs of what you add (`browser_open`), then change the code in small verified steps.
6. `memory_write` decisions (kind decision, scope project) and lessons (kind lesson or pitfall).

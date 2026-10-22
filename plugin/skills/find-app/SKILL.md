---
name: find-app
description: Find existing open-source apps, libraries or agent skills that do what the user needs, and compare them. Use when the user asks "is there a tool/library/app for ...", wants alternatives to a product, or wants to avoid reinventing something.
license: MIT
---

# Find an app with AppForge

Needs the AppForge MCP server. If its tools are missing, point the user to https://github.com/MateuszM02/AppForge

1. `memory_recall` for earlier searches and preferences (licences, languages, platforms).
2. `repo_search` with the need in plain words plus filters (language, licence, `pushedWithinDays`).
   It takes about a minute; poll `repo_search_result` if it returns an id.
3. Look closer at the best 2-4: `repo_details`, `repo_compare`, README via `repo_read_file`, docs or demo via `browser_open`.
4. For agent capabilities, also `skill_search` (skills, plugins, MCP servers).
5. Answer with a short ranked list: what each does, licence, activity, risks, and your recommendation with reasons.
   Do not clone or install anything without asking.
6. `memory_write` the user's choice and why (kind decision).

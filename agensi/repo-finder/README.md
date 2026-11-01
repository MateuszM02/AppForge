# AppForge Repo Finder

Three skills that help an AI agent find, check and reuse existing open-source projects instead of rebuilding them.
A light version of [AppForge](https://github.com/MateuszM02/AppForge)'s `repo_search`: no install, no models, no
server, just two Python scripts that use the GitHub CLI, while the agent itself judges the candidates.

| Skill | What it does |
|---|---|
| `find-repo` | Turns a plain-language need into 6-15 GitHub searches (specific words, "X to Y" phrases, GitHub topics), plus a second round on the topics the best matches share, and prints about 300 candidates for the agent to judge |
| `check-repo` | Health and risk evidence for up to five repositories: activity, releases, maintainers, issue backlog, licence |
| `reuse-before-build` | The workflow: name the generic parts, search, compare, then depend, fork, borrow or build |

**Needs:** Python 3.8+ and the [GitHub CLI](https://cli.github.com), logged in (`gh auth login`). The scripts call only
`api.github.com`, through `gh`; they read no environment variables or files and write nothing.

**How good is it?** On AppForge's 50-need test set (2026-11-01), `search.py` fetched 81% of the must-have projects,
and its 300 lines held 76% of them (93% of those fetched; 50% in the top 60, hence 300 lines). A search took 18 s on
average (30 s at most) and its list was about 12k tokens. Most misses are famous projects whose own words differ from
the need, which the agent adds from its own knowledge. AppForge itself adds local embedding and reranking models
(0.2-2.6 GB) for agents that cannot read 300 lines.

MIT licence, by MateuszM02.

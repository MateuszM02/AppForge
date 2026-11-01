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

**How good is it?** On AppForge's 50-need test set (2026-11-01), a search takes about 25 s and prints 300 candidates
in about 4k tokens: 60 full lines, then 240 names and stars. Plain-Python filtering (no models) drops lists,
tutorials and courses and ranks by word match, words the best matches share, and how high each repo came in the
6-15 GitHub searches (reciprocal rank fusion); a last round then searches, by stars, the topics the 50 best share
far more often than the rest (`--no-refine` skips it, about 6 s faster). That holds 80% of the right projects (87%
of the must-haves) against 72% for the first version's 300 full lines (12k tokens); on 10 narrower needs the last
round lifts it from 70% to 82%. With Sonnet judging the list in a clean context (no tools, no memory), the 25
needs held out from tuning scored 0.85 nDCG@10 against 0.83 for the first version, and 0.88 against 0.81 for Sonnet
answering from memory alone (10 needs). On 10 narrower needs (tests/search-gold-niche.json in AppForge), Haiku with
this list scored 0.86 against 0.89 with 150 full lines and 150 names, within run-to-run noise (± 0.11), on 37% fewer
input tokens (9.6k against 15.2k). Most misses are famous
projects whose own words differ from the need, which the agent adds from its own knowledge. AppForge itself adds
local embedding and reranking models (0.2-2.6 GB) for agents that cannot read 300 lines.

MIT licence, by MateuszM02.

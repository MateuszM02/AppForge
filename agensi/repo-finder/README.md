# AppForge Repo Finder

## About this skill

Your agent is about to build something that already exists. Or it recommends a project from memory: an old name, an
abandoned repo, the wrong platform.

GitHub's own search matches words, not needs. Ask for "an app that converts PDF to Word" and you get Word-to-PDF tools,
image converters and 1-star experiments, while the best projects describe themselves in other words ("A black hole for
Internet advertisements" is Pi-hole). Asking the model instead gets you what it remembers: in our tests Sonnet's
memory alone gave stale repository names and wrong-platform picks.

Repo Finder gives your agent a real search: about 300 candidates gathered from 10-20 GitHub searches and ranked
without any model, in about 4k tokens. The agent picks the best 5-10 and tells you why each one fits.

## How the search works

Describe the need in plain words ("self-hosted alternative to Notion", "Go library to build a CLI"). The script then:

* **Searches many ways:** the specific words, "X to Y" phrases, `x2y` names and the GitHub topics named like the need,
  6-15 searches paged in parallel into a pool of about 1,500 repositories
* **Learns the domain's words:** a second round searches the topics the best matches share (Scrapy for "scrape",
  Logseq for "Notion")
* **Drops the noise:** curated lists, tutorials, courses, homework and dotfiles, unless you asked for them
* **Ranks without models:** word match (BM25), words the best matches share (pseudo-relevance feedback), how high each
  repo came across all searches (reciprocal rank fusion) and popularity
* **Refines once:** searches, by stars, the topics the 50 best repos carry far more often than the rest (bandwhich for
  "network bandwidth per process", which no word search returned)
* **Prints compactly:** 60 full lines (stars, language, licence, last push, description, topics), then 240 names and
  stars only, where famous projects with vague descriptions are recognised by name

## Two skills, one package

* `find-repo`: the search above, plus the judging rules: keep famous projects wherever they are in the list, drop
  look-alikes that go the wrong direction, leave X out of "alternative to X", add well-known projects GitHub missed,
  and say whether to depend on, fork, borrow from or build
* `check-repo`: health and risk evidence for up to five repositories in one GitHub call (commits in the last 90 days,
  latest release, contributors, issue backlog, licence and README start) with flags for the usual reasons to hesitate:
  archived, a fork, no or copyleft licence, no push for a year, one or two maintainers, more open issues than closed,
  no releases

Filters when you need them: `--language Go`, `--license MIT`, `--min-stars 50`, `--pushed-within 365`, `--small` for
little-known projects (no popularity bonus) and `--no-refine` for a faster search.

## Who it is for

* Developers who want to know what already exists before writing a library, CLI or app
* Anyone asking an agent for "an open-source alternative to X" or "a self-hosted tool for Y"
* Teams choosing between dependencies, who need maintenance and licence facts rather than impressions

## How it is built

Two Python scripts, standard library only, about 27 KB together. Each skill is one SKILL.md that loads only its own
script. Works with zero installs beyond Python 3.8+ and the [GitHub CLI](https://cli.github.com), logged in
(`gh auth login`). No models, no downloads, no server. The scripts call only `api.github.com` through `gh`, read no
environment variables or files and write nothing.

## Results

Measured on AppForge's 50 everyday needs and 10 narrower ones (2026-11-01). nDCG@10 scores the agent's top 10 against
the known right projects, from 0 to 1.

| | First version | Now |
|---|---|---|
| Right projects in the list, 50 needs | 72% | 80% (87% of the must-haves) |
| Right projects in the list, 10 narrower needs | not measured | 82% (70% with `--no-refine`) |
| List size | 12k tokens | about 4k tokens |
| Time per search | about 20 s | about 25 s |

With the first version's list, Sonnet's top 10 scored 0.88 nDCG@10 against 0.81 from its memory alone (10 needs, in
a clean context: no tools, no memory, no web). Haiku with the current list format scored 0.90 on five needs held out
from tuning.

## Known limitations

* **GitHub's search is still the source.** About one right project in five is never returned, often a famous one
  whose own words differ from the need (Vaultwarden for "password manager", czkawka for "duplicate photos"). The
  skill tells the agent to add those from its own knowledge and confirm them with `check-repo`.
* **The agent does the final judging.** A capable model reads 300 lines well; very small models may miss good
  candidates or keep look-alikes.
* **English needs work best.** Queries are built from the need's words, and most repositories describe themselves in
  English.
* **One GitHub account's limits apply.** A search makes 25-40 API calls, so dozens of searches an hour are fine;
  hundreds in a row may hit GitHub's rate limits.
* **The test set leans to well-known projects.** The right answers were chosen by the author and checked on GitHub;
  numbers on very new or very obscure needs may differ.

## FAQ

**Does it need an API key, models or a download?**
No. It uses your existing GitHub CLI login, and the scripts total about 27 KB.

**Why does the agent read 300 candidates instead of 10?**
Word matching cannot tell a PDF-to-Word converter from a Word-to-PDF one, but the agent can. Showing 300 compact
lines keeps 80% of the right projects in view; the top 60 alone keep about 64%.

**Why not just ask the model?**
Its memory has old names, archived projects and nothing newer than its training. The list adds current names, stars
and last-push dates, and finds projects the model never saw.

**How do I make it faster?**
Pass `--no-refine` to skip the last round of searches: about 6 seconds faster, with fewer niche finds.

**Is anything sent outside GitHub?**
No. The only network calls are GitHub API requests through `gh`.

**What is AppForge?**
[AppForge](https://github.com/MateuszM02/AppForge) is the full local MCP server this skill comes from. Its
`repo_search` adds local embedding and reranking models (0.2-2.6 GB) for agents that cannot read 300 lines.

MIT licence, by MateuszM02.

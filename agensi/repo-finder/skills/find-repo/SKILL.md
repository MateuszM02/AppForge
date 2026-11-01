---
name: find-repo
description: Find existing open-source projects on GitHub that do what the user needs (apps, libraries, CLIs, self-hosted tools, "an alternative to X"). Use when the user asks whether a tool exists, wants options or alternatives, or is about to build something that may already exist.
summary: Searches GitHub many ways from a plain-language need, then you pick the best 5-10 of about 300 candidates.
version: 0.2.0
license: MIT
tags: [github, open-source, search, research]
keywords: [find repository, open source alternative, library search, self-hosted, github search]
use_cases:
  - "Is there an open-source app that converts PDF to Word?"
  - "Find me a self-hosted alternative to Notion"
  - "Which Go library should I use to build a CLI?"
docs_url: https://github.com/MateuszM02/AppForge
---

# Find an existing project

Needs Python 3 and the GitHub CLI, logged in (`gh auth status`; if it fails, ask the user to run `gh auth login`).
Only GitHub's API is contacted.

## 1. Search

Put the need in plain words: what the project should do, not how it is built. Keep the user's own key words. Add
filters only when the user gave them.

```
python scripts/search.py "<need>" [--language Go] [--license MIT] [--min-stars 50] [--pushed-within 365] [--small]
```

`--small` is for "little-known" or "small" projects (no popularity bonus). It takes about 20 seconds and prints 300
candidates: 150 full lines (`rank. owner/name | stars | language | licence | last push | description | topics`), then
150 more as names and stars only. Lists, tutorials and courses are already left out. Do not show this list to the user.

## 2. Judge every line

The list is ordered by word match and popularity, not by fit, and the right projects are often far down: read all of
it, including the names-only part, where well-known projects with vague descriptions often are. Judge each candidate
by what it does (description, topics, your own knowledge of the project):

- Famous projects often describe themselves vaguely ("A black hole for Internet advertisements" is Pi-hole, a
  network-wide ad blocker). Keep a project you know fits, wherever it is in the list.
- GitHub's word search misses about one right project in five, often the best-known one (Vaultwarden, Chart.js,
  Ollama, Polars, nvm). Add well-known projects you are sure fit even when they are not listed, and check that
  they exist and are maintained with the check-repo skill.
- Drop look-alikes that do something else: the wrong direction (images to PDF when the user wants PDF to text),
  a plugin for another product, a library when the user wants an app or the other way round.
- Drop curated lists, tutorials, courses, examples and dotfiles unless the user asked for them.
- For "alternative to X", leave X itself out.
- Prefer projects pushed in the last year; mention archived or stale ones only when nothing else fits.

## 3. Search again if few fit

If fewer than about five candidates clearly fit, search once or twice more with the words such projects use about
themselves (for "keeps track of the best LLMs", try "LLM benchmark leaderboard" or "model evaluation"), with a
`--language` filter, or with a narrower need. Merge what you find.

## 4. Answer

Give the best 5-10, best first, each with: `owner/name` (link `https://github.com/owner/name`), stars, last push, one
line on why it fits, and a caveat if there is one (licence, inactive, platform). Group apps and libraries if both
appear. Then offer to check 2-3 of them in depth with the check-repo skill.

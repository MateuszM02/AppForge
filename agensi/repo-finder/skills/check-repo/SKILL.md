---
name: check-repo
description: Check the health and risks of 1-5 GitHub repositories before the user depends on one (activity, releases, maintainers, issue backlog, licence) and compare them. Use when the user is choosing between projects or asks whether a repository is maintained or safe to use.
summary: Activity, releases, community and licence evidence for up to five repositories, with risk flags and a comparison.
version: 0.1.0
license: MIT
tags: [github, open-source, due-diligence, licensing]
keywords: [repository health, is it maintained, compare libraries, open source risk, license check]
use_cases:
  - "Is pdfplumber still maintained?"
  - "Compare Prisma, Drizzle and TypeORM"
  - "Which of these three should I use?"
docs_url: https://github.com/MateuszM02/AppForge
---

# Check repositories before depending on them

Needs Python 3 and the GitHub CLI, logged in (`gh auth status`; if it fails, ask the user to run `gh auth login`).

```
python scripts/health.py owner/name [owner/name ...] [--readme 1500]
```

Up to five repositories per run, in one GitHub call. For each it prints what the project is, activity (commits in the
last 90 days, last push, latest release), community (contributors, issues and pull requests, open against closed),
licence and topics, risk flags, and the start of the README (`--readme 0` leaves it out).

## Read the evidence

- **Flags** are the usual reasons to hesitate: archived, a fork, no standard licence, a copyleft licence (GPL, AGPL:
  shipping or linking it can oblige the user to share their code), no push for a year, one or two maintainers, more
  open issues than closed, no releases.
- A quiet but finished library (few commits, issues answered, recent release) is fine; a popular project with a
  growing backlog and no release for a year is a risk.
- Check the licence against the user's plan: permissive (MIT, Apache-2.0, BSD) for closed or commercial use.

## Answer

For two or more, give a short table (stars, last push, latest release, licence, flags) and a recommendation with the
reason in one or two sentences. For one, say whether it is safe to depend on and what to watch.

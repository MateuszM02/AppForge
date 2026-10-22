---
name: remember
description: Save or look up long-term memory with AppForge. Use when the user says "remember", "don't forget", "as I said before", states a preference, or when a task ends and something learned should be kept for next time.
license: MIT
---

# Remember with AppForge

- Look up: `memory_recall` with a few words; `memory_read` for a full entry.
- Save: `memory_write` with one idea per memory, a one-line title and a short body.
  - kind: preference (how the user likes things), lesson, decision (with the reason), fact, pattern, pitfall.
  - scope: global for preferences and general lessons; project for decisions and facts about this project.
  - Never store passwords, tokens or keys.
- Fix: `memory_update`; drop: `memory_forget`; judge a recalled memory: `memory_feedback`.
- The user sets the size limit; check usage with `memory_stats`.

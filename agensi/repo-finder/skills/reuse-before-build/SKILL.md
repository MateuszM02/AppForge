---
name: reuse-before-build
description: Before writing a new app, feature, library or subsystem, check whether an existing open-source project already does it and decide whether to use it as a dependency, fork it, borrow from it or build from scratch. Use when the user asks to build, create or implement something non-trivial.
summary: A short decision workflow, search, compare, decide, that avoids rebuilding what already exists.
version: 0.1.0
license: MIT
tags: [planning, open-source, architecture]
keywords: [build vs buy, reuse open source, dependency choice, fork or build]
use_cases:
  - "Build me a markdown note-taking app with sync"
  - "Add PDF to text conversion to my service"
  - "I want to write my own job queue"
docs_url: https://github.com/MateuszM02/AppForge
---

# Reuse before you build

Rebuilding what a maintained project already does costs time and bugs. Before writing a non-trivial part:

1. **Name the part.** Split the request into the pieces that are generic (PDF parsing, auth, a job queue, a rich text
   editor) and the pieces only this user has (their data, workflow, UI). Only generic pieces are worth searching for.
2. **Search.** For each generic piece, use the find-repo skill with the piece in plain words ("PDF to text library
   for Python", "self-hosted job queue for Node").
3. **Compare 2-3.** Use the check-repo skill on the best candidates: maintenance, licence, maintainers.
4. **Decide, and say why:**
   - **Depend on it** when it fits, is maintained and its licence suits the user's plan. Most cases.
   - **Fork it** only when it is close, small, and its maintainers will not take the needed change; the user then
     maintains the fork.
   - **Borrow the idea** (read its code, reimplement the part) when it is too big or the licence does not fit.
   - **Build it** when nothing fits, the part is the user's core value, or the dependencies would cost more than the
     code.
5. **Tell the user** what you found and chose before writing code, with the links, so they can redirect you.

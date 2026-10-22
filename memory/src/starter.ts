// The starter pack: a few general guidelines a fresh memory starts with. They are tagged "starter" and start weak,
// so they fade away unless they turn out useful. `appforge memory reset --empty` removes them.

import type { MemoryKind } from './memory.js';

export const STARTER: Array<{ kind: MemoryKind; title: string; body: string; tags: string[] }> = [
  {
    kind: 'pattern',
    title: 'Check memory before starting a task',
    body: 'Call memory_recall with the task in a few words before planning. Past lessons, user preferences and earlier decisions about this project save rework.',
    tags: ['workflow'],
  },
  {
    kind: 'pattern',
    title: 'Look for an existing project before building from scratch',
    body: 'Before creating an app or library, run repo_search for the need. Forking or extending a healthy, permissively licensed project is usually faster than starting over; building new is right when nothing fits.',
    tags: ['workflow', 'repos'],
  },
  {
    kind: 'pattern',
    title: 'Look for a skill before doing a specialised job',
    body: 'Before a specialised task (documents, testing, MCP servers, front-end design, ...) run skill_search; a ready skill carries tested instructions and scripts.',
    tags: ['workflow', 'skills'],
  },
  {
    kind: 'lesson',
    title: 'Prefer maintained, permissively licensed dependencies',
    body: 'Check last commit date, open issues, release cadence and licence (MIT, Apache-2.0, BSD) before adding a dependency. repo_details shows these.',
    tags: ['dependencies'],
  },
  {
    kind: 'lesson',
    title: 'Verify before saying a change is done',
    body: 'Run the build and the relevant tests, and run the app or command the change affects. Report what was verified and what was not.',
    tags: ['quality'],
  },
  {
    kind: 'lesson',
    title: 'Read the current docs instead of guessing an API',
    body: 'Libraries change. Open the official docs or the repo README (browser_open, repo_read_file) for the exact version in use before writing code against it.',
    tags: ['quality', 'docs'],
  },
  {
    kind: 'pitfall',
    title: 'Windows paths and quoting',
    body: 'Quote paths with spaces; PowerShell and cmd quote differently from bash. Prefer forward slashes in Node and Python code, and never hard-code C:\\Users\\<name>.',
    tags: ['windows'],
  },
  {
    kind: 'pitfall',
    title: 'Never commit secrets',
    body: 'Keep API keys and tokens in environment variables or an ignored .env file. Check git diff for keys before committing.',
    tags: ['security'],
  },
  {
    kind: 'pattern',
    title: 'Keep changes small and reviewable',
    body: 'One logical change per commit, with a message that says what changed and why. Large rewrites hide bugs.',
    tags: ['git'],
  },
  {
    kind: 'pattern',
    title: 'Write down what was learned',
    body: 'At the end of a task, save with memory_write: preferences the user stated, decisions and why, and pitfalls that cost time. Short, specific entries recall best.',
    tags: ['workflow'],
  },
  {
    kind: 'pattern',
    title: 'Ask early, not mid-way',
    body: 'Resolve unclear requirements before a long task starts; collect questions that come up later and ask them together at the end.',
    tags: ['workflow'],
  },
  {
    kind: 'pattern',
    title: 'Make install and run one command',
    body: 'Apps people use should install with one command or download, and the README should start with that command and how to run it.',
    tags: ['distribution'],
  },
];

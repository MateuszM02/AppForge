// FORMAT.md, written into the memory folder so any LLM or person can use the memory without AppForge.

export const FORMAT_MD = `# AppForge memory: file format

This folder is the long-term memory AppForge keeps for AI coding agents. It is plain text on purpose: any model
or person can read it. Agents normally use it through AppForge's MCP tools (memory_recall, memory_write, ...),
but nothing here needs them.

## Where things are

- \`INDEX.md\`: one line per active memory: [kind] title | id | strength | file. Start here.
- \`global/\`: memories that apply to every project (user preferences, general lessons).
- \`projects/<key>/\`: memories about one project; \`PROJECT.json\` there names it (folder, git remote).
- Inside each store: \`buffer/\`, \`episodic/\` and \`semantic/\` hold one Markdown file per memory; \`hippo.db\` is a
  SQLite search index built from them (the engine is hippo-memory).
- \`archive/<yyyy-mm>.md\`: memories removed because the size limit was reached. Not searched.

## One memory file

YAML front matter, then the text. The first line of the text is the title, the rest is the body.

- \`tags\`: the first tag is the kind: preference, lesson, decision, fact, pattern or pitfall. "starter" marks the
  general guidelines a fresh memory starts with.
- \`strength\` (0-1): falls when a memory is not used (half-life \`half_life_days\`), rises when it is recalled or marked
  helpful, drops when marked wrong. Weak memories leave first when the limit is reached.
- \`pinned: true\`: never removed by the limit.
- \`retrieval_count\`, \`last_retrieved\`, \`outcome_positive\` / \`outcome_negative\`: how often it was used and judged.

## Kinds

- preference: how the user wants things done ("answers in Polish", "TypeScript over JavaScript").
- lesson: something learned that saves time next time.
- decision: a choice made for a project and why.
- fact: a stable fact about a project or environment (ports, paths, accounts in use; never secrets).
- pattern: a way of working that worked.
- pitfall: a mistake to avoid.

## Rules

- Keep each memory short and specific; one idea per memory.
- Never store secrets (passwords, tokens, keys).
- The limit (entries and MB of text) is set by the user: \`appforge config set memory.maxEntries 500\`.
`;

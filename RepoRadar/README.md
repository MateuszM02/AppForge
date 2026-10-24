# RepoRadar (in AppForge)

Find GitHub repositories by what they do, not by their name, and look inside any repository without cloning it.

[RepoRadar](https://github.com/Panther114/RepoRadar) (MIT) is vendored unchanged in [upstream/](upstream/). It is a
Next.js app built around an LLM in the cloud that writes the GitHub queries; without one its keyword heuristic
searched for "app converts pdf" when asked for a PDF-to-text app. AppForge keeps no cloud LLM, so it has its own
pipeline ([headless/pipeline.ts](headless/pipeline.ts)) that reuses upstream's modules for the rest:

1. **Fetch** ([headless/fetch.ts](headless/fetch.ts)): LLM-free queries (stoplist, synonyms such as txt→text and
   word→docx, "X to Y" phrases), GitHub topics close to the need, and paged GraphQL search: 500-2,000 candidates.
2. **Embed** ([headless/rank.ts](headless/rank.ts)): a small embedding model drops repos below a fixed similarity and
   keeps the K most promising, a third of them the most-starred, so established projects are not crowded out.
3. **Rerank**: a cross-encoder reads the need with each of the K and keeps the 15 best (blended with popularity).
4. **Pick**: upstream's evidence (releases, issues, contributors) and health score, then upstream's listwise prompt
   on a local LLM ([headless/openai-local.ts](headless/openai-local.ts), node-llama-cpp) that orders the 15 and drops
   off-topic ones. Nothing is sent anywhere; without the model, results stay in cross-encoder order.

The bundler ([../scripts/build-reporadar.mjs](../scripts/build-reporadar.mjs)) rewrites imports so upstream stays
untouched: `@prisma/client` → [headless/prisma-shim.ts](headless/prisma-shim.ts) (SQLite), `openai` → the local
LLM, upstream log lines → stderr.

## Model profiles

`appforge setup models [small|balanced|best]` (also asked by the installer, Enter = best) picks the three models:

| Profile | Download | Embedding | Cross-encoder | LLM | Pool / K |
|---|---|---|---|---|---|
| small | 1.9 GB | all-MiniLM-L6-v2 | Qwen3-Reranker-0.6B | Qwen3.5-2B | 500 / 150 |
| balanced | 3.5 GB | granite-embedding-small-english-r2 | Qwen3-Reranker-0.6B | Qwen3.5-4B | 1,000 / 150 |
| best | 5.3 GB | granite-embedding-small-english-r2 | Qwen3-Reranker-4B | Qwen3.5-4B | 2,000 / 150 |

Chosen with `node scripts/eval-search.mjs` (tests/search-gold.json) and fixed candidate pools of its 10 prompts:

- Embedding: IBM's 47M granite-embedding-small-english-r2 keeps 97% of the fetched answers in the 150-repo shortlist
  against MiniLM's 93%, and far more evenly (worst prompt 0.83 vs 0.67) for about 4 s more per search. bge-small/base,
  arctic-embed-s and gte-modernbert were no better; the 0.5-0.7B embedders (Qwen3-Embedding, Harrier, EmbeddingGemma 2,
  Nomic v2) were not kept, as they embed all 2,000 candidates per search at several times the cost.
- Reranker: Qwen3-Reranker raises the best reachable nDCG@10 of its top 10 from 0.55 (mxbai-rerank-base-v1) to 0.61
  (0.6B, +1 s per search) and 0.67 (4B, +15 s); it needs a strong popularity weight in the blend.
- Pool: 500 candidates already hold 96% of the must-have answers; more mostly adds alternatives.
- LLM: Qwen3.5 2B/4B; on the same 10 finalists Claude Haiku and Sonnet ranked only 0.04-0.06 better.

The LLM and the Qwen3 rerankers run on the GPU when there is one (Vulkan, CUDA or Metal), the embedders on DirectML or
CUDA when available, else everything runs on the CPU.

## Tools

| Tool | What it does | GitHub login |
|---|---|---|
| `repo_search` | plain-language need → ranked shortlist with fit, health, risks and how it was found. 1-3 minutes; returns a job id if it takes longer than `repos.waitSeconds` | required |
| `repo_search_result` | results of a search that was still running | required |
| `repo_details` | one repository: metadata, activity, releases, issues/PRs, contributors, manifests, docs signals, README excerpt, health and risk assessment | full with login; basic facts without |
| `repo_compare` | 2-6 repositories side by side | full with login; basic without |
| `repo_tree` | files and folders of a repository (or a folder of it) | no |
| `repo_read_file` | text of one file, in parts for long files | no |

One search makes about 20-40 GitHub GraphQL calls, which need a login (`gh auth login`, or `GITHUB_TOKEN`).
`repo_tree` and `repo_read_file` use `git ls-remote`, raw.githubusercontent.com and cached file lists.

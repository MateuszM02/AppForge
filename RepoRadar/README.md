# RepoRadar (in AppForge)

Find GitHub repositories by what they do, not by their name, and look inside any repository without cloning it.

[RepoRadar](https://github.com/Panther114/RepoRadar) (MIT) is vendored unchanged in [upstream/](upstream/). It is a
Next.js app built around an LLM in the cloud that writes the GitHub queries; without one its keyword heuristic
searched for "app converts pdf" when asked for a PDF-to-text app. AppForge keeps no cloud LLM, so it has its own
pipeline ([headless/pipeline.ts](headless/pipeline.ts)) that reuses upstream's modules for the rest:

1. **Fetch** ([headless/fetch.ts](headless/fetch.ts), [headless/search.ts](headless/search.ts)): LLM-free queries
   (stoplist, synonyms such as txt→text and scrape→scraping, "X to Y" phrases, a named language as a `language:`
   qualifier; kinds of project such as "library" never make a query alone), GitHub topics close to the need, and paged
   GraphQL search: 500-2,000 candidates. A second round searches the 5 topics most shared by the 30 best matches so far
   (by embedding), which finds projects described in other words (scrapy for "scrape", logseq for "Notion").
2. **Embed** ([headless/rank.ts](headless/rank.ts)): a small embedding model drops repos below a fixed similarity and
   keeps the K most promising, a third of them the most-starred, so established projects are not crowded out.
3. **Rerank**: a cross-encoder reads the need with each of the K and drops what it rates below 0.01, so a famous
   but unrelated repo never shows; the 10 best by 0.15 × its score + 0.5 × popularity (log stars) + credibility and
   recency are the results.
4. **Evidence**: upstream's releases, issues, contributors and health score for the 10. Nothing is sent anywhere.

The bundler ([../scripts/build-reporadar.mjs](../scripts/build-reporadar.mjs)) rewrites imports so upstream stays
untouched: `@prisma/client` → [headless/prisma-shim.ts](headless/prisma-shim.ts) (SQLite), `openai` → a stub
that throws (no LLM calls), upstream log lines → stderr.

## Model profiles

`appforge setup models [small|balanced|best]` (also asked by the installer, Enter = best) picks the models.
RAM is the free memory a profile needs; GPU memory holds all its models and their fixed context windows on the GPU
(less works, the layers that do not fit run on the CPU; no GPU works too, slower):

| Profile | Download | RAM / GPU memory | Embedding | Cross-encoder | Pool / K | nDCG@10* |
|---|---|---|---|---|---|---|
| small | 0.7 GB | 4 / 2 GB | all-MiniLM-L6-v2 | Qwen3-Reranker-0.6B | 500 / 150 | 0.60 |
| balanced | 0.7 GB | 4 / 2 GB | granite-embedding-small-english-r2 | Qwen3-Reranker-0.6B | 1,000 / 150 | 0.61 |
| best | 2.6 GB | 6 / 4 GB | granite-embedding-small-english-r2 | Qwen3-Reranker-4B | 2,000 / 150 | 0.68 |

* on the 20 prompts of tests/search-gold.json (apps, self-hosted tools, "alternative to X", libraries in several
languages, CLIs, ML, devops): worst prompt 0.17 / 0.00 / 0.00, standard deviation 0.21. On the first 10 of them,
AppForge 0.1 scored 0.27 end to end, and its models (MiniLM + ms-marco-MiniLM-L-6) 0.37 with this fetch.

Chosen with `node scripts/eval-search.mjs` (tests/search-gold.json) and fixed candidate pools of its first 10 prompts:

- Embedding: IBM's 47M granite-embedding-small-english-r2 keeps 97% of the fetched answers in the 150-repo shortlist
  against MiniLM's 93%, and far more evenly (worst prompt 0.83 vs 0.67) for about 4 s more per search. bge-small/base,
  arctic-embed-s and gte-modernbert were no better; the 0.5-0.7B embedders (Qwen3-Embedding, Harrier, EmbeddingGemma 2,
  Nomic v2) were not kept, as they embed all 2,000 candidates per search at several times the cost.
- Reranker: Qwen3-Reranker raises the best reachable nDCG@10 of its top 10 from 0.55 (mxbai-rerank-base-v1) to 0.61
  (0.6B, +1 s per search) and 0.67 (4B, +15 s); it needs a strong popularity weight in the blend.
- Pool: 500 candidates already hold 96% of the must-have answers; more mostly adds alternatives.
- Floor: the embedding cannot tell junk from answers (Granite rates every shortlisted repo 0.75-0.87, and they
  overlap), the reranker can: below 0.01 sat about 800 shortlisted repos and no expected one.
- LLM: none. Ordering the top 10, Qwen3.5-2B and -4B scored lower than the blend (0.48 and 0.57 against
  0.52 and 0.60); as a filter they changed it by at most 0.01 for 22-34 s per search. Claude Haiku and Sonnet ordered
  earlier finalists only 0.04-0.06 better than Qwen3.5-4B.

The Qwen3 rerankers run on the GPU when there is one (Vulkan, CUDA or Metal), the embedders on DirectML or
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

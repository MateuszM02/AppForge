// The local AI models of repo_search and the three install profiles that pick them together. Sizes are the
// downloads; quality and timings were measured with scripts/eval-search.mjs on the reference machine, and
// estimateSeconds() scales them to this one with a quick speed probe.

import os from 'node:os';

export interface EncoderModel {
  /** Hugging Face id with ONNX weights (the int8 file is used). */
  id: string;
  kind: 'embed' | 'rerank';
  mb: number;
  pooling?: 'mean' | 'cls';
  /** Cross-encoders: whether the start of the README helps (it does for ms-marco, it hurts mxbai). */
  readme?: boolean;
  /** Rerankers run by node-llama-cpp (GPU when available): download URI and file name in models/rerank. */
  gguf?: { uri: string; file: string };
}

export const ENCODERS: Record<string, EncoderModel> = {
  // Embedding: share of the fetched expected repos that reach the 150-repo shortlist, on fixed pools of the 10 test
  // prompts: MiniLM 0.93 (worst prompt 0.67, stdev 0.12), granite-small 0.97 (worst 0.83, stdev 0.05) at about 4 s
  // more per search. bge-small/base, arctic-embed-s and gte-modernbert were no better; the 0.5-0.7B embedders
  // (Qwen3-Embedding, Harrier, EmbeddingGemma 2, Nomic v2) were not kept: they embed all 2,000 candidates per search.
  minilm: { id: 'Xenova/all-MiniLM-L6-v2', kind: 'embed', mb: 23, pooling: 'mean' },
  'granite-small': { id: 'onnx-community/granite-embedding-small-english-r2-ONNX', kind: 'embed', mb: 97, pooling: 'cls' },
  // Rerankers: on the same pools and shortlist, no LLM, the best ordering of each one's top 10 scored nDCG 0.49
  // (ms-marco-L6), 0.55 (mxbai-rerank-base-v1), 0.61 (Qwen3 0.6B, +1 s per search) and 0.67 (Qwen3 4B, +15 s).
  // ms-marco (the reranker of AppForge 0.1) stays listed so `appforge setup models` can remove its files.
  'msmarco-l6': { id: 'Xenova/ms-marco-MiniLM-L-6-v2', kind: 'rerank', mb: 23, readme: true },
  'qwen3-rerank-0.6b': { id: 'Qwen3-Reranker-0.6B', kind: 'rerank', mb: 639, readme: false, gguf: { uri: 'hf:giladgd/Qwen3-Reranker-0.6B-GGUF/Qwen3-Reranker-0.6B.Q8_0.gguf', file: 'Qwen3-Reranker-0.6B.Q8_0.gguf' } },
  'qwen3-rerank-4b': { id: 'Qwen3-Reranker-4B', kind: 'rerank', mb: 2497, readme: false, gguf: { uri: 'hf:giladgd/Qwen3-Reranker-4B-GGUF/Qwen3-Reranker-4B.Q4_K_M.gguf', file: 'Qwen3-Reranker-4B.Q4_K_M.gguf' } },
};

/** Local LLMs for the final pick, Q4_K_M GGUF, stored in models/llm under their file name. Also tried (labelled listwise
 * request, Radeon RX 6800): granite-4.0-h-tiny and granite-4.0-h-micro kept traps; Ministral-3-3B was right and quick on a
 * short request but in real searches (longer README excerpts) took 55 s per pick against Qwen3.5-4B's 41 s and ranked
 * worse; MiniCPM5-2B (Sept 2026) likewise: 5.7 s on the short request, but 25-33 s per pick in real searches against
 * Qwen3.5-2B's 13-16 s, at the same nDCG (its template's thought block also eats the answer's first characters); Qwen3-1.7B
 * read the prompt at half Qwen3.5's speed. */
export interface LlmModel {
  uri: string;
  file: string;
  mb: number;
}

export const LLMS: Record<string, LlmModel> = {
  'qwen3.5-2b': { uri: 'hf:unsloth/Qwen3.5-2B-GGUF/Qwen3.5-2B-Q4_K_M.gguf', file: 'Qwen3.5-2B-Q4_K_M.gguf', mb: 1281 },
  'qwen3.5-4b': { uri: 'hf:unsloth/Qwen3.5-4B-GGUF/Qwen3.5-4B-Q4_K_M.gguf', file: 'Qwen3.5-4B-Q4_K_M.gguf', mb: 2741 },
};

export type ProfileName = 'minimalist' | 'small' | 'balanced' | 'best';
export const PROFILE_NAMES: ProfileName[] = ['minimalist', 'small', 'balanced', 'best'];

/** Seconds per search on the reference machine, split by what they depend on: GitHub, the encoders (CPU), the LLM. */
export interface Timings {
  github: number;
  encoders: number;
  llmGpu: number;
  llmCpu: number;
}

/** What a profile needs: free RAM to run on the CPU alone, and the video memory that holds all its models and their
 * (fixed) context windows at once, so that each runs on the GPU. Less video memory still works: node-llama-cpp keeps
 * the layers that do not fit on the CPU, and the search gets slower. Estimated from the files and context sizes; the
 * best profile peaked at 6.9 GB of RAM (model files mapped into memory included) on the reference machine. */
export interface Hardware {
  ramGB: number;
  vramGB: number;
}

export interface Profile {
  embed: string;
  rerank: string;
  /** null: no LLM pick, the results stay in the cross-encoder's order. */
  llm: string | null;
  /** Candidates fetched (about 500 already hold almost every must-have answer of the test set) and how many of them
   * the cross-encoder reads: 150 ranked as well as 300 on the test set, in half the time. */
  poolSize: number;
  rerankPool: number;
  /** nDCG@10 on the 10 prompts of tests/search-gold.json (null: not yet measured with these models), and the seconds per
   * search, built from measured parts: GitHub, encoders (embedding + reranker), LLM pick with 10 finalists. */
  quality: number | null;
  timings: Timings | null;
  hardware: Hardware;
}

export const PROFILES: Record<ProfileName, Profile> = {
  minimalist: { embed: 'minilm', rerank: 'qwen3-rerank-0.6b', llm: null, poolSize: 500, rerankPool: 150, quality: null, timings: { github: 13, encoders: 10.5, llmGpu: 0, llmCpu: 0 }, hardware: { ramGB: 4, vramGB: 2 } },
  small: { embed: 'minilm', rerank: 'qwen3-rerank-0.6b', llm: 'qwen3.5-2b', poolSize: 500, rerankPool: 150, quality: null, timings: { github: 13, encoders: 10.5, llmGpu: 17, llmCpu: 61 }, hardware: { ramGB: 6, vramGB: 4 } },
  balanced: { embed: 'granite-small', rerank: 'qwen3-rerank-0.6b', llm: 'qwen3.5-4b', poolSize: 1000, rerankPool: 150, quality: null, timings: { github: 19, encoders: 14.5, llmGpu: 25, llmCpu: 260 }, hardware: { ramGB: 8, vramGB: 6 } },
  best: { embed: 'granite-small', rerank: 'qwen3-rerank-4b', llm: 'qwen3.5-4b', poolSize: 2000, rerankPool: 150, quality: 0.49, timings: { github: 20, encoders: 29, llmGpu: 25, llmCpu: 260 }, hardware: { ramGB: 12, vramGB: 8 } },
};

export const isProfile = (name: string): name is ProfileName => (PROFILE_NAMES as string[]).includes(name);

/** The models and sizes of the configured profile; non-empty settings win (a model key, a Hugging Face id, a GGUF). */
export function resolveModels(r: { modelProfile: string; embedModel: string; rerankModel: string; llmModel: string; poolSize: number; rerankPool: number }) {
  const profile: ProfileName = isProfile(r.modelProfile) ? r.modelProfile : 'best';
  const p = PROFILES[profile];
  const encoder = (key: string, kind: 'embed' | 'rerank'): EncoderModel => ENCODERS[key] ?? { id: key, kind, mb: 0, pooling: 'mean', readme: true };
  const llmKey = r.llmModel || p.llm;
  return {
    profile,
    embed: encoder(r.embedModel || p.embed, 'embed'),
    rerank: encoder(r.rerankModel || p.rerank, 'rerank'),
    llm: !llmKey ? null : (LLMS[llmKey] ?? { uri: llmKey, file: llmKey.split(/[\\/]/).pop()!, mb: 0 }),
    poolSize: r.poolSize > 0 ? r.poolSize : p.poolSize,
    rerankPool: r.rerankPool > 0 ? r.rerankPool : p.rerankPool,
  };
}

export const downloadMB = (name: ProfileName) => {
  const p = PROFILES[name];
  return ENCODERS[p.embed]!.mb + ENCODERS[p.rerank]!.mb + (p.llm ? LLMS[p.llm]!.mb : 0);
};

/** The reference machine of the timings, and its result on probeMs(). */
export const REFERENCE = { probeMs: 35, machine: 'Ryzen 9 5950X with a Radeon RX 6800 (Vulkan)' };

/** A fixed float workload, similar in kind to model inference; the best of three runs, in milliseconds. */
export function probeMs(): number {
  const n = 320;
  const a = new Float32Array(n * n).fill(0.5);
  const c = new Float32Array(n * n);
  let best = Infinity;
  for (let round = 0; round < 3; round++) {
    const t = performance.now();
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) c[i * n + j]! += a[i * n + k]! * a[k * n + j]!;
    best = Math.min(best, performance.now() - t);
  }
  return best + (c[0]! > 1e12 ? 1 : 0);
}

/** Estimated seconds per search here: GitHub time as measured, CPU-bound parts scaled by the probe, the LLM on a GPU
 * as measured on the reference GPU. */
export function estimateSeconds(name: ProfileName, here: { probeMs: number; gpu: boolean }): { low: number; high: number } | null {
  const t = PROFILES[name].timings;
  if (!t || !REFERENCE.probeMs) return null;
  const ratio = Math.max(0.25, here.probeMs / REFERENCE.probeMs);
  const est = t.github + t.encoders * ratio + (here.gpu ? t.llmGpu : t.llmCpu * ratio);
  return { low: Math.max(1, Math.round(est * 0.75)), high: Math.round(est * 1.5) };
}

export const cpuSummary = () => `${os.cpus()[0]?.model.trim() ?? 'CPU'} (${os.cpus().length} threads)`;

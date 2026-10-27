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
  // Under test (Oct 2026): 0.63 vs Qwen3-0.6B's 0.61 on 20 prompts with rerankWeight 1.0, 3.8 s per 150 repos on the CPU.
  'gte-rerank-modernbert': { id: 'Alibaba-NLP/gte-reranker-modernbert-base', kind: 'rerank', mb: 151, readme: false },
  'qwen3-rerank-4b': { id: 'Qwen3-Reranker-4B', kind: 'rerank', mb: 2497, readme: false, gguf: { uri: 'hf:giladgd/Qwen3-Reranker-4B-GGUF/Qwen3-Reranker-4B.Q4_K_M.gguf', file: 'Qwen3-Reranker-4B.Q4_K_M.gguf' } },
};

/** No local LLM: as the final pick, Qwen3.5-2B and -4B ordered the top 10 worse than the reranker and popularity blend
 * (0.48 and 0.57 against 0.52 and 0.60 on cached pools of the test set), and as a filter they changed it by at most 0.01
 * for 22-34 s per search. Also tried: granite-4.0-h-tiny/micro, Ministral-3-3B, MiniCPM5-2B, Qwen3-1.7B. AppForge 0.2
 * downloaded these into models/llm; `appforge setup models` removes that folder. */
export const LEGACY_LLM_DIR = 'llm';

export type ProfileName = 'small' | 'balanced' | 'best';
export const PROFILE_NAMES: ProfileName[] = ['small', 'balanced', 'best'];

/** Seconds per search on the reference machine: GitHub (fetch and evidence), and the encoders (embedding + reranker)
 * with a GPU and without one. The CPU-only encoder times of the Qwen3 rerankers are estimates, not measurements. */
export interface Timings {
  github: number;
  encGpu: number;
  encCpu: number;
}

/** What a profile needs: free RAM to run on the CPU alone, and the video memory that holds its models and their
 * (fixed) context windows at once, so that each runs on the GPU. Less video memory still works: node-llama-cpp keeps
 * the layers that do not fit on the CPU, and the search gets slower. Estimated from the files and context sizes. */
export interface Hardware {
  ramGB: number;
  vramGB: number;
}

export interface Profile {
  embed: string;
  rerank: string;
  /** Candidates fetched (about 500 already hold almost every must-have answer of the test set) and how many of them
   * the cross-encoder reads: the best top 10 drew on positions up to 140, so 150. */
  poolSize: number;
  rerankPool: number;
  /** nDCG@10 on the 20 prompts of tests/search-gold.json (scripts/eval-search.mjs, Oct 2026), and the seconds per search. */
  quality: number | null;
  timings: Timings | null;
  hardware: Hardware;
}

export const PROFILES: Record<ProfileName, Profile> = {
  small: { embed: 'minilm', rerank: 'qwen3-rerank-0.6b', poolSize: 500, rerankPool: 150, quality: 0.61, timings: { github: 22, encGpu: 5, encCpu: 25 }, hardware: { ramGB: 4, vramGB: 2 } },
  balanced: { embed: 'granite-small', rerank: 'qwen3-rerank-0.6b', poolSize: 1000, rerankPool: 150, quality: 0.61, timings: { github: 22, encGpu: 6, encCpu: 30 }, hardware: { ramGB: 4, vramGB: 2 } },
  best: { embed: 'granite-small', rerank: 'qwen3-rerank-4b', poolSize: 2000, rerankPool: 150, quality: 0.7, timings: { github: 25, encGpu: 17, encCpu: 110 }, hardware: { ramGB: 6, vramGB: 4 } },
};

export const isProfile = (name: string): name is ProfileName => (PROFILE_NAMES as string[]).includes(name);

/** The models and sizes of the configured profile; non-empty settings win (a model key or a Hugging Face id). */
export function resolveModels(r: { modelProfile: string; embedModel: string; rerankModel: string; poolSize: number; rerankPool: number }) {
  const profile: ProfileName = isProfile(r.modelProfile) ? r.modelProfile : 'best';
  const p = PROFILES[profile];
  const encoder = (key: string, kind: 'embed' | 'rerank'): EncoderModel => ENCODERS[key] ?? { id: key, kind, mb: 0, pooling: 'mean', readme: true };
  return {
    profile,
    embed: encoder(r.embedModel || p.embed, 'embed'),
    rerank: encoder(r.rerankModel || p.rerank, 'rerank'),
    poolSize: r.poolSize > 0 ? r.poolSize : p.poolSize,
    rerankPool: r.rerankPool > 0 ? r.rerankPool : p.rerankPool,
  };
}

export const downloadMB = (name: ProfileName) => ENCODERS[PROFILES[name].embed]!.mb + ENCODERS[PROFILES[name].rerank]!.mb;

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

/** Estimated seconds per search here: GitHub time as measured, the encoders as on the reference GPU, or without a GPU
 * scaled by the CPU probe. */
export function estimateSeconds(name: ProfileName, here: { probeMs: number; gpu: boolean }): { low: number; high: number } | null {
  const t = PROFILES[name].timings;
  if (!t || !REFERENCE.probeMs) return null;
  const ratio = Math.max(0.25, here.probeMs / REFERENCE.probeMs);
  const est = t.github + (here.gpu ? t.encGpu : t.encCpu * ratio);
  return { low: Math.max(1, Math.round(est * 0.75)), high: Math.round(est * 1.5) };
}

export const cpuSummary = () => `${os.cpus()[0]?.model.trim() ?? 'CPU'} (${os.cpus().length} threads)`;

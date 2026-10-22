import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

/**
 * Local, free sentence embeddings via Transformers.js.
 * Model: all-MiniLM-L6-v2 -> 384-dim vectors (matches the pgvector schema).
 * The model (~25-90 MB) is downloaded once on first use, then cached to disk.
 * No API key, runs on a laptop and on Railway.
 */
export const EMBEDDING_DIM = 384;
const MODEL = "Xenova/all-MiniLM-L6-v2";
const configuredBatchSize = Number.parseInt(process.env.EMBED_BATCH_SIZE ?? "", 10);
const BATCH_SIZE = Number.isFinite(configuredBatchSize)
  ? Math.min(Math.max(configuredBatchSize, 1), 200)
  : 8;

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= pipeline("feature-extraction", MODEL);
  return extractorPromise;
}

/** Embed a single string into a normalized 384-dim vector. */
export async function embed(text: string): Promise<number[]> {
  const extractor = await getExtractor();
  const output = await extractor(text.slice(0, 8000), {
    pooling: "mean",
    normalize: true,
  });
  return Array.from(output.data as Float32Array);
}

/**
 * Embed strings in small ONNX batches. Large batches make ONNX Runtime retain
 * multi-gigabyte native arenas after a search on Linux.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [await embed(texts[0])];

  const results: number[][] = [];
  const extractor = await getExtractor();
  for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
    const chunk = texts.slice(offset, offset + BATCH_SIZE).map((text) => text.slice(0, 8000));
    const output = await extractor(chunk, { pooling: "mean", normalize: true });
    const flat = output.data as Float32Array;
    for (let i = 0; i < chunk.length; i++) {
      results.push(Array.from(flat.subarray(i * EMBEDDING_DIM, (i + 1) * EMBEDDING_DIM)));
    }
  }
  return results;
}

/** Embed many strings sequentially — kept for callers that need one at a time. */
export async function embedMany(texts: string[]): Promise<number[][]> {
  return embedBatch(texts);
}

/** Cosine similarity for two equal-length vectors (already normalized -> dot). */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length && i < b.length; i++) dot += a[i] * b[i];
  return dot;
}

// The two local encoder models of repo_search: an embedding model (stage 2, cheap, every candidate) and a
// cross-encoder (stage 3, reads need + repo together, the shortlist only). Which models depends on the profile
// (server/src/models.ts); both download once into the models folder.

import { AutoModelForSequenceClassification, AutoTokenizer, env, pipeline } from '@huggingface/transformers';

export interface EncoderSpec {
  /** Hugging Face model id with ONNX weights, e.g. "Xenova/bge-small-en-v1.5". */
  id: string;
  /** ONNX weight variant: "q8" (int8, small and fast), "fp16", "fp32". */
  dtype?: 'q8' | 'fp16' | 'fp32';
  /** Embedding models only. */
  pooling?: 'mean' | 'cls';
  /** Cross-encoders: whether to read the start of each README too. */
  readme?: boolean;
}

type Extractor = (texts: string[], o: { pooling: 'mean' | 'cls'; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;

const extractors = new Map<string, Promise<{ model: Extractor; gpu: boolean }>>();
const crossEncoders = new Map<string, Promise<{ tok: any; model: any }>>();

// GPU through onnxruntime: DirectML on Windows, CUDA on Linux x64 (none on macOS). APPFORGE_ENCODER_DEVICE = cpu, gpu
// or auto (the default): the GPU only where it measured faster. Embedding 2,000 repos took 1.3 s on a Radeon RX 6800
// (batches of 128) against 2.0 s on 16 CPU cores; the cross-encoders have no fp16 build and score 150 repos in about
// 1.6 s on the CPU, so they stay there.
const GPU = process.platform === 'win32' ? 'dml' : process.platform === 'linux' && process.arch === 'x64' ? 'cuda' : null;

/** Loads on the GPU (fp16) when wanted and possible, else on the CPU (int8); a GPU that fails to load falls back. */
async function onDevice<T>(spec: EncoderSpec, gpuHelps: boolean, load: (o: { device: any; dtype: any }) => Promise<T>): Promise<{ model: T; gpu: boolean }> {
  const want = process.env.APPFORGE_ENCODER_DEVICE ?? 'auto';
  if (GPU && (want === 'gpu' || (want === 'auto' && gpuHelps))) {
    try {
      return { model: await load({ device: GPU, dtype: 'fp16' }), gpu: true };
    } catch (e) {
      process.stderr.write(`[encoders] ${spec.id} on ${GPU} failed (${e instanceof Error ? e.message : e}); using the CPU
`);
    }
  }
  return { model: await load({ device: 'cpu', dtype: spec.dtype ?? 'q8' }), gpu: false };
}

export function setModelsDir(dir: string): void {
  env.cacheDir = dir;
}

const GPU_HELPS = { embed: true, rerank: false };

function extractor(spec: EncoderSpec): Promise<{ model: Extractor; gpu: boolean }> {
  const key = `${spec.id}|${spec.dtype ?? 'q8'}`;
  let p = extractors.get(key);
  if (!p) {
    p = onDevice(spec, GPU_HELPS.embed, (o) => pipeline('feature-extraction', spec.id, o) as unknown as Promise<Extractor>);
    p.catch(() => extractors.delete(key));
    extractors.set(key, p);
  }
  return p;
}

/** Normalized embedding vectors (batches of 32 on the CPU, 128 on a GPU, the faster size on each). */
export async function embed(spec: EncoderSpec, texts: string[], batch?: number): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const { model: run, gpu } = await extractor(spec);
  const batchSize = batch ?? (gpu ? 128 : 32);
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const chunk = texts.slice(i, i + batchSize).map((t) => t.slice(0, 2000));
    const res = await run(chunk, { pooling: spec.pooling ?? 'mean', normalize: true });
    const dim = res.dims.at(-1)!;
    for (let k = 0; k < chunk.length; k++) out.push(res.data.slice(k * dim, (k + 1) * dim));
  }
  return out;
}

function crossEncoder(spec: EncoderSpec) {
  const key = `${spec.id}|${spec.dtype ?? 'q8'}`;
  let p = crossEncoders.get(key);
  if (!p) {
    p = (async () => ({
      tok: await AutoTokenizer.from_pretrained(spec.id),
      model: (await onDevice(spec, GPU_HELPS.rerank, (o) => AutoModelForSequenceClassification.from_pretrained(spec.id, o))).model,
    }))();
    p.catch(() => crossEncoders.delete(key));
    crossEncoders.set(key, p);
  }
  return p;
}

/** Relevance of each doc to the query in (0,1): the sigmoid of the cross-encoder's logit. */
export async function rerank(spec: EncoderSpec, query: string, docs: string[], batchSize = 8): Promise<number[]> {
  if (docs.length === 0) return [];
  const { tok, model } = await crossEncoder(spec);
  const out: number[] = [];
  for (let i = 0; i < docs.length; i += batchSize) {
    const chunk = docs.slice(i, i + batchSize);
    const inputs = tok(new Array(chunk.length).fill(query), { text_pair: chunk, padding: true, truncation: true, max_length: 512 });
    const { logits } = await model(inputs);
    for (const row of logits.tolist() as number[][]) out.push(1 / (1 + Math.exp(-(Array.isArray(row) ? row[0]! : (row as number)))));
  }
  return out;
}

/** Loads (and on first use downloads) a model without scoring anything. */
export async function warm(spec: EncoderSpec, kind: 'embed' | 'rerank'): Promise<void> {
  if (kind === 'embed') await embed(spec, ['warm up']);
  else await rerank(spec, 'warm up', ['warm up']);
}

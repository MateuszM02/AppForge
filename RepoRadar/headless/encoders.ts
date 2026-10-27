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
  /** Cross-encoders run by node-llama-cpp instead (Qwen3-Reranker): the GGUF file, on the GPU when there is one. */
  gguf?: string;
  /** A GGUF chat LLM trained to answer "Yes" for a relevant document (zerank): its score is that token's logit. */
  yes?: string;
}

type Extractor = (texts: string[], o: { pooling: 'mean' | 'cls'; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;

const extractors = new Map<string, Promise<{ model: Extractor; gpu: boolean }>>();
const crossEncoders = new Map<string, Promise<{ tok: any; model: any }>>();

// GPU through onnxruntime: DirectML on Windows, CUDA on Linux x64 (none on macOS). APPFORGE_ENCODER_DEVICE = cpu, gpu
// or auto (the default): the GPU only where it measured faster. Embedding 2,000 repos took 1.3 s on a Radeon RX 6800
// (batches of 128) against 2.0 s on 16 CPU cores; the cross-encoders have no fp16 build and score 150 repos in about
// 1.6 s on the CPU, so they stay there.
let GPU: string | null = process.platform === 'win32' ? 'dml' : process.platform === 'linux' && process.arch === 'x64' ? 'cuda' : null;

// Token limits. Each model is told how much text the task needs, never its own maximum (granite-embedding-r2 reads
// 8,192 tokens, Qwen3-Reranker 32k): a repo's text is its name, description (300 characters) and topics, about 100
// tokens in English but several hundred in CJK or emoji, and batch memory grows with the longest text in the batch.
const EMBED_TOKENS = 256;
const RERANK_QUERY_TOKENS = 256;
const RERANK_DOC_TOKENS = 1024;
const RERANK_CONTEXT = 2048; // query + doc + Qwen3-Reranker's instruction template (about 100 tokens)

/** Runs GPU work one call at a time, so two searches never hold two batches in video memory at once. */
let gpuQueue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = gpuQueue.then(fn);
  gpuQueue = run.catch(() => undefined);
  return run;
}

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
    p = onDevice(spec, GPU_HELPS.embed, async (o) => {
      const pipe: any = await pipeline('feature-extraction', spec.id, o);
      pipe.tokenizer.model_max_length = EMBED_TOKENS; // the pipeline truncates to this
      return pipe as Extractor;
    });
    p.catch(() => extractors.delete(key));
    extractors.set(key, p);
  }
  return p;
}

/** Normalized embedding vectors (batches of 32 on the CPU, 128 on a GPU, the faster size on each). Texts are batched
 * by length, so a batch pads to similar lengths; a GPU that fails mid-run (out of memory) hands over to the CPU. */
export async function embed(spec: EncoderSpec, texts: string[], batch?: number): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const { model: run, gpu } = await extractor(spec);
  const batchSize = batch ?? (gpu ? 128 : 32);
  const order = texts.map((t, i) => ({ t: t.slice(0, 2000), i })).sort((a, b) => a.t.length - b.t.length);
  const out: Float32Array[] = new Array(texts.length);
  try {
    for (let i = 0; i < order.length; i += batchSize) {
      const chunk = order.slice(i, i + batchSize);
      const res = await (gpu ? serial : (f: () => any) => f())(() => run(chunk.map((x) => x.t), { pooling: spec.pooling ?? 'mean', normalize: true }));
      const dim = res.dims.at(-1)!;
      chunk.forEach((x, k) => (out[x.i] = res.data.slice(k * dim, (k + 1) * dim)));
    }
  } catch (e) {
    if (!gpu) throw e;
    process.stderr.write(`[encoders] ${spec.id} failed on the GPU (${e instanceof Error ? e.message.slice(0, 200) : e}); using the CPU from now on
`);
    GPU = null;
    extractors.clear();
    return embed(spec, texts, batch);
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

let llama: Promise<any> | null = null;

/** node-llama-cpp's engine for the GGUF rerankers: the GPU when it finds a usable one (Vulkan, CUDA, Metal), else the CPU. */
function llamaRuntime(): Promise<any> {
  // Prebuilt binaries only (the package's install script is off); stdout belongs to the MCP transport.
  llama ??= import('node-llama-cpp').then((lib) =>
    lib.getLlama({
      gpu: process.env.APPFORGE_GPU === 'off' ? false : 'auto',
      build: 'never',
      progressLogs: false,
      logLevel: lib.LlamaLogLevel.warn,
      logger: (level, message) => process.stderr.write(`[reranker] ${level}: ${message}
`),
    }),
  );
  return llama;
}

/** GGUF rerankers by file. */
const rankers = new Map<string, Promise<{ model: any; context: any; timer?: NodeJS.Timeout }>>();

/** A GGUF reranker and its ranking context, loaded once per file and unloaded after APPFORGE_MODEL_IDLE_MS idle. */
function ggufRanker(file: string): Promise<{ model: any; context: any; timer?: NodeJS.Timeout }> {
  let p = rankers.get(file);
  if (!p) {
    p = llamaRuntime().then(async (engine) => {
      const model = await engine.loadModel({ modelPath: file });
      return { model, context: await model.createRankingContext({ contextSize: RERANK_CONTEXT, batchSize: RERANK_CONTEXT }) };
    });
    p.catch(() => rankers.delete(file));
    rankers.set(file, p);
  }
  return p;
}

/**
 * rankAll, but the tokens every input shares (Qwen3-Reranker's ~75-token instruction and the query) are evaluated once
 * and kept, so each document costs only its own ~30 tokens and the closing ones: 12.6 s instead of 19.3 s for 150 repos
 * with the 4B on a Radeon RX 6800. The scores are not identical (llama.cpp's ranking lets the shared tokens see the
 * document): up to 0.06 apart. Uses node-llama-cpp internals; APPFORGE_RERANK_PREFIX=off turns it off.
 */
async function rankSharedPrefix(context: any, query: string, docs: string[]): Promise<number[]> {
  const tok = (t: string) => context.model.tokenize(t, false, 'trimLeadingSpace');
  const q = tok(query);
  const inputs: number[][] = docs.map((d) => context._getEvaluationInput(q, tok(d)));
  let n = inputs[0]!.length;
  for (const x of inputs) {
    let i = 0;
    while (i < n && i < x.length - 1 && x[i] === inputs[0]![i]) i++;
    n = i;
  }
  const seq = context._sequence;
  await seq.eraseContextTokenRanges([{ start: 0, end: seq.nextTokenIndex }]);
  await seq.evaluateWithoutGeneratingNewTokens(inputs[0]!.slice(0, n));
  const out: number[] = [];
  for (const x of inputs) {
    await seq.eraseContextTokenRanges([{ start: n, end: seq.nextTokenIndex }]);
    const rest = x.slice(n);
    for await (const _ of seq.evaluate(rest, { _noSampling: true })) break;
    const e = context._llamaContext._ctx.getEmbedding(rest.length, 1);
    out.push(context._currentArchRankingAlreadyNormalized ? e[0] : 1 / (1 + Math.exp(-e[0])));
  }
  return out;
}

/** Chat-LLM rerankers (zerank: system = query, user = document) keep a plain context, loaded once per file. */
const chatRankers = new Map<string, Promise<{ model: any; context: any; seq: any; timer?: NodeJS.Timeout }>>();

/**
 * zerank's scoring: sigmoid(logit of "Yes" / 5) where the assistant's answer would start. The system message (the
 * query) is evaluated once and kept; each document costs its own tokens. A causal model, so the scores are exact.
 */
async function yesRank(file: string, yes: string, query: string, docs: string[]): Promise<number[]> {
  return serial(async () => {
    let p = chatRankers.get(file);
    if (!p) {
      p = llamaRuntime().then(async (engine) => {
        const model = await engine.loadModel({ modelPath: file });
        const context = await model.createContext({ contextSize: RERANK_CONTEXT, batchSize: RERANK_CONTEXT });
        return { model, context, seq: context.getSequence() };
      });
      p.catch(() => chatRankers.delete(file));
      chatRankers.set(file, p);
    }
    const r = await p;
    clearTimeout(r.timer);
    try {
      const tok = (t: string) => r.model.tokenize(t, true) as number[];
      const yesId = r.model.tokenize(yes, false)[0];
      const prefix = tok(`<|im_start|>system
${r.model.detokenize(r.model.tokenize(query).slice(0, RERANK_QUERY_TOKENS))}<|im_end|>
<|im_start|>user
`);
      await r.seq.eraseContextTokenRanges([{ start: 0, end: r.seq.nextTokenIndex }]);
      await r.seq.evaluateWithoutGeneratingNewTokens(prefix);
      const out: number[] = [];
      for (const d of docs) {
        await r.seq.eraseContextTokenRanges([{ start: prefix.length, end: r.seq.nextTokenIndex }]);
        const body = r.model.detokenize(r.model.tokenize(d).slice(0, RERANK_DOC_TOKENS));
        const rest = tok(`${body}<|im_end|>
<|im_start|>assistant
`);
        const res = await r.seq.controlledEvaluate([...rest.slice(0, -1), [rest.at(-1), { generateNext: { logits: { filter: { tokens: [yesId] } } } }]]);
        const logit = res.at(-1)?.next?.logits?.get(yesId) ?? -50;
        out.push(1 / (1 + Math.exp(-logit / 5)));
      }
      return out;
    } finally {
      r.timer = setTimeout(() => {
        chatRankers.delete(file);
        void r.context.dispose().then(() => r.model.dispose()).catch(() => undefined);
      }, Number(process.env.APPFORGE_MODEL_IDLE_MS) || 600_000).unref();
    }
  });
}

async function ggufRank(file: string, query: string, docs: string[]): Promise<number[]> {
  return serial(async () => {
    const r = await ggufRanker(file);
    clearTimeout(r.timer);
    const cut = (t: string, n: number) => { const tokens = r.model.tokenize(t); return tokens.length <= n ? t : r.model.detokenize(tokens.slice(0, n)); };
    try {
      const [q, d] = [cut(query, RERANK_QUERY_TOKENS), docs.map((x) => cut(x, RERANK_DOC_TOKENS))];
      // Only for decoder rerankers with a template (Qwen3): an encoder such as bge-reranker-v2-m3 must read the query
      // and the document together.
      if (process.env.APPFORGE_RERANK_PREFIX !== 'off' && docs.length > 1 && r.context._template != null) {
        try {
          return await rankSharedPrefix(r.context, q, d);
        } catch (e) {
          process.stderr.write(`[reranker] shared-prefix ranking failed (${e instanceof Error ? e.message : e}); using rankAll
`);
        }
      }
      return await r.context.rankAll(q, d);
    } finally {
      r.timer = setTimeout(() => {
        rankers.delete(file);
        void r.context.dispose().then(() => r.model.dispose()).catch(() => undefined);
      }, Number(process.env.APPFORGE_MODEL_IDLE_MS) || 600_000).unref();
    }
  });
}

/** Relevance of each doc to the query: the sigmoid of the cross-encoder's logit, or the GGUF reranker's score. */
export async function rerank(spec: EncoderSpec, query: string, docs: string[], batchSize = 8): Promise<number[]> {
  if (docs.length === 0) return [];
  if (spec.gguf && spec.yes) return yesRank(spec.gguf, spec.yes, query, docs);
  if (spec.gguf) return ggufRank(spec.gguf, query, docs);
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

// Stands in for the OpenAI SDK in the RepoRadar bundle (scripts/build-reporadar.mjs redirects `openai` here). It
// answers only upstream's listwise ranker (RepoRadar/upstream/src/lib/llm/listwise.ts), on a local GGUF model run by
// node-llama-cpp (file from APPFORGE_LLM_MODEL_PATH), so nothing leaves the machine. Every other prompt throws, and
// upstream's chatJson then falls back on its own. One model is loaded at a time, calls run one after another, and the
// model unloads after APPFORGE_LLM_IDLE_MS.

import fs from 'node:fs';

const LISTWISE_PREFIX = "You are RepoRadar's listwise repository ranker";
const REPO_TYPES = ['library', 'framework', 'cli', 'app', 'template', 'demo', 'tutorial', 'awesome-list', 'plugin', 'extension', 'dataset', 'docs/profile', 'generated-sdk', 'mirror/fork-like', 'research', 'unknown'];

/** Runs one prompt with output constrained to a JSON schema; tests replace it with setEngine(). */
export type Engine = (modelPath: string, system: string, user: string, schema: object, maxTokens: number, signal?: AbortSignal) => Promise<string>;

/**
 * The listwise answer: one entry per candidate, names limited to the candidates' own. (Keying the answer by name
 * would force each repo exactly once, but then models number the repos in input order and the ranking is lost; a repo
 * a model skips goes to upstream's middle tier, below every repo it kept.)
 */
export function listwiseSchema(fullNames: string[]) {
  const entry = {
    type: 'object',
    properties: { fullName: { enum: fullNames }, rank: { type: 'integer' }, fit: { type: 'number' }, relevant: { type: 'boolean' }, repoType: { enum: REPO_TYPES }, summary: { type: 'string', maxLength: 140 } },
  };
  return { type: 'object', properties: { results: { type: 'array', minItems: fullNames.length, maxItems: fullNames.length, items: entry } } };
}

let loaded: { path: string; model: any; context: any; sequence: any; timer?: NodeJS.Timeout } | null = null;
let llama: Promise<any> | null = null;

async function unload(): Promise<void> {
  if (!loaded) return;
  clearTimeout(loaded.timer);
  const { model, context } = loaded;
  loaded = null;
  await context.dispose().catch(() => undefined);
  await model.dispose().catch(() => undefined);
}

/** Loads the model, on the GPU when node-llama-cpp finds a usable one (Vulkan, CUDA, Metal), else on the CPU. */
async function load(modelPath: string) {
  const lib = await import('node-llama-cpp');
  // Prebuilt binaries only (the package's install script is off); stdout belongs to the MCP transport.
  llama ??= lib.getLlama({
    gpu: process.env.APPFORGE_LLM_GPU === 'off' ? false : 'auto',
    build: 'never',
    progressLogs: false,
    logLevel: lib.LlamaLogLevel.warn,
    logger: (level, message) => process.stderr.write(`[local-llm] ${level}: ${message}\n`),
  });
  const engine = await llama;
  if (loaded?.path !== modelPath) {
    await unload();
    if (!fs.existsSync(modelPath)) throw new Error(`Local LLM model not found: ${modelPath} (run \`appforge setup models\`).`);
    const model = await engine.loadModel({ modelPath });
    const context = await model.createContext({ contextSize: { min: 8192, max: 12288 } });
    // One sequence for the model's lifetime: it keeps the evaluated prompt, so the same system prompt is not read again.
    loaded = { path: modelPath, model, context, sequence: context.getSequence() };
  }
  clearTimeout(loaded!.timer);
  return { lib, engine, ...loaded! };
}

const nodeLlamaCpp: Engine = async (modelPath, system, user, schema, maxTokens, signal) => {
  const { lib, engine, model, sequence } = await load(modelPath);
  // Thinking off: Qwen models get the empty think block their template uses for that; others the zero budget.
  const chatWrapper = lib.resolveChatWrapper(model, { customWrapperSettings: { qwen: { thoughts: 'discourage' } } });
  const session = new lib.LlamaChatSession({ contextSequence: sequence, chatWrapper, systemPrompt: system, autoDisposeSequence: false });
  try {
    return await session.prompt(user, { grammar: await engine.createGrammarForJsonSchema(schema), maxTokens, temperature: 0, signal, budgets: { thoughtTokens: 0 } });
  } finally {
    session.dispose({ disposeSequence: false });
    loaded!.timer = setTimeout(() => void unload(), Number(process.env.APPFORGE_LLM_IDLE_MS) || 600_000).unref();
  }
};

let engine: Engine = nodeLlamaCpp;
export function setEngine(e: Engine): void {
  engine = e;
}

let queue: Promise<unknown> = Promise.resolve();

/** Starts loading the model in the background; a search calls it first, so the load overlaps the GitHub fetch. */
export function preload(modelPath: string): void {
  if (engine !== nodeLlamaCpp || loaded?.path === modelPath) return;
  queue = queue.then(() => load(modelPath)).catch(() => undefined);
}
// Upstream retries a listwise call that returned nothing, which after a timeout would queue a second full generation
// behind the aborted one; the same request right after a timeout is refused instead, so a slow machine falls back once.
let timedOut: { user: string; at: number } | null = null;

async function create(params: { messages: { role: string; content: string }[]; max_tokens?: number }, options?: { signal?: AbortSignal }) {
  const system = params.messages.find((m) => m.role === 'system')?.content ?? '';
  const user = params.messages.find((m) => m.role === 'user')?.content ?? '';
  if (!system.startsWith(LISTWISE_PREFIX)) throw new Error('AppForge runs only the listwise ranker on the local LLM.');
  const modelPath = process.env.APPFORGE_LLM_MODEL_PATH;
  if (!modelPath) throw new Error('No local LLM model (APPFORGE_LLM_MODEL_PATH is not set).');
  if (timedOut?.user === user && Date.now() - timedOut.at < 120_000) throw new Error('The same listwise request just timed out.');
  const names = [...new Set((JSON.parse(user) as { candidates: { fullName: string }[] }).candidates.map((c) => c.fullName))];
  const run = queue.then(() => {
    options?.signal?.throwIfAborted();
    return engine(modelPath, system, user, listwiseSchema(names), params.max_tokens ?? 3000, options?.signal);
  });
  queue = run.catch(() => undefined);
  try {
    const content = await run;
    // For comparing models offline (scripts/eval-search.mjs): every request and answer, one JSON line each.
    if (process.env.APPFORGE_LLM_DUMP) fs.appendFileSync(process.env.APPFORGE_LLM_DUMP, JSON.stringify({ user: JSON.parse(user), answer: JSON.parse(content) }) + '\n');
    return { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] };
  } catch (e) {
    if (options?.signal?.aborted) timedOut = { user, at: Date.now() };
    throw e;
  }
}

export default class OpenAI {
  readonly chat = { completions: { create } };
  // Upstream passes OpenRouter's base URL, key and headers; none of them apply to a local model.
  constructor(_options?: unknown) {}
}

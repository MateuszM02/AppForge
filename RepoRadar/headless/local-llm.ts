// A small local LLM (a GGUF file run by node-llama-cpp) that answers one JSON request at a time. Used by
// openai-local.ts for RepoRadar's listwise pick; nothing leaves the machine. The model loads on the first call,
// stays cached for its path and unloads after an idle timeout. Output is constrained by a JSON grammar (the
// request's JSON schema, or plain JSON), and thinking is switched off. Tests replace the engine with setBackend().

import fs from 'node:fs';

export interface GenerateRequest {
  system: string;
  user: string;
  /** JSON schema the output must follow; plain JSON when missing. */
  schema?: object;
  maxTokens: number;
  temperature: number;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Time until the first generated token (prompt processing). */
  promptMs: number;
  generationMs: number;
}

export interface LoadedModel {
  /** GPU type in use ("vulkan", "cuda", "metal"), or false on the CPU. */
  readonly gpu: string | false;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  dispose(): Promise<void>;
}

export interface LlmBackend {
  readonly name: string;
  load(modelPath: string, opts: { contextSize: number }): Promise<LoadedModel>;
}

export interface GenerateJsonArgs extends GenerateRequest {
  modelPath: string;
  /** Unload the model after this long without calls. Default 5 minutes. */
  idleUnloadMs?: number;
  /** Context window (prompt + answer) in tokens, used when the model loads. Default 12288. */
  contextSize?: number;
}

export interface LlmStatus {
  backend: string;
  loadedModel: string | null;
  gpu: string | false | null;
  loadSeconds: number | null;
  lastError: string | null;
  lastCall: {
    inputTokens: number;
    outputTokens: number;
    promptTokensPerSecond: number;
    tokensPerSecond: number;
    seconds: number;
  } | null;
}

const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_CONTEXT = 12_288;

let backend: LlmBackend = nodeLlamaCppBackend();
let loaded: { path: string; model: LoadedModel; timer?: NodeJS.Timeout } | null = null;
let queue: Promise<unknown> = Promise.resolve();
const state: Omit<LlmStatus, 'backend' | 'loadedModel' | 'gpu'> = { loadSeconds: null, lastError: null, lastCall: null };

/** Replaces the engine (tests); unloads whatever the previous one had loaded. */
export async function setBackend(next: LlmBackend): Promise<void> {
  await enqueue(unload);
  backend = next;
  Object.assign(state, { loadSeconds: null, lastError: null, lastCall: null });
}

export function status(): LlmStatus {
  return { backend: backend.name, loadedModel: loaded?.path ?? null, gpu: loaded ? loaded.model.gpu : null, ...state };
}

/** Runs one request on the local model and returns the parsed JSON. Calls run one at a time, in order. */
export async function generateJson<T = unknown>(args: GenerateJsonArgs): Promise<T> {
  args.signal?.throwIfAborted();
  const job = enqueue(async () => {
    args.signal?.throwIfAborted();
    try {
      const model = await ensureLoaded(args.modelPath, args.contextSize ?? DEFAULT_CONTEXT);
      const started = Date.now();
      const out = await model.generate(args);
      args.signal?.throwIfAborted();
      state.lastCall = {
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        promptTokensPerSecond: perSecond(out.inputTokens, out.promptMs),
        tokensPerSecond: perSecond(out.outputTokens, out.generationMs),
        seconds: (Date.now() - started) / 1000,
      };
      try {
        return JSON.parse(out.text) as T;
      } catch {
        throw new Error(`The local LLM returned incomplete JSON (${out.outputTokens} tokens; maxTokens ${args.maxTokens} may be too low).`);
      }
    } catch (e) {
      if (!args.signal?.aborted) state.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      armIdleTimer(args.idleUnloadMs ?? DEFAULT_IDLE_MS);
    }
  });
  if (!args.signal) return job;
  // A caller that gives up stops waiting at once; a job still in the queue then skips itself (throwIfAborted above).
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(args.signal!.reason);
    args.signal!.addEventListener('abort', onAbort, { once: true });
    job.then(resolve, reject).finally(() => args.signal!.removeEventListener('abort', onAbort));
  });
}

/** Unloads the model now (also done after the idle timeout). */
export function unloadModel(): Promise<void> {
  return enqueue(unload);
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

async function ensureLoaded(modelPath: string, contextSize: number): Promise<LoadedModel> {
  if (loaded?.path === modelPath) {
    clearTimeout(loaded.timer);
    return loaded.model;
  }
  await unload(); // one model in memory at a time
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Local LLM model file not found: ${modelPath}. Download it again (AppForge installer) or point APPFORGE_LLM_MODEL_PATH at a .gguf file.`);
  }
  const started = Date.now();
  let model: LoadedModel;
  try {
    model = await backend.load(modelPath, { contextSize });
  } catch (e) {
    throw new Error(`Could not load the local LLM model ${modelPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  state.loadSeconds = (Date.now() - started) / 1000;
  loaded = { path: modelPath, model };
  return model;
}

function armIdleTimer(ms: number): void {
  if (!loaded) return;
  clearTimeout(loaded.timer);
  loaded.timer = setTimeout(() => void enqueue(unload), ms);
  loaded.timer.unref();
}

async function unload(): Promise<void> {
  if (!loaded) return;
  const { model, timer } = loaded;
  clearTimeout(timer);
  loaded = null;
  await model.dispose().catch(() => undefined);
}

function perSecond(tokens: number, ms: number): number {
  return ms > 0 ? Math.round((tokens / ms) * 10_000) / 10 : 0;
}

// The real engine. node-llama-cpp is imported lazily so loading RepoRadar costs nothing until the first call, and it
// only uses the prebuilt binaries shipped in its npm packages (its install script, which can build llama.cpp, is off).
function nodeLlamaCppBackend(): LlmBackend {
  let llama: Promise<import('node-llama-cpp').Llama> | null = null;
  return {
    name: 'node-llama-cpp',
    async load(modelPath, { contextSize }) {
      const lib = await import('node-llama-cpp');
      llama ??= lib.getLlama({
        gpu: process.env.APPFORGE_LLM_GPU === 'off' ? false : 'auto',
        build: 'never',
        progressLogs: false,
        logLevel: lib.LlamaLogLevel.warn,
        // stdout belongs to the MCP transport
        logger: (level, message) => process.stderr.write(`[local-llm] ${level}: ${message}\n`),
      }).catch((e) => {
        llama = null;
        throw e;
      });
      const engine = await llama;
      const model = await engine.loadModel({ modelPath });
      let context: import('node-llama-cpp').LlamaContext;
      try {
        // A minimum so a listwise prompt fits; a machine without the memory for it fails here with a clear error.
        context = await model.createContext({ contextSize: { min: Math.min(8192, contextSize), max: contextSize } });
      } catch (e) {
        await model.dispose();
        throw e;
      }
      const sequence = context.getSequence();
      // Thinking off: Qwen3-style models get the empty think block their template uses for that (a thought budget of 0
      // alone lets the opened thought swallow the first answer token); for other models the budget below is enough.
      const chatWrapper = lib.resolveChatWrapper(model, { customWrapperSettings: { qwen: { thoughts: 'discourage' } } });
      return {
        gpu: engine.gpu,
        async generate(req) {
          const promptTokens = model.tokenize(req.system + req.user).length;
          const room = context.contextSize - promptTokens - 64;
          if (room < 256) throw new Error(`The prompt is ${promptTokens} tokens; the local LLM context holds ${context.contextSize}.`);
          const grammar = req.schema
            ? await engine.createGrammarForJsonSchema(req.schema as Parameters<typeof engine.createGrammarForJsonSchema>[0])
            : await engine.getGrammarFor('json');
          // A fresh session per call; the sequence keeps its cache, so a repeated system prompt is not evaluated again.
          const session = new lib.LlamaChatSession({ contextSequence: sequence, chatWrapper, systemPrompt: req.system, autoDisposeSequence: false });
          const before = sequence.tokenMeter.getState();
          const started = Date.now();
          let firstToken = 0;
          try {
            const text = await session.prompt(req.user, {
              grammar,
              maxTokens: Math.min(req.maxTokens, room),
              temperature: req.temperature,
              signal: req.signal,
              budgets: { thoughtTokens: 0 },
              onResponseChunk: () => {
                firstToken ||= Date.now();
              },
            });
            const used = sequence.tokenMeter.diff(before);
            const end = Date.now();
            firstToken ||= end;
            return {
              text,
              inputTokens: used.usedInputTokens,
              outputTokens: used.usedOutputTokens,
              promptMs: firstToken - started,
              generationMs: end - firstToken,
            };
          } finally {
            session.dispose({ disposeSequence: false });
          }
        },
        async dispose() {
          await context.dispose();
          await model.dispose();
        },
      };
    },
  };
}

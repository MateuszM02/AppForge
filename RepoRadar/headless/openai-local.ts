// Stands in for the OpenAI SDK in the RepoRadar bundle (scripts/build-reporadar.mjs redirects `openai` here). It
// answers only upstream's listwise ranker (RepoRadar/upstream/src/lib/llm/listwise.ts), on a small local model
// (local-llm.ts, model file from APPFORGE_LLM_MODEL_PATH); nothing leaves the machine. Every other prompt (intent,
// HyDE, the pointwise evaluator) throws, so upstream's chatJson returns null and that step falls back on its own.
// Upstream only constructs this client when NO_LLM_MODE is off.

import { generateJson } from './local-llm.js';

const LISTWISE_PREFIX = "You are RepoRadar's listwise repository ranker";

// The labels the listwise prompt lists.
const REPO_TYPES = [
  'library', 'framework', 'cli', 'app', 'template', 'demo', 'tutorial', 'awesome-list', 'plugin', 'extension',
  'dataset', 'docs/profile', 'generated-sdk', 'mirror/fork-like', 'research', 'unknown',
];

interface ChatMessage {
  role: string;
  content: string;
}

interface CreateParams {
  model?: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
}

/** The JSON schema the listwise answer must follow: one entry per candidate, names limited to the candidates'. */
export function listwiseSchema(fullNames: string[]) {
  return {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        minItems: fullNames.length,
        maxItems: fullNames.length,
        items: {
          type: 'object',
          properties: {
            fullName: { enum: fullNames },
            rank: { type: 'integer' },
            fit: { type: 'number' },
            relevant: { type: 'boolean' },
            repoType: { enum: REPO_TYPES },
            summary: { type: 'string', maxLength: 160 },
          },
        },
      },
    },
  } as const;
}

async function create(params: CreateParams, options?: { signal?: AbortSignal }) {
  const system = params.messages.find((m) => m.role === 'system')?.content ?? '';
  const user = params.messages.find((m) => m.role === 'user')?.content ?? '';
  if (!system.startsWith(LISTWISE_PREFIX)) {
    throw new Error('AppForge runs only the listwise ranker on the local LLM; this step uses its own fallback.');
  }
  const modelPath = process.env.APPFORGE_LLM_MODEL_PATH;
  if (!modelPath) throw new Error('APPFORGE_LLM_MODEL_PATH is not set, so there is no local LLM model.');

  let fullNames: string[];
  try {
    const candidates = (JSON.parse(user) as { candidates: { fullName: string }[] }).candidates;
    fullNames = [...new Set(candidates.map((c) => c.fullName))];
  } catch {
    throw new Error('The listwise request has no readable candidate list.');
  }
  if (fullNames.length === 0) throw new Error('The listwise request has no candidates.');

  const result = await generateJson({
    modelPath,
    system,
    user,
    schema: listwiseSchema(fullNames),
    maxTokens: params.max_tokens ?? 3000,
    temperature: params.temperature ?? 0,
    signal: options?.signal,
  });
  return { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(result) } }] };
}

export default class OpenAI {
  readonly chat = { completions: { create } };

  // Upstream passes OpenRouter's base URL, key and headers; none of them apply to a local model.
  constructor(_options?: unknown) {}
}

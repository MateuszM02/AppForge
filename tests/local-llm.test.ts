import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { generateJson, setBackend, status, unloadModel, type GenerateRequest, type LlmBackend } from '../RepoRadar/headless/local-llm.js';
import OpenAI, { listwiseSchema } from '../RepoRadar/headless/openai-local.js';

// A fake model file (only its existence is checked) and a fake engine that records what it was asked.
const modelPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'appforge-llm-')), 'fake.gguf');
fs.writeFileSync(modelPath, '');
process.env.APPFORGE_LLM_MODEL_PATH = modelPath;

function fakeBackend(answer: (req: GenerateRequest) => Promise<string> | string) {
  const calls: GenerateRequest[] = [];
  let loads = 0;
  let disposed = 0;
  const backend: LlmBackend = {
    name: 'fake',
    async load() {
      loads++;
      return {
        gpu: false,
        async generate(req) {
          calls.push(req);
          return { text: await answer(req), inputTokens: 100, outputTokens: 20, promptMs: 50, generationMs: 200 };
        },
        async dispose() {
          disposed++;
        },
      };
    },
  };
  return { backend, calls, loads: () => loads, disposed: () => disposed };
}

const listwiseSystem = "You are RepoRadar's listwise repository ranker. Rank ALL candidate repositories ...";
const listwiseUser = JSON.stringify({
  intent: { prompt: 'react data table', constraints: {} },
  candidates: [{ fullName: 'TanStack/table' }, { fullName: 'pmndrs/zustand' }],
});

test('the OpenAI stand-in answers the listwise ranker in the SDK response shape', async () => {
  const fake = fakeBackend(() =>
    JSON.stringify({ results: [{ fullName: 'TanStack/table', rank: 1, fit: 0.9, relevant: true, repoType: 'library', summary: 'fits' }] }),
  );
  await setBackend(fake.backend);
  const client = new OpenAI({ baseURL: 'ignored', apiKey: 'ignored' });
  const res = await client.chat.completions.create(
    { model: 'x', max_tokens: 3000, temperature: 0, messages: [{ role: 'system', content: listwiseSystem }, { role: 'user', content: listwiseUser }] },
    { signal: new AbortController().signal },
  );
  assert.equal(JSON.parse(res.choices[0]!.message.content).results[0].fullName, 'TanStack/table');

  const req = fake.calls[0]!;
  assert.equal(req.system, listwiseSystem);
  assert.equal(req.user, listwiseUser);
  assert.equal(req.maxTokens, 3000);
  assert.equal(req.temperature, 0);
  assert.deepEqual(req.schema, listwiseSchema(['TanStack/table', 'pmndrs/zustand']));
  assert.equal(status().loadedModel, modelPath);
  assert.equal(status().lastCall?.tokensPerSecond, 100);
});

test('the listwise schema limits fullName to the candidates and asks for every field', () => {
  const schema = listwiseSchema(['a/b', 'c/d']);
  const results = schema.properties.results;
  assert.equal(results.minItems, 2);
  assert.equal(results.maxItems, 2);
  assert.deepEqual(results.items.properties.fullName.enum, ['a/b', 'c/d']);
  assert.deepEqual(Object.keys(results.items.properties), ['fullName', 'rank', 'fit', 'relevant', 'repoType', 'summary']);
  assert.equal(results.items.properties.relevant.type, 'boolean');
});

test('every other upstream prompt throws, so upstream falls back on its own', async () => {
  const fake = fakeBackend(() => '{}');
  await setBackend(fake.backend);
  const client = new OpenAI();
  for (const system of ['You extract search intent ...', 'You write a hypothetical README ...', 'You are RepoRadar, a repository evaluator ...']) {
    await assert.rejects(client.chat.completions.create({ messages: [{ role: 'system', content: system }, { role: 'user', content: '{}' }] }));
  }
  assert.equal(fake.calls.length, 0);
});

test('calls run one at a time, in order, on one loaded model', async () => {
  let running = 0;
  let maxRunning = 0;
  const fake = fakeBackend(async (req) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 20));
    running--;
    return JSON.stringify({ n: req.user });
  });
  await setBackend(fake.backend);
  const results = await Promise.all(
    ['1', '2', '3'].map((user) => generateJson<{ n: string }>({ modelPath, system: 's', user, maxTokens: 10, temperature: 0 })),
  );
  assert.deepEqual(results.map((r) => r.n), ['1', '2', '3']);
  assert.equal(maxRunning, 1);
  assert.equal(fake.loads(), 1);
});

test('an aborted call stops waiting at once and a queued one never runs', async () => {
  let release: (() => void) | undefined;
  const fake = fakeBackend((req) => (req.user === 'slow' ? new Promise((r) => (release = () => r('{}'))) : '{}'));
  await setBackend(fake.backend);
  const slow = generateJson({ modelPath, system: 's', user: 'slow', maxTokens: 10, temperature: 0 });
  const controller = new AbortController();
  const queued = generateJson({ modelPath, system: 's', user: 'queued', maxTokens: 10, temperature: 0, signal: controller.signal });
  controller.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  while (!release) await new Promise((r) => setTimeout(r, 5)); // until the slow call runs
  release();
  await slow;
  assert.deepEqual(fake.calls.map((c) => c.user), ['slow']);
  await assert.rejects(
    generateJson({ modelPath, system: 's', user: 'x', maxTokens: 10, temperature: 0, signal: AbortSignal.abort() }),
    { name: 'AbortError' },
  );
});

test('a missing model file or a failed load gives a clear error', async () => {
  const fake = fakeBackend(() => '{}');
  await setBackend(fake.backend);
  const missing = path.join(os.tmpdir(), 'no-such-model.gguf');
  await assert.rejects(generateJson({ modelPath: missing, system: 's', user: 'u', maxTokens: 10, temperature: 0 }), /model file not found: .*no-such-model\.gguf/);
  assert.match(status().lastError ?? '', /not found/);
  assert.equal(fake.loads(), 0);

  await setBackend({ name: 'broken', load: async () => Promise.reject(new Error('unknown model architecture')) });
  await assert.rejects(generateJson({ modelPath, system: 's', user: 'u', maxTokens: 10, temperature: 0 }), /Could not load the local LLM model .*unknown model architecture/);
});

test('a truncated answer is an error, and the model still unloads when idle', async () => {
  const fake = fakeBackend((req) => (req.user === 'cut' ? '{"results": [' : '{}'));
  await setBackend(fake.backend);
  await generateJson({ modelPath, system: 's', user: 'ok', maxTokens: 10, temperature: 0 });
  await assert.rejects(generateJson({ modelPath, system: 's', user: 'cut', maxTokens: 10, temperature: 0, idleUnloadMs: 10 }), /incomplete JSON/);
  assert.equal(status().loadedModel, modelPath);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(status().loadedModel, null);
  assert.equal(fake.disposed(), 1);
  await unloadModel(); // nothing left to unload
  assert.equal(fake.disposed(), 1);
});

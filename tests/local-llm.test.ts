import assert from 'node:assert/strict';
import { test } from 'node:test';
import OpenAI, { listwiseSchema, setEngine } from '../RepoRadar/headless/openai-local.js';

const listwise = (names: string[]) => ({
  messages: [
    { role: 'system', content: "You are RepoRadar's listwise repository ranker. Rank ALL candidate repositories..." },
    { role: 'user', content: JSON.stringify({ candidates: names.map((fullName) => ({ fullName })) }) },
  ],
});

test('only the listwise ranker runs, with each candidate named exactly once by the schema', async () => {
  const calls: { schema: object; model: string }[] = [];
  setEngine(async (model, _s, _u, schema) => {
    calls.push({ schema, model });
    return '{"results":[]}';
  });
  process.env.APPFORGE_LLM_MODEL_PATH = 'model.gguf';
  const client = new OpenAI();
  const out = await client.chat.completions.create(listwise(['a/x', 'b/y', 'a/x']));
  assert.equal(out.choices[0]!.message.content, '{"results":[]}');
  assert.deepEqual(calls[0]!.schema, listwiseSchema(['a/x', 'b/y']));
  await assert.rejects(client.chat.completions.create({ messages: [{ role: 'system', content: "You are RepoRadar's search architect" }] }));
});

test('calls run one at a time, and a request that timed out is not run again right away', async () => {
  let active = 0;
  let maxActive = 0;
  setEngine(async (_m, _s, _u, _schema, _t, signal) => {
    maxActive = Math.max(maxActive, ++active);
    await new Promise((r, reject) => {
      const t = setTimeout(r, 30);
      signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)));
    });
    active--;
    return '{}';
  });
  const client = new OpenAI();
  await Promise.all([client.chat.completions.create(listwise(['a/1'])), client.chat.completions.create(listwise(['a/2']))]);
  assert.equal(maxActive, 1);
  const slow = listwise(['a/3']);
  await assert.rejects(client.chat.completions.create(slow, { signal: AbortSignal.timeout(5) }));
  await assert.rejects(client.chat.completions.create(slow), /just timed out/);
});

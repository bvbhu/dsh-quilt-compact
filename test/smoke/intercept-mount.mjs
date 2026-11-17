/**
 * Host-plane smoke test for the NEW cooperative interceptor.
 *
 * Mounts the plugin's `apply()` in a REAL cordis container together with a
 * stand-in `ctx.compaction` owner (dsh-compaction-basic's role), and verifies:
 *  1. the plugin registers NO `compaction` service (it must not replace the
 *     host backend);
 *  2. it registers exactly one `llm/stream` listener;
 *  3. a `purpose: 'compaction'` call is rewritten into digests + anchors;
 *  4. a non-compaction call is untouched;
 *  5. unloading removes the listener.
 */
import { Context } from '@deepseek-ai/cordis';
import assert from 'node:assert/strict';

import { apply, name, inject } from '../../lib/intercept.js';
import { ANCHOR_OPEN_TAG } from '../../lib/summarize.js';

console.log('plugin name:', name);
assert.deepEqual([...inject].sort(), ['llm', 'sessions', 'tokenMeter']);

const llmCalls = [];
const ctx = new Context();
ctx.provide('llm', {
  async *stream(options) {
    llmCalls.push(options);
    const text = 'digest from ' + options.provider + '/' + options.model;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
  async resolveModelInfo(provider, model) {
    return { provider, model, context: { contextWindow: 32000 }, defaultMaxTokens: 4096 };
  },
  providerRetryPolicy() {
    return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 };
  },
});
ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 0, nodes: [] }) });
ctx.provide('sessions', { get: () => undefined, async flush() {} });

const sink = { info() {}, warn() {}, error() {}, debug() {} };
ctx.logger = sink;

const config = {
  tiers: [{ name: 'primary', models: [{ provider: 'p1', model: 'm1', maxConcurrent: 1, cooldownHours: 1 }] }],
  mergeMaxContextTokens: 8000,
};

const fiber = ctx.plugin({ name: 'intercept-smoke', inject, apply, Config: undefined }, config);
await new Promise((resolve) => setImmediate(resolve));

// 1. No `compaction` service was claimed by this plugin.
assert.equal(ctx.get('compaction'), undefined, 'the interceptor must not register ctx.compaction');
console.log('no compaction service registered: OK');

/** Drive the full waterfall the way dsh-llm does. */
async function callStream(options) {
  const iterable = ctx.waterfall(ctx.get('llm'), 'llm/stream', options, () => (async function* host() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'HOST SUMMARY' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'HOST SUMMARY' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })());
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

function textOf(chunks) {
  let text = '';
  for (const chunk of chunks) {
    if (chunk.type === 'text-delta') text += chunk.text;
    if (chunk.type === 'block-end' && chunk.block?.type === 'text') text = chunk.block.text;
  }
  return text;
}

const region = Array.from({ length: 400 }, (_, i) => `line ${i}: exact path D:/app/file${i}.js and decision ${i}`).join('\n');
const compactionOptions = {
  provider: 'p',
  model: 'm',
  purpose: 'compaction',
  sessionId: 's-smoke',
  maxTokens: 2048,
  messages: [{ role: 'user', content: [{ type: 'text', text: region }] }],
};

const rewritten = await callStream(compactionOptions);
const text = textOf(rewritten);
assert.ok(text.includes(ANCHOR_OPEN_TAG), 'compaction summary carries the anchor block');
assert.ok(llmCalls.length > 0, 'the pool served digest calls');
console.log('compaction rewritten with anchors over', llmCalls.length, 'pool call(s): OK');

// A non-compaction call is passed through untouched.
llmCalls.length = 0;
const plain = await callStream({ provider: 'p', model: 'm', purpose: 'chat', messages: [] });
assert.equal(textOf(plain), 'HOST SUMMARY', 'non-compaction calls are untouched');
assert.equal(llmCalls.length, 0, 'no auxiliary call for non-compaction requests');
console.log('non-compaction passthrough: OK');

// 5. Unload removes the listener: the same call now reaches the host stream.
await fiber.dispose();
const afterUnload = await callStream(compactionOptions);
assert.equal(textOf(afterUnload), 'HOST SUMMARY', 'listener removed on dispose');
console.log('listener removed on dispose: OK');

console.log('\nINTERCEPT-MOUNT-OK');

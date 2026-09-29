/**
 * ModelChain scheduler: concurrency, cooldown, degradation, fallback.
 * @module dsh-quilt-compact/test/unit/model-chain
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelChain, chunkJob, mergeJob } from '../../lib/model-chain.js';
import { MemoryCooldownStore } from '../../lib/cooldown.js';
import { resolveConfig } from '../../lib/config.js';
import { createFakeLlm, sleep } from '../helpers/fixture.js';

/** Deterministic virtual timers for the scheduler's now/sleep hooks. */
function virtualTimers(start = 1_000_000) {
  let now = start;
  const waits = [];
  return {
    now: () => now,
    advance(ms) {
      now += ms;
      const remaining = [];
      for (const wait of waits) {
        if (wait.until <= now) wait.resolve();
        else remaining.push(wait);
      }
      waits.length = 0;
      waits.push(...remaining);
    },
    sleep(ms) {
      return new Promise((resolve) => {
        waits.push({ until: now + ms, resolve });
      });
    },
  };
}

function chainCtx(llm, internals = {}) {
  const ctx = { llm, logger: { info() {}, warn() {}, error() {} } };
  return { ctx, internals };
}

function twoModelConfig(overrides = {}) {
  return resolveConfig({
    tiers: [
      {
        name: 'primary',
        models: [
          { provider: 'p1', model: 'm1', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 5 } },
          { provider: 'p1', model: 'm2', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 5 } },
        ],
      },
    ],
    ...overrides,
  });
}

const fakeSession = (header) => ({
  id: 's-test',
  requestHeader: header === undefined ? undefined : () => ({ config: header }),
});

test('distributes jobs across healthy models under maxConcurrent', async () => {
  const llm = createFakeLlm({}, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  const config = twoModelConfig();
  const chain = new ModelChain(chainCtx(llm).ctx, config, store, {});
  const jobs = Array.from({ length: 4 }, (_, index) => chunkJob(`chunk ${index}`, `content number ${index} `.repeat(20)));
  const results = await chain.run(jobs, { session: fakeSession() }, undefined);
  assert.equal(results.length, 4);
  assert.ok(results.every((r) => r.text.startsWith('digest(')));
  const routes = new Set(llm.calls.map((c) => `${c.provider}/${c.model}`));
  assert.deepEqual([...routes].sort(), ['p1/m1', 'p1/m2']);
  assert.ok(llm.peakConcurrency <= 1, `peak concurrency ${llm.peakConcurrency} must be <= 1`);
  assert.deepEqual(store.keys(), [], 'no failures means no cooldown records');
});

test('a failed model is cooled and the job retries on another model in the same tier', async () => {
  const llm = createFakeLlm({
    'p1/m1': { kind: 'fail', code: 'RATE_LIMIT', message: 'cooled down' },
  }, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  const chain = new ModelChain(chainCtx(llm).ctx, twoModelConfig(), store, {});
  const [result] = await chain.run([chunkJob('chunk 1', 'text '.repeat(30))], { session: fakeSession() }, undefined);
  assert.ok(result.text.includes('p1/m2'), `expected m2 digest, got ${result.text}`);
  assert.equal(store.cooldownUntil('p1/m1') > 0, true, 'cooldown written for the failed route');
  assert.equal(store.cooldownUntil('p1/m2'), 0, 'successful route stays healthy');
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].model, 'p1/m1');
});

test('whole-tier failure degrades to the next tier', async () => {
  const llm = createFakeLlm({
    'p1/m1': { kind: 'fail', code: 'SERVER' },
    'p1/m2': { kind: 'fail', code: 'SERVER' },
  }, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  const config = twoModelConfig({
    tiers: [
      { name: 'primary', models: [
        { provider: 'p1', model: 'm1', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 5 } },
        { provider: 'p1', model: 'm2', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 5 } },
      ] },
      { name: 'fallback-tier', models: [
        { provider: 'p2', model: 'm3', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 5 } },
      ] },
    ],
  });
  const chain = new ModelChain(chainCtx(llm).ctx, config, store, {});
  const [result] = await chain.run([chunkJob('chunk 1', 'text '.repeat(30))], { session: fakeSession() }, undefined);
  assert.ok(result.text.includes('p2/m3'), `expected degraded tier digest, got ${result.text}`);
  assert.ok(store.cooldownUntil('p1/m1') > 0 && store.cooldownUntil('p1/m2') > 0);
});

test('all tiers failed -> session-model fallback succeeds', async () => {
  const llm = createFakeLlm({
    'p1/m1': { kind: 'fail' },
    'p1/m2': { kind: 'fail' },
  }, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  const config = twoModelConfig({
    fallbackToSessionModel: true,
    tiers: [
      { name: 'primary', models: [
        { provider: 'p1', model: 'm1', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 5 } },
        { provider: 'p1', model: 'm2', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 5 } },
      ] },
    ],
  });
  const chain = new ModelChain(chainCtx(llm).ctx, config, store, {});
  const session = fakeSession({ provider: 'session-provider', model: 'session-model' });
  // The delegate path: `defaultSummarize` is the DIRECT call to the default
  // compression plugin (dsh-compaction-basic) over the original region input.
  let delegated;
  const defaultSummarize = async (input, agent, signal) => {
    delegated = { input, agent, signal };
    return { summary: [{ type: 'text', text: 'DEFAULT-PLUGIN DIGEST' }], provider: 'session-provider', model: 'session-model', maxTokens: 65536 };
  };
  const fallbackInput = { messages: [{ role: 'system', content: [{ type: 'text', text: 'sys' }] }] };
  const [result] = await chain.run([chunkJob('chunk 1', 'text '.repeat(30))], { session }, undefined, { fallbackInput, defaultSummarize });
  assert.equal(result.fallback, true);
  assert.equal(result.text, 'DEFAULT-PLUGIN DIGEST');
  assert.equal(result.provider, 'session-provider');
  assert.equal(delegated.input, fallbackInput, 'default plugin receives the ORIGINAL region input');
  assert.equal(delegated.agent.session, session);
  assert.deepEqual(store.keys().sort(), ['p1/m1', 'p1/m2'], 'pool routes were cooled before the delegate call');
  assert.equal(llm.calls.length, 2, 'no extra pool call after the delegate fallback');
});

test('fallback target falls back to agent.options when no request header exists', async () => {
  const llm = createFakeLlm({
    'p1/m1': { kind: 'fail' },
    'p1/m2': { kind: 'fail' },
  }, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  const config = twoModelConfig();
  const chain = new ModelChain(chainCtx(llm).ctx, config, store, {});
  const session = fakeSession(); // no requestHeader
  const [result] = await chain.run([chunkJob('chunk 1', 'text '.repeat(30))], { session, options: { provider: 'agent-p', model: 'agent-m' } }, undefined);
  assert.equal(result.fallback, true);
  assert.ok(result.text.includes('agent-p/agent-m'));
});

test('all tiers failed and fallback disabled -> batch throws', async () => {
  const llm = createFakeLlm({
    'p1/m1': { kind: 'fail' },
    'p1/m2': { kind: 'fail' },
  }, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  const config = twoModelConfig({ fallbackToSessionModel: false });
  const chain = new ModelChain(chainCtx(llm).ctx, config, store, {});
  await assert.rejects(
    chain.run([chunkJob('chunk 1', 'text '.repeat(30))], { session: fakeSession(), options: { provider: 'a', model: 'b' } }, undefined),
    /fallback is disabled/,
  );
});

test('merge jobs flow through the same chain', async () => {
  const llm = createFakeLlm({}, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  const chain = new ModelChain(chainCtx(llm).ctx, twoModelConfig(), store, {});
  const [result] = await chain.run([mergeJob(['digest one', 'digest two'])], { session: fakeSession() }, undefined);
  assert.ok(result.text.includes('p1/m'));
  assert.ok(result.text.includes('len='), 'merge input length reflected in digest');
});

test('capacity-blocked jobs wait and pick up a slot when a cooled model expires', async () => {
  const llm = createFakeLlm({}, { latencyMs: 120 });
  const timers = virtualTimers();
  const store = new MemoryCooldownStore();
  // Pre-cool m2 for 100 virtual ms so the third job must wait for its expiry.
  await store.applyCooldown('p1/m2', timers.now() + 100);
  const config = resolveConfig({
    tiers: [
      { name: 'primary', models: [
        { provider: 'p1', model: 'm1', maxConcurrent: 2, cooldown: { mode: 'duration', hours: 5 } },
        { provider: 'p1', model: 'm2', maxConcurrent: 2, cooldown: { mode: 'duration', hours: 5 } },
      ] },
    ],
  });
  const chain = new ModelChain(chainCtx(llm).ctx, config, store, { now: timers.now, sleep: timers.sleep });
  const jobs = Array.from({ length: 3 }, (_, index) => chunkJob(`chunk ${index}`, 'text '.repeat(20)));
  const run = chain.run(jobs, { session: fakeSession() }, undefined);
  // m1's two slots are occupied (latency 120ms); the third job waits.
  await sleep(60);
  assert.equal(llm.calls.filter((c) => c.model === 'm1').length, 2, 'm1 fills its two slots first');
  timers.advance(100); // expire m2's cooldown: the waiting job picks m2
  const results = await run;
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.text.length > 0));
  assert.equal(llm.calls.filter((c) => c.model === 'm1').length, 2, 'm1 never exceeded its cap');
  assert.equal(llm.calls.filter((c) => c.model === 'm2').length, 1, 'expired model picked up the waiting job');
});

test('a fully cooled pool collapses to the session-model fallback without spinning', async () => {
  const llm = createFakeLlm({
    'p1/m1': { kind: 'fail' },
    'p1/m2': { kind: 'fail' },
  }, { latencyMs: 5 });
  const timers = virtualTimers();
  const store = new MemoryCooldownStore();
  const config = twoModelConfig();
  const chain = new ModelChain(chainCtx(llm).ctx, config, store, { now: timers.now, sleep: timers.sleep });
  const [result] = await chain.run(
    [chunkJob('chunk 1', 'text '.repeat(30))],
    { session: fakeSession(), options: { provider: 'agent-p', model: 'agent-m' } },
    undefined,
  );
  assert.equal(result.fallback, true);
  assert.ok(result.text.includes('agent-p/agent-m'));
  // No busy loop: only the pool routes + one fallback call went out.
  assert.equal(llm.calls.length, 3, 'm1+m2 failures + one fallback only');
});

test('capacity-aware: a job too large for a small model is never dispatched there and is not cooled', async () => {
  const llm = createFakeLlm({}, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  // m1 has a 128K window; m2 only 4K. A 100K-token chunk fits m1 but not m2.
  const capacities = new Map([
    ['p1/m1', { contextWindow: 131072, maxTokens: 32768 }],
    ['p1/m2', { contextWindow: 4096, maxTokens: 4096 }],
  ]);
  const chain = new ModelChain(chainCtx(llm).ctx, twoModelConfig(), store, {}, capacities);
  const bigText = 'x'.repeat(100_000 * 4); // ~100K heuristic tokens
  const [result] = await chain.run([chunkJob('chunk huge', bigText)], { session: fakeSession() }, undefined, { capacities });
  assert.ok(result.text.length > 0);
  assert.equal(llm.calls.length, 1, 'exactly one call: m1 only');
  assert.equal(llm.calls[0].model, 'm1', 'big job went to the big model');
  assert.deepEqual(store.keys(), [], 'capacity mismatch is NOT a failure: no cooldown for m2');
});

test('capacity-aware: a task smaller than the smallest model still routes normally', async () => {
  const llm = createFakeLlm({}, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  const capacities = new Map([
    ['p1/m1', { contextWindow: 131072, maxTokens: 32768 }],
    ['p1/m2', { contextWindow: 4096, maxTokens: 4096 }],
  ]);
  const chain = new ModelChain(chainCtx(llm).ctx, twoModelConfig(), store, {}, capacities);
  // Small text: fits any model; round-robin to m1 first.
  const [result] = await chain.run([chunkJob('chunk tiny', 'tiny ') ], { session: fakeSession() }, undefined, { capacities });
  assert.ok(result.text.startsWith('digest('));
  assert.equal(llm.calls[0].model, 'm1');
  assert.deepEqual(store.keys(), [], 'no cooldown on success');
});

test('capacity-aware: unknown capacity is unconstrained (route never spuriously blocked)', async () => {
  const llm = createFakeLlm({}, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  // Map omits m1 (unknown) and says m2 fits nothing (window 1).
  const capacities = new Map([
    ['p1/m2', { contextWindow: 1, maxTokens: 1 }],
  ]);
  const chain = new ModelChain(chainCtx(llm).ctx, twoModelConfig(), store, {}, capacities);
  const [result] = await chain.run([chunkJob('chunk 1', 'text '.repeat(30))], { session: fakeSession() }, undefined, { capacities });
  assert.ok(result.text.length > 0, 'job completed on the unconstrained route');
  assert.equal(llm.calls.length, 1);
  assert.equal(store.keys().length, 0, 'no cooldown written');
});

test('capacity-aware: a chain without injected capacities resolves them lazily from the registry', async () => {
  const llm = createFakeLlm({}, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  // No capacities map: the chain must resolve via ctx.llm.resolveModelInfo
  // (fake returns a default 128K window for every route).
  const chain = new ModelChain(chainCtx(llm).ctx, twoModelConfig(), store, {});
  const [result] = await chain.run([chunkJob('chunk 1', 'text '.repeat(30))], { session: fakeSession() }, undefined);
  assert.ok(result.text.startsWith('digest('), 'lazy capacity resolution did not block dispatch');
  assert.equal(store.keys().length, 0);
});

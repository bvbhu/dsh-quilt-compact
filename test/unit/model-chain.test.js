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
          { provider: 'p1', model: 'm1', maxConcurrent: 1, cooldownHours: 5 },
          { provider: 'p1', model: 'm2', maxConcurrent: 1, cooldownHours: 5 },
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
        { provider: 'p1', model: 'm1', maxConcurrent: 1, cooldownHours: 5 },
        { provider: 'p1', model: 'm2', maxConcurrent: 1, cooldownHours: 5 },
      ] },
      { name: 'fallback-tier', models: [
        { provider: 'p2', model: 'm3', maxConcurrent: 1, cooldownHours: 5 },
      ] },
    ],
  });
  const chain = new ModelChain(chainCtx(llm).ctx, config, store, {});
  const [result] = await chain.run([chunkJob('chunk 1', 'text '.repeat(30))], { session: fakeSession() }, undefined);
  assert.ok(result.text.includes('p2/m3'), `expected degraded tier digest, got ${result.text}`);
  assert.ok(store.cooldownUntil('p1/m1') > 0 && store.cooldownUntil('p1/m2') > 0);
});

test('a route exactly rejected for capacity is remembered and the batch falls back', async () => {
  // The scheduler's heuristic (material estimate + fixed overhead) says the
  // task fits a 64K route, but the REAL request (material + instruction +
  // suffix, priced via estimateMessage) exceeds the window. startCall must
  // reject the route exactly, remember that rejection (task.capacityRejected),
  // and NOT re-select the same route for the same real request — otherwise a
  // single-route tier would loop forever picking and rejecting the same model.
  // The tier has no other candidate, so it degrades and the batch goes to the
  // session-model fallback.
  //
  // IMPORTANT: the window must be LARGE enough for the heuristic filter
  // (capacityFits: material + 512 overhead + output reservation) to pass —
  // with a tiny window the filter rejects in the scheduler and startCall's
  // exact path is never reached. A 64K window with a tiny heuristic estimate
  // passes the filter, while the real ~70K-token request exceeds it.
  const llm = createFakeLlm({}, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  const config = twoModelConfig({
    fallbackToSessionModel: true,
    tiers: [
      { name: 'primary', models: [
        { provider: 'p1', model: 'small', maxConcurrent: 1, cooldownHours: 5 },
      ] },
    ],
  });
  const capacities = new Map([
    ['p1/small', { contextWindow: 65536, maxTokens: 32768 }],
  ]);
  const chain = new ModelChain(chainCtx(llm).ctx, config, store, {}, capacities);
  const session = fakeSession({ provider: 'session-provider', model: 'session-model' });
  let delegated;
  const defaultSummarize = async (input, agent) => {
    delegated = { input, agent };
    return { summary: [{ type: 'text', text: 'SESSION FALLBACK DIGEST' }], provider: 'session-provider', model: 'session-model', maxTokens: 65536 };
  };
  const fallbackInput = { messages: [{ role: 'system', content: [{ type: 'text', text: 'sys' }] }] };
  // Heuristic material estimate stays small (meta.tokens=20), so capacityFits
  // says "fits" on the 64K window; the REAL chunk messages are ~70K tokens and
  // get exactly rejected at dispatch.
  const [result] = await chain.run(
    [chunkJob('chunk 1', 'x'.repeat(560_000), { tokens: 20 })],
    { session },
    undefined,
    { capacities, fallbackInput, defaultSummarize },
  );
  assert.equal(result.fallback, true, 'exact rejection of the only route must end in session fallback');
  assert.equal(result.text, 'SESSION FALLBACK DIGEST');
  assert.equal(delegated.input, fallbackInput);
  assert.equal(llm.calls.length, 0, 'the rejected pool route is never actually called');
  assert.deepEqual(store.keys(), [], 'capacity mismatch is not a model failure: no cooldown written');
});

test('an exactly rejected route never reappears while a fitting sibling in the same tier runs', async () => {
  // THE core behavior of route-level rejection: tier 0 has A (64K) and B
  // (128K); the heuristic estimate passes BOTH (tiny material), the REAL
  // request (~70K tokens) exceeds A but fits B. A must be rejected exactly and
  // NEVER re-picked (task.capacityRejected), B must run — without degrading
  // the whole tier and without writing a cooldown for A.
  const llm = createFakeLlm({}, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  const config = twoModelConfig({
    tiers: [
      { name: 'primary', models: [
        { provider: 'p1', model: 'small', maxConcurrent: 1, cooldownHours: 5 },
        { provider: 'p1', model: 'large', maxConcurrent: 1, cooldownHours: 5 },
      ] },
    ],
  });
  const capacities = new Map([
    ['p1/small', { contextWindow: 65536, maxTokens: 32768 }],
    ['p1/large', { contextWindow: 131072, maxTokens: 32768 }],
  ]);
  const chain = new ModelChain(chainCtx(llm).ctx, config, store, {}, capacities);
  const [result] = await chain.run(
    [chunkJob('chunk 1', 'x'.repeat(560_000), { tokens: 20 })],
    { session: fakeSession() },
    undefined,
    { capacities },
  );
  assert.ok(result.text.length > 0, 'job completes on the fitting route');
  const routes = llm.calls.map((call) => `${call.provider}/${call.model}`);
  assert.deepEqual(routes, ['p1/large'], 'small exactly rejected and never called; large ran instead');
  assert.equal(llm.calls.length, 1, 'exactly one pool call, no reject/retry loop');
  assert.equal(store.cooldownUntil('p1/small'), 0, 'exact rejection writes no cooldown (capacity mismatch is not a failure)');
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
        { provider: 'p1', model: 'm1', maxConcurrent: 1, cooldownHours: 5 },
        { provider: 'p1', model: 'm2', maxConcurrent: 1, cooldownHours: 5 },
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

test('a collapsed batch error names the failed routes and carries the attempts', async () => {
  const llm = createFakeLlm({
    'p1/m1': { kind: 'fail', message: 'quota' },
    'p1/m2': { kind: 'fail', message: 'down' },
  }, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  const config = twoModelConfig({ fallbackToSessionModel: false });
  const chain = new ModelChain(chainCtx(llm).ctx, config, store, {});
  await assert.rejects(
    chain.run([chunkJob('chunk 1', 'text '.repeat(30))], { session: fakeSession(), options: { provider: 'a', model: 'b' } }, undefined),
    (error) => {
      assert.match(error.message, /fallback is disabled; attempts: p1\/m1 x1 \(last: /, 'per-route failure summary follows the headline');
      assert.match(error.message, /p1\/m2 x1 \(last: /, 'every failed route is named');
      assert.ok(Array.isArray(error.attempts) && error.attempts.length === 2, 'structured attempts ride on the error');
      assert.equal(error.attempts[0].model, 'p1/m1');
      return true;
    },
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
        { provider: 'p1', model: 'm1', maxConcurrent: 2, cooldownHours: 5 },
        { provider: 'p1', model: 'm2', maxConcurrent: 2, cooldownHours: 5 },
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

test('effective maxTokens is clamped by remaining context capacity', async () => {
  const llm = createFakeLlm({}, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  // 64K model, ~40K-token material: the real request ALSO carries the chunk
  // instruction, so maxTokens = 65536 - (real message cost). The request must
  // NOT send the fixed 32768 (that would overflow the window).
  const capacities = new Map([
    ['p1/m1', { contextWindow: 65536, maxTokens: 32768 }],
    ['p1/m2', { contextWindow: 65536, maxTokens: 32768 }],
  ]);
  const chain = new ModelChain(chainCtx(llm).ctx, twoModelConfig(), store, {}, capacities);
  const bigText = 'x'.repeat(320_000); // ~40K tokens (8 chars/token)
  const [result] = await chain.run([chunkJob('chunk 1', bigText)], { session: fakeSession() }, undefined, { capacities });
  assert.ok(result.text.length > 0, 'job completes');
  assert.equal(llm.calls.length, 1, 'one call');
  // Priced against the REAL request messages (material + instruction), not a
  // material estimate plus a fixed prompt-overhead constant.
  const { messageTokens } = await import('../../lib/tokenizer.js');
  const actualInput = llm.calls[0].messages.reduce((sum, message) => sum + messageTokens(message), 0);
  assert.equal(llm.calls[0].maxTokens, 65536 - actualInput, 'maxTokens clamped to the remaining window after the real request cost');
  assert.ok(llm.calls[0].maxTokens < 32768, 'clamped below the fixed cap');
});

test('effective maxTokens respects the model defaultMaxTokens below the remaining window', async () => {
  const llm = createFakeLlm({}, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  // Model declares defaultMaxTokens = 8192 even though the window has room.
  const capacities = new Map([
    ['p1/m1', { contextWindow: 65536, maxTokens: 8192 }],
    ['p1/m2', { contextWindow: 65536, maxTokens: 8192 }],
  ]);
  const chain = new ModelChain(chainCtx(llm).ctx, twoModelConfig(), store, {}, capacities);
  const [result] = await chain.run([chunkJob('chunk 1', 'text '.repeat(30))], { session: fakeSession() }, undefined, { capacities });
  assert.ok(result.text.length > 0);
  assert.equal(llm.calls[0].maxTokens, 8192, 'model-declared output cap wins over the window math');
});

test('effective maxTokens falls back to the fixed cap for unknown capacity', async () => {
  const llm = createFakeLlm({}, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  // No capacity map: unknown windows cannot be clamped, so the fixed cap is sent.
  const chain = new ModelChain(chainCtx(llm).ctx, twoModelConfig(), store, {});
  await chain.run([chunkJob('chunk 1', 'text '.repeat(30))], { session: fakeSession() }, undefined);
  assert.equal(llm.calls[0].maxTokens, 32768, 'fixed cap when capacity is unknown');
});

test('an exact-rejected task waits for a busy sibling slot instead of spinning', async () => {
  // The concurrency edge from the 2a10bf6 review: A (64K) exactly rejects
  // both tasks (real ~70K request); B (128K, maxConcurrent=1) is the only
  // fitting route. Task 1 takes B's slot first; task 2 — after A's rejection —
  // must WAIT for B to free up, NOT loop the immediate-reschedule path. The
  // guard is that a busy slot means `running === true`, so the
  // needsImmediateReschedule continue is skipped and the scheduler awaits the
  // wake. A buggy guard (rescheduling while a sibling holds the slot) would
  // spin forever and never clear B's concurrency, so this test hangs instead
  // of passing.
  //
  // Timing is deterministic, not wall-clock-dependent: startCall sets
  // inFlight[B]=1 SYNCHRONOUSLY, so in the same pass task 2 sees B busy; task
  // 2 can only dispatch after task 1 settles and fires the wake. `latencyMs`
  // is kept small and identical to the other scheduler tests — the
  // peakConcurrency=1 assertion below is what actually pins the serialization.
  const llm = createFakeLlm({}, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  const config = twoModelConfig({
    tiers: [
      { name: 'primary', models: [
        { provider: 'p1', model: 'small', maxConcurrent: 1, cooldownHours: 5 },
        { provider: 'p1', model: 'large', maxConcurrent: 1, cooldownHours: 5 },
      ] },
    ],
  });
  const capacities = new Map([
    ['p1/small', { contextWindow: 65536, maxTokens: 32768 }],
    ['p1/large', { contextWindow: 131072, maxTokens: 32768 }],
  ]);
  const chain = new ModelChain(chainCtx(llm).ctx, config, store, {}, capacities);
  const bigText = 'x'.repeat(560_000); // ~70K tokens (8 chars/token): fits large, not small
  const results = await chain.run(
    [
      chunkJob('chunk 1', bigText, { tokens: 20 }),
      chunkJob('chunk 2', bigText, { tokens: 20 }),
    ],
    { session: fakeSession() },
    undefined,
    { capacities },
  );
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.text.length > 0), 'both tasks complete on the fitting route');
  const routeCalls = llm.calls.map((call) => call.model);
  assert.deepEqual(routeCalls, ['large', 'large'], 'small rejected for BOTH tasks; large runs both, serialized by maxConcurrent=1');
  assert.equal(llm.calls.filter((call) => call.model === 'small').length, 0, 'small never called');
  assert.equal(llm.peakConcurrency, 1, 'large stayed within its single slot');
  assert.equal(store.cooldownUntil('p1/small'), 0, 'exact rejection writes no cooldown');
});

test('an exact-rejected task survives a sibling failure: cooldown -> next tier', async () => {
  // The full edge from the 8a22d55 review: A (64K) exactly rejects both
  // ~70K tasks, B (128K, maxConcurrent=1) is the fitting sibling — but B
  // FAILS on its first call. The second task, which had been waiting on B's
  // busy slot, must then be woken by the failure, see B cooled, and fall
  // through to the next tier (C, 256K) — never re-trying B and never
  // deadlocking. This pins capacityRejected + maxConcurrent + cooldown +
  // wake + tier degradation working together.
  const llm = createFakeLlm({
    'p1/large': { kind: 'fail', code: 'RATE_LIMIT' },
  }, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  const config = twoModelConfig({
    tiers: [
      { name: 'primary', models: [
        { provider: 'p1', model: 'small', maxConcurrent: 1, cooldownHours: 5 },
        { provider: 'p1', model: 'large', maxConcurrent: 1, cooldownHours: 5 },
      ] },
      { name: 'second', models: [
        { provider: 'p2', model: 'huge', maxConcurrent: 1, cooldownHours: 5 },
      ] },
    ],
  });
  const capacities = new Map([
    ['p1/small', { contextWindow: 65536, maxTokens: 32768 }],
    ['p1/large', { contextWindow: 131072, maxTokens: 32768 }],
    ['p2/huge', { contextWindow: 262144, maxTokens: 32768 }],
  ]);
  const chain = new ModelChain(chainCtx(llm).ctx, config, store, {}, capacities);
  const bigText = 'x'.repeat(560_000); // ~70K tokens (8 chars/token): fits large+huge, not small
  const results = await chain.run(
    [
      chunkJob('chunk 1', bigText, { tokens: 20 }),
      chunkJob('chunk 2', bigText, { tokens: 20 }),
    ],
    { session: fakeSession() },
    undefined,
    { capacities },
  );
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.text.length > 0), 'both tasks complete via the next tier');
  const modelCalls = llm.calls.map((call) => call.model);
  assert.deepEqual(modelCalls, ['large', 'huge', 'huge'], 'one B failure cools it; both tasks then run on huge');
  assert.equal(llm.calls.filter((call) => call.model === 'small').length, 0, 'small never called (exact rejection)');
  assert.equal(llm.calls.filter((call) => call.model === 'large').length, 1, 'large fails exactly once then is skipped');
  assert.ok(store.cooldownUntil('p1/large') > 0, 'B failure writes a cooldown (unlike capacity rejection)');
  assert.equal(store.cooldownUntil('p1/small'), 0, 'capacity rejection still writes no cooldown');
});

test('split() re-prices each half instead of inheriting the parent token metadata', () => {
  // The P0: a half that keeps advertising the PARENT's token count can never be
  // routed to the model that motivated splitting it, and because the count never
  // shrinks, the "same tier cannot hold it -> split" rule can fire again on
  // ever-smaller text while the pending set doubles on every pass.
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index} ${'x'.repeat(60)}`);
  const parent = chunkJob('chunk 1', lines.join('\n'), { lineStart: 0, lineEnd: 40, tokens: 1000 }, 'p1/large', 200);
  const halves = parent.split();
  assert.equal(halves.length, 2, 'a multi-line chunk halves');
  for (const half of halves) {
    assert.ok(half.inputTokens < parent.inputTokens, `each half must be smaller than the parent (${half.inputTokens} vs ${parent.inputTokens})`);
  }
  assert.ok(
    halves[0].inputTokens + halves[1].inputTokens <= parent.inputTokens,
    `the halves must not add up to more than the parent (${halves[0].inputTokens + halves[1].inputTokens} > ${parent.inputTokens})`,
  );
  assert.deepEqual(
    halves.map((half) => [half.meta.lineStart, half.meta.lineEnd]),
    [[0, 20], [20, 40]],
    'each half reports its own line range',
  );
  assert.ok(halves.every((half) => half.meta.tokens < parent.meta.tokens), 'meta.tokens follows the half, not the parent');
  assert.ok(halves.every((half) => half.capTokens >= 1 && half.capTokens <= parent.capTokens));
  assert.ok(halves[0].capTokens + halves[1].capTokens <= parent.capTokens, 'the digest cap shrinks with the split');
});

test('a single-line chunk is not splittable: no empty sibling and no split loop', () => {
  const parent = chunkJob('chunk 1', 'one very long single line', { lineStart: 0, lineEnd: 1, tokens: 500 }, 'p1/large', 100);
  assert.equal(parent.split(), undefined, 'a one-line chunk cannot be halved');
});

test('a retry chunk its own tier cannot hold is split into halves the smaller model accepts', async () => {
  // small (64K) and large (128K) in ONE tier; the chunk was sliced for large and
  // is ~70K, so after large fails the tier has a healthy model (small) but
  // nothing that holds the task: it must SPLIT, and each half must carry its own
  // (~35K) count so small can serve it. With the parent's metadata inherited the
  // halves stay "70K", small is still rejected, and the region is lost to
  // degradation/fallback.
  const llm = createFakeLlm({ 'p1/large': { kind: 'fail', code: 'SERVER' } }, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  const config = twoModelConfig({
    fallbackToSessionModel: false,
    tiers: [
      { name: 'primary', models: [
        { provider: 'p1', model: 'small', maxConcurrent: 1, cooldownHours: 5 },
        { provider: 'p1', model: 'large', maxConcurrent: 1, cooldownHours: 5 },
      ] },
    ],
  });
  const capacities = new Map([
    ['p1/small', { contextWindow: 65536, maxTokens: 32768 }],
    ['p1/large', { contextWindow: 131072, maxTokens: 32768 }],
  ]);
  const chain = new ModelChain(chainCtx(llm).ctx, config, store, {}, capacities);
  const text = Array.from({ length: 40 }, (_, index) => `line ${index} ${'y'.repeat(60)}`).join('\n');
  const results = await chain.run(
    [chunkJob('chunk 1', text, { lineStart: 0, lineEnd: 40, tokens: 70000 }, 'p1/large', 4000)],
    { session: fakeSession() },
    undefined,
    { capacities },
  );
  assert.equal(results.length, 1, 'a split still yields exactly one result per input chunk');
  const [result] = results;
  assert.equal(result.splitInto, 2, 'the chunk digest is the join of its two halves');
  assert.deepEqual(result.models, ['p1/small'], 'both halves ran on the smaller model');
  const models = llm.calls.map((call) => call.model);
  assert.deepEqual(models, ['large', 'small', 'small'], `expected one large failure then both halves on small, got ${models.join(',')}`);
});

test('a chunk that cannot be split degrades instead of hanging the batch', async () => {
  // One line cannot be halved, so "same tier cannot hold it" has no split to
  // fall back on. The task must degrade (and the batch fall back) rather than
  // sitting in a state where nothing is running and nothing will fire the wake —
  // a hang here stalls the whole compaction.
  const llm = createFakeLlm({ 'p1/large': { kind: 'fail', code: 'SERVER' } }, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  const config = twoModelConfig({
    fallbackToSessionModel: false,
    tiers: [
      { name: 'primary', models: [
        { provider: 'p1', model: 'small', maxConcurrent: 1, cooldownHours: 5 },
        { provider: 'p1', model: 'large', maxConcurrent: 1, cooldownHours: 5 },
      ] },
    ],
  });
  const capacities = new Map([
    ['p1/small', { contextWindow: 65536, maxTokens: 32768 }],
    ['p1/large', { contextWindow: 131072, maxTokens: 32768 }],
  ]);
  const chain = new ModelChain(chainCtx(llm).ctx, config, store, {}, capacities);
  await assert.rejects(
    chain.run(
      [chunkJob('chunk 1', 'x'.repeat(1000), { lineStart: 0, lineEnd: 1, tokens: 70000 }, 'p1/large', 4000)],
      { session: fakeSession() },
      undefined,
      { capacities },
    ),
    /fallback is disabled/,
  );
  assert.equal(llm.calls.length, 1, 'the failing route is tried once, then the unsplittable chunk degrades');
});

test('a failed cooldown write still backs the route off in-process', async () => {
  // Provider error + storage I/O error: if the failed cooldown write left the
  // route "healthy", pickModel would re-select the route that just failed and
  // the batch would spin on it.
  const llm = createFakeLlm({ 'p1/m1': { kind: 'fail', code: 'SERVER', times: 2 } }, { latencyMs: 5 });
  const store = new MemoryCooldownStore();
  store.applyCooldown = async () => { throw new Error('storage offline'); };
  const chain = new ModelChain(chainCtx(llm).ctx, twoModelConfig(), store, {});
  const [result] = await chain.run([chunkJob('chunk 1', 'text '.repeat(30))], { session: fakeSession() }, undefined);
  const models = llm.calls.map((call) => call.model);
  assert.deepEqual(models, ['m1', 'm2'], `the failed route must not be re-dispatched, got ${models.join(',')}`);
  assert.ok(result.text.length > 0, 'the job still completes on the healthy sibling');
  assert.equal(chain.isRouteHealthy('p1/m1'), false, 'the route is quarantined locally even though the store write failed');
  assert.equal(store.cooldownUntil('p1/m1'), 0, 'nothing was persisted');
});

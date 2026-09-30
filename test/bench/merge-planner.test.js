/**
 * Single-level merge planner tests (v7).
 *
 * The merge is ONE call over ALL chunk digests, so the properties worth
 * pinning are:
 *
 * - `resolveMergeWindow` (DEFAULT, when `mergeMaxContextTokens` is unset) =
 *   max(128k floor, smallest known window in the pool; unknown routes join the
 *   min under the 256k default);
 * - the configured `mergeMaxContextTokens` (归并前最多保留多少上下文) sets the
 *   merge window EXACTLY — no floor, no pool derivation;
 * - `canHoldMerge` — some healthy pool route reaches the merge window; the
 *   merge reuses the MAIN tiers and descends them to find that route (no
 *   dedicated merge pool), else the engine falls back directly;
 * - proportional digest caps `cap_i = U × chunkTokens_i / T` keep
 *   `Σ cap_i ≤ usableInput(mergeWindow)`, so the single merge always fits.
 *
 * These are pure planner tests — no session, no engine, no model — so the
 * capacity property is verified at the unit level, exactly where it can be
 * pinned down cheaply and deterministically.
 *
 * @module dsh-quilt-compact/test/bench/merge-planner
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuiltCompactEngine } from '../../lib/index.js';
import { createTestContext } from '../helpers/fixture.js';
import {
  DEFAULT_CONTEXT_WINDOW,
  MERGE_WINDOW_FLOOR,
  resolveMergeWindow,
  computeUsableInputTokens,
} from '../../lib/budget.js';

/** One pool entry (window resolved through the fake llm). Models carry the
 * `key` that `resolveTiers` normally adds (`provider/model`). */
const POOL = [{ name: 'p', models: [{ provider: 'p', model: 'm', key: 'p/m', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 1 } }] }];

/** Build the merge window for a capacity map over the given tiers. */
function mergeWindowFor(capacities, tiers = POOL) {
  return resolveMergeWindow(capacities, tiers);
}

test('default merge window is max(128k, smallest known window in the pool)', () => {
  const capacities = new Map([
    ['p/m', { contextWindow: 200000, maxTokens: 32768 }],
  ]);
  const window = mergeWindowFor(capacities);
  assert.equal(window, 200000, 'window above the 128k floor wins');
});

test('default merge window clamps to the 128k floor when every pool window is smaller', () => {
  // A pool of small models cannot hold a 128k merge; the WINDOW still floors
  // at 128k (the budget the single merge would need) — and `canHoldMerge`
  // then answers false, so the engine falls back (§4). Setting
  // `mergeMaxContextTokens` below the floor is the knob that changes this.
  const capacities = new Map([
    ['p/m', { contextWindow: 3000, maxTokens: 32768 }],
  ]);
  assert.equal(mergeWindowFor(capacities), MERGE_WINDOW_FLOOR, 'floor applies');
});

test('unknown-capacity routes join the default min under the default window', () => {
  const capacities = new Map([['p/m', undefined]]);
  const window = mergeWindowFor(capacities);
  assert.equal(window, Math.max(MERGE_WINDOW_FLOOR, DEFAULT_CONTEXT_WINDOW), 'unknown -> default window in the min');
});

test('a configured mergeMaxContextTokens sets the merge window exactly (no floor)', async () => {
  // The knob replaces the pool-derived formula outright: 8000 wins even though
  // the default would floor at 128k (and even though the pool has a 1M model).
  const { ctx } = createTestContext({});
  const engine = new QuiltCompactEngine(ctx, {
    tiers: [{ name: 'p', models: [{ provider: 'p', model: 'm', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 1 } }] }],
    mergeMaxContextTokens: 8000,
  });
  const capacities = new Map([
    ['p/m', { contextWindow: 1048576, maxTokens: 32768 }],
  ]);
  assert.equal(engine.resolveMergeWindow(capacities), 8000, 'configured value wins exactly');
});

test('the default merge window derives from the whole main pool (merge descends tiers)', () => {
  // The merge reuses the main tiers: a tiny tier-0 model does NOT drag the
  // default below the floor, and the big tier-1 route is what the descent
  // finds. The min is taken over ALL tiers' routes.
  const tiers = [
    { name: 'small', models: [{ provider: 'p', model: 'small', key: 'p/small', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 1 } }] },
    { name: 'big', models: [{ provider: 'p', model: 'big', key: 'p/big', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 1 } }] },
  ];
  const capacities = new Map([
    ['p/small', { contextWindow: 3000, maxTokens: 32768 }],
    ['p/big', { contextWindow: 200000, maxTokens: 32768 }],
  ]);
  assert.equal(resolveMergeWindow(capacities, tiers), MERGE_WINDOW_FLOOR, 'tiny tier-0 does not lower the default below 128k');
});

test('proportional digest caps never exceed the merge usable input', () => {
  // cap_i = max(1, floor(U × tokens_i / T)); Σ cap_i <= U always, so the
  // single merge call's input budget is bounded regardless of chunk sizes.
  const mergeWindow = 200000;
  const U = computeUsableInputTokens(mergeWindow);
  const chunkTokens = [3000, 3000, 3000, 3000, 3000, 3000, 3000];
  const T = chunkTokens.reduce((sum, value) => sum + value, 0);
  const caps = chunkTokens.map((tokens) => Math.max(1, Math.floor(U * tokens / T)));
  const total = caps.reduce((sum, value) => sum + value, 0);
  assert.ok(total <= U, `Σ cap_i = ${total} must not exceed usable input ${U}`);
  assert.ok(caps.every((cap) => cap >= 1), 'every digest keeps a minimum cap');
});

test('canHoldMerge descends the main tiers to any route that reaches the window', async () => {
  // The merge chain is built over the MAIN tiers (like the engine's
  // `mergeChain`), so tier-0 small routes and tier-1 large routes are all
  // candidates: the merge descends until it finds a route with enough context.
  const { ctx } = createTestContext({});
  const engine = new QuiltCompactEngine(ctx, {
    tiers: [
      { name: 'small', models: [{ provider: 'p', model: 'small', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 1 } }] },
      { name: 'big', models: [{ provider: 'p', model: 'big', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 1 } }] },
    ],
  });
  const store = await engine.ensureStore();
  const { ModelChain } = await import('../../lib/model-chain.js');
  const capacities = new Map([
    ['p/small', { contextWindow: 3000, maxTokens: 32768 }],
    ['p/big', { contextWindow: 200000, maxTokens: 32768 }],
  ]);
  const chain = new ModelChain(ctx, engine.config, store, {}, capacities);
  assert.equal(chain.canHoldMerge(128000, capacities), true, 'the big tier-1 route holds the floor window');
  assert.equal(chain.canHoldMerge(300000, capacities), false, 'no route reaches 300k');
  // A cooled merge route no longer counts as able to hold the merge.
  await store.applyCooldown('p/big', Date.now() + 60_000);
  assert.equal(chain.canHoldMerge(128000, capacities), false, 'cooled route does not hold the merge');
});

test('the engine falls back directly when no route can hold the default window', async () => {
  // No `mergeMaxContextTokens` configured and the only route is a tiny model:
  // the default window floors at 128k, no route can hold it, so summarize must
  // take the session-model fallback path (fallbackReason 'no-merge-model')
  // instead of attempting a doomed merge.
  const { ctx, llm } = createTestContext({ contextWindow: 3000 });
  const engine = new QuiltCompactEngine(ctx, {
    tiers: [{ name: 'p', models: [{ provider: 'p', model: 'm', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 1 } }] }],
    fallbackToSessionModel: true,
  });
  const { buildSession, agentFor } = await import('../helpers/fixture.js');
  const session = buildSession(4, 'a multi-line region '.repeat(40)).session;
  const agent = agentFor(session, { provider: 'session-p', model: 'session-m' });
  const result = await engine.summarize(
    { messages: [{ role: 'user', content: [{ type: 'text', text: 'line '.repeat(2000) }] }] },
    agent,
    undefined,
  );
  assert.equal(result.fallback, true, 'must fall back, never a doomed single-level merge');
  assert.equal(result.chainStats.mergeLevels, 0, 'no merge level completed');
  // The pool route never saw a merge call (the tiny window would reject it).
  const mergeCalls = llm.calls.filter((call) => call.purpose === 'compaction' && String(call.messages[0]?.content?.[0]?.text).startsWith('--- digest 1 ---'));
  assert.equal(mergeCalls.length, 0, 'no single-level merge dispatched to the tiny-window pool');
});

test('mergeMaxContextTokens lets a tiny pool actually run the merge', async () => {
  // The knob removes the 128k floor: with mergeMaxContextTokens: 2000 the
  // single-level merge window is 2000, the 3000-window route holds it, and the
  // same tiny pool that fell back above now completes a real merge.
  const { ctx, llm } = createTestContext({ contextWindow: 3000 });
  const engine = new QuiltCompactEngine(ctx, {
    tiers: [{ name: 'p', models: [{ provider: 'p', model: 'm', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 1 } }] }],
    mergeMaxContextTokens: 2000,
  });
  const { buildSession, agentFor } = await import('../helpers/fixture.js');
  const session = buildSession(4, 'a multi-line region '.repeat(40)).session;
  const agent = agentFor(session, { provider: 'session-p', model: 'session-m' });
  const result = await engine.summarize(
    { messages: [{ role: 'user', content: [{ type: 'text', text: 'line '.repeat(2000) }] }] },
    agent,
    undefined,
  );
  assert.equal(result.fallback, false, 'a configured window makes the merge runnable');
  assert.equal(result.chainStats.mergeLevels, 1, 'single-level merge completed');
  const mergeCalls = llm.calls.filter((call) => call.purpose === 'compaction' && String(call.messages[0]?.content?.[0]?.text).startsWith('--- digest 1 ---'));
  assert.equal(mergeCalls.length, 1, 'exactly one merge call on the small pool');
});

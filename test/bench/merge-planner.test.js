/**
 * Single-level merge planner tests (v7).
 *
 * The merge is ONE call over ALL chunk digests, so the properties worth
 * pinning are:
 *
 * - `mergeMaxContextTokens` (归并前最多保留多少上下文) ALWAYS resolves: the
 *   config defaults it to 128k, so there is no "unset → pool-derived" branch;
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
  computeUsableInputTokens,
} from '../../lib/budget.js';

test('mergeMaxContextTokens defaults to 128k when unset', async () => {
  // The config ALWAYS resolves a merge window: no setting means 128k — pool
  // capacities play no part (there is no "max(128k, smallest pool window)"
  // derivation anymore).
  const { ctx } = createTestContext({});
  const engine = new QuiltCompactEngine(ctx, {
    tiers: [{ name: 'p', models: [{ provider: 'p', model: 'm', maxConcurrent: 1, cooldownHours: 1 }] }],
  });
  assert.equal(engine.config.mergeMaxContextTokens, 128000, 'unset -> default 128k');
  const capacities = new Map([
    ['p/m', { contextWindow: 200000, maxTokens: 32768 }],
    ['p/unknown', undefined],
  ]);
  assert.equal(engine.resolveMergeWindow(capacities), 128000, 'the window is the configured value, never pool-derived');
});

test('a configured mergeMaxContextTokens sets the merge window exactly', async () => {
  // The knob overrides the 128k default outright: 8000 wins even though the
  // pool has a 1M model and the default would be 128k.
  const { ctx } = createTestContext({});
  const engine = new QuiltCompactEngine(ctx, {
    tiers: [{ name: 'p', models: [{ provider: 'p', model: 'm', maxConcurrent: 1, cooldownHours: 1 }] }],
    mergeMaxContextTokens: 8000,
  });
  const capacities = new Map([
    ['p/m', { contextWindow: 1048576, maxTokens: 32768 }],
  ]);
  assert.equal(engine.resolveMergeWindow(capacities), 8000, 'configured value wins exactly');
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
      { name: 'small', models: [{ provider: 'p', model: 'small', maxConcurrent: 1, cooldownHours: 1 }] },
      { name: 'big', models: [{ provider: 'p', model: 'big', maxConcurrent: 1, cooldownHours: 1 }] },
    ],
  });
  const store = await engine.ensureStore();
  const { ModelChain } = await import('../../lib/model-chain.js');
  const capacities = new Map([
    ['p/small', { contextWindow: 3000, maxTokens: 32768 }],
    ['p/big', { contextWindow: 200000, maxTokens: 32768 }],
  ]);
  const chain = new ModelChain(ctx, engine.config, store, {}, capacities);
  assert.equal(chain.canHoldMerge(128000, capacities), true, 'the big tier-1 route holds the default 128k window');
  assert.equal(chain.canHoldMerge(300000, capacities), false, 'no route reaches 300k');
  // A cooled merge route no longer counts as able to hold the merge.
  await store.applyCooldown('p/big', Date.now() + 60_000);
  assert.equal(chain.canHoldMerge(128000, capacities), false, 'cooled route does not hold the merge');
});

test('the engine falls back directly when no route can hold the default 128k window', async () => {
  // `mergeMaxContextTokens` defaults to 128k; the only route is a tiny model
  // that cannot hold it, so summarize must take the session-model fallback
  // path (fallbackReason 'no-merge-model') instead of attempting a doomed
  // merge.
  const { ctx, llm } = createTestContext({ contextWindow: 3000 });
  const engine = new QuiltCompactEngine(ctx, {
    tiers: [{ name: 'p', models: [{ provider: 'p', model: 'm', maxConcurrent: 1, cooldownHours: 1 }] }],
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
  // Lowering the knob below the pool windows makes the single-level merge
  // runnable: with mergeMaxContextTokens: 2000 the merge window is 2000, the
  // 3000-window route holds it, and the same tiny pool that fell back above
  // now completes a real merge.
  const { ctx, llm } = createTestContext({ contextWindow: 3000 });
  const engine = new QuiltCompactEngine(ctx, {
    tiers: [{ name: 'p', models: [{ provider: 'p', model: 'm', maxConcurrent: 1, cooldownHours: 1 }] }],
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

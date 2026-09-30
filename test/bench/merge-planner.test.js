/**
 * Merge-planner unit tests: every bucket must respect the input budget.
 *
 * The old planner derived a fixed `bucketSize = budget / average` from the
 * mean digest size, which a skewed distribution defeats: with `900,100,100,100,
 * 100` and budget 1000 the average is 200, so the old code packed a 1300-token
 * first bucket. The planner now sums ACTUAL digest tokens greedily, so each
 * bucket fits unless one digest is oversized on its own.
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

/** A planner instance needs only an engine (the method is stateless). */
function planner() {
  const { ctx } = createTestContext({});
  return new QuiltCompactEngine(ctx, {
    tiers: [{ name: 'p', models: [{ provider: 'p', model: 'm', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 1 } }] }],
  });
}

/** Build digest entries `[{ text, tokens }]` from token values. */
function entries(...tokens) {
  return tokens.map((tokensValue, index) => ({ text: `digest-${index}`, tokens: tokensValue }));
}

test('packMergeBuckets keeps every bucket within the token budget', () => {
  const engine = planner();
  const buckets = engine.packMergeBuckets(entries(900, 100, 100, 100, 100), 1000);
  // The 900-token digest fits exactly one 100-token sibling (900+100=1000), so
  // the first bucket is 1000; the three remaining 100s fit together. The OLD
  // average-based planner (mean 200 -> bucketSize 5) packed 900+100*4=1300.
  assert.deepEqual(
    buckets.map((bucket) => bucket.reduce((sum, entry) => sum + entry.tokens, 0)),
    [1000, 300],
    'each bucket stays within budget, no oversized bucket',
  );
});

test('packMergeBuckets packs evenly sized digests densely', () => {
  const engine = planner();
  const buckets = engine.packMergeBuckets(entries(100, 100, 100, 100, 100, 100, 100), 300);
  assert.ok(buckets.every((bucket) => bucket.reduce((sum, entry) => sum + entry.tokens, 0) <= 300));
  // 7 digests of 100 under budget 300: two 3-buckets + a stray 1-digest tail.
  // The PACKER allows the stray; mergeLevelShrinks() is what rejects the level
  // and collapses it to fallback (a 1-digest merge is a no-op that would stall
  // the hierarchy). See mergeLevelShrinks tests below.
  assert.deepEqual(
    buckets.map((bucket) => bucket.length),
    [3, 3, 1],
  );
});

test('packMergeBuckets keeps document order within a bucket', () => {
  const engine = planner();
  const input = entries(50, 200, 50, 200, 50);
  const buckets = engine.packMergeBuckets(input, 300);
  const flat = buckets.flat().map((entry) => entry.text);
  assert.deepEqual(flat, input.map((entry) => entry.text), 'packing must not reorder digests');
});

test('packMergeBuckets leaves a lone oversized digest as its own bucket', () => {
  const engine = planner();
  const buckets = engine.packMergeBuckets(entries(1200, 100, 100), 1000);
  assert.deepEqual(
    buckets.map((bucket) => bucket.reduce((sum, entry) => sum + entry.tokens, 0)),
    [1200, 200],
    'the oversized digest is alone; the two small ones share a fitting bucket',
  );
});

test('mergeDigests routes a lone oversized digest to fallback, never a giant merge', async () => {
  // One digest exceeds the whole merge budget: merging it with anything only
  // re-creates an oversized request. The planner must collapse to the
  // session-model fallback instead of producing an over-budget merge call.
  const { ctx, llm } = createTestContext({
    behaviors: { 'bench/digest': { kind: 'fail', code: 'RATE_LIMIT' } },
  });
  const engine = new QuiltCompactEngine(ctx, {
    tiers: [{ name: 'primary', models: [{ provider: 'bench', model: 'digest', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 5 } }] }],
    fallbackToSessionModel: true,
  });
  const store = await engine.ensureStore();
  const { ModelChain } = await import('../../lib/model-chain.js');
  const { buildSession, agentFor } = await import('../helpers/fixture.js');
  const chain = new ModelChain(ctx, engine.config, store, {});
  const agent = agentFor(buildSession(2).session, { provider: 'session-p', model: 'session-m' });
  const big = 'BIG '.repeat(1000); // ~4000 chars -> ~1000 tokens
  const result = await engine.mergeDigests(
    chain,
    [big, 'small digest', 'another small digest'],
    agent,
    undefined,
    // The fallback needs the same wiring the engine always provides in
    // production: the original region input and a direct summarizer.
    {
      capacities: new Map(),
      fallbackInput: { messages: [{ role: 'user', content: [{ type: 'text', text: big }] }] },
      defaultSummarize: async (input, owner) => ({
        summary: [{ type: 'text', text: `fallback(${input.messages[0].content[0].text.length})` }],
        provider: 'session-p',
        model: 'session-m',
        usage: undefined,
      }),
    },
    1200,
  );
  assert.ok(result.fallback === true, 'oversized digest must take the fallback path');
  // The fallback ran exactly once, directly against the fallbackInput, instead
  // of a doomed over-budget merge on the cooled pool route.
  const fallbackCalls = llm.calls.filter((call) => call.provider === 'session-p');
  assert.equal(fallbackCalls.length, 0, 'default-plugin fallback bypasses the pool llm entirely');
  assert.match(result.text, /^fallback\(/, 'the fallback summarizer produced the result');
});

test('mergeDigests throws when fallback is disabled and a digest is oversized', async () => {
  const { ctx } = createTestContext({});
  const engine = new QuiltCompactEngine(ctx, {
    tiers: [{ name: 'primary', models: [{ provider: 'bench', model: 'digest', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 5 } }] }],
    fallbackToSessionModel: false,
  });
  const store = await engine.ensureStore();
  const { ModelChain } = await import('../../lib/model-chain.js');
  const { buildSession, agentFor } = await import('../helpers/fixture.js');
  const chain = new ModelChain(ctx, engine.config, store, {});
  const agent = agentFor(buildSession(2).session);
  const big = 'BIG '.repeat(1000);
  await assert.rejects(
    engine.mergeDigests(chain, [big, 'small'], agent, undefined, { capacities: new Map() }, 1200),
    /digest exceeds the merge input budget \(or has no mergeable partner\) and session-model fallback is disabled/,
  );
});

test('mergeDigests terminates (via fallback) when two digests cannot share one bucket', async () => {
  // THE termination regression from the review: with `[100,100]` and budget
  // 150 the greedy packer yields `[[100],[100]]` — two singleton buckets, no
  // multi-digest merge, and (before the shrink guard) the hierarchy would loop
  // forever. mergeLevelShrinks() must collapse the level to fallback instead
  // of issuing singleton merge jobs.
  const { ctx, llm } = createTestContext({});
  const engine = new QuiltCompactEngine(ctx, {
    tiers: [{ name: 'primary', models: [{ provider: 'bench', model: 'digest', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 5 } }] }],
    fallbackToSessionModel: true,
  });
  const store = await engine.ensureStore();
  const { ModelChain } = await import('../../lib/model-chain.js');
  const { buildSession, agentFor } = await import('../helpers/fixture.js');
  const chain = new ModelChain(ctx, engine.config, store, {});
  const agent = agentFor(buildSession(2).session, { provider: 'session-p', model: 'session-m' });
  // Two digests of ~1200 chars -> ~300 tokens each; budget 150 forces each into
  // its own bucket.
  const smallA = 'A '.repeat(600);
  const smallB = 'B '.repeat(600);
  const result = await engine.mergeDigests(
    chain,
    [smallA, smallB],
    agent,
    undefined,
    {
      capacities: new Map(),
      fallbackInput: { messages: [{ role: 'user', content: [{ type: 'text', text: smallA }] }] },
      defaultSummarize: async (input) => ({
        summary: [{ type: 'text', text: `fallback(${input.messages[0].content[0].text.length})` }],
        provider: 'session-p',
        model: 'session-m',
        usage: undefined,
      }),
    },
    150,
  );
  assert.ok(result.fallback === true, 'unmergeable pair must take the fallback path, not loop');
  assert.match(result.text, /^fallback\(/, 'the fallback summarizer produced the result');
  // No singleton merge job was ever sent: the only pool call would have been a
  // doomed singleton merge; the fallback bypasses the pool llm entirely.
  const poolCalls = llm.calls.filter((call) => call.provider === 'bench');
  assert.equal(poolCalls.length, 0, 'no over-budget or singleton merge dispatched to the pool');
});

test('mergeLevelShrinks rejects stray and oversized singletons alike', () => {
  const engine = planner();
  assert.equal(engine.mergeLevelShrinks([[{ text: 'a', tokens: 100 }, { text: 'b', tokens: 50 }]]), true, 'one multi-digest bucket shrinks');
  assert.equal(engine.mergeLevelShrinks([[{ text: 'a', tokens: 100 }], [{ text: 'b', tokens: 50 }, { text: 'c', tokens: 50 }]]), false, 'a stray singleton blocks shrink');
  assert.equal(engine.mergeLevelShrinks([[{ text: 'a', tokens: 1200 }], [{ text: 'b', tokens: 50 }, { text: 'c', tokens: 50 }]]), false, 'an oversized singleton blocks shrink');
  assert.equal(engine.mergeLevelShrinks([[{ text: 'a', tokens: 100 }, { text: 'b', tokens: 50 }], [{ text: 'c', tokens: 30 }, { text: 'd', tokens: 40 }]]), true, 'all multi-digest buckets shrink');
});

test('mergeLevelShrinks returns false for an all-singleton level (would otherwise loop)', () => {
  const engine = planner();
  const level = engine.packMergeBuckets(entries(100, 100), 150);
  assert.deepEqual(level.map((bucket) => bucket.length), [1, 1], 'the packer yields two singletons');
  assert.equal(engine.mergeLevelShrinks(level), false, 'an all-singleton level must not shrink through merging');
});

test('packMergeBuckets packs uneven digests into multi-digest buckets when possible', () => {
  const engine = planner();
  // The review's second scenario: a re-grouping must avoid a singleton tail.
  // 50+100=150 fits; the second 50+100=150 fits; no singleton remains.
  const buckets = engine.packMergeBuckets(entries(50, 100, 50, 100), 150);
  assert.ok(buckets.every((bucket) => bucket.length >= 2), `no singleton tail, got ${buckets.map((b) => b.length)}`);
  assert.deepEqual(buckets.map((bucket) => bucket.reduce((sum, entry) => sum + entry.tokens, 0)), [150, 150]);
});

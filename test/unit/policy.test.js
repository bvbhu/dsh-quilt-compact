/**
 * Policy parity: the automatic-compaction policy must track
 * `dsh-compaction-basic`'s own defaults, and the model-capacity fallbacks must
 * match `dsh-llm`'s unconfigured-model assumptions.
 *
 * Replacing the `compaction` service must not silently change WHEN the harness
 * decides to compact, so this suite reads the real upstream values from a live
 * `BasicCompactionEngine` instead of duplicating them as literals. If upstream
 * retunes a default, this test fails here rather than drifting.
 *
 * @module dsh-quilt-compact/test/unit/policy
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';
import { readBasicPolicy } from '../../lib/default-compression.js';
import { DEFAULT_CONTEXT_WINDOW } from '../../lib/engine.js';
import { DEFAULT_MAX_TOKENS } from '../../lib/summarize.js';

/** Resolved defaults of a real basic engine (auto: false — no listeners). */
function basicDefaults() {
  const ctx = new Context();
  return new BasicCompactionEngine(ctx, { auto: false }).config;
}

test('readBasicPolicy mirrors dsh-compaction-basic defaults', () => {
  const basic = basicDefaults();
  const policy = readBasicPolicy();
  assert.equal(policy.thresholdRatio, basic.thresholdRatio);
  assert.equal(policy.retainRatio, basic.retainRatio);
  assert.equal(policy.headroomTokens, basic.headroomTokens);
  assert.equal(policy.compactionRetries, basic.compactionRetries);
  assert.equal(policy.maxOverflowRetries, basic.maxOverflowRetries);
});

test('basic defaults are still the values this plugin was tuned against', () => {
  // Guard against upstream changing in a way the parity assertion above would
  // silently ratify: pin the expected values too.
  const basic = basicDefaults();
  assert.equal(basic.thresholdRatio, 0.8);
  assert.equal(basic.retainRatio, 0.16);
  assert.equal(basic.headroomTokens, 65536);
  assert.equal(basic.compactionRetries, 1);
  assert.equal(basic.maxOverflowRetries, 1);
});

test('readBasicPolicy is cached and immutable', () => {
  const first = readBasicPolicy();
  assert.equal(readBasicPolicy(), first, 'policy must be cached, not rebuilt');
  assert.ok(Object.isFrozen(first), 'policy must be frozen');
});

test('DEFAULT_MAX_TOKENS uses the dsh-llm unconfigured-model output assumption', () => {
  // dsh-llm-pi-ai: DEFAULT_MAX_TOKENS = 32768 for a model neither
  // configuration nor the catalog sizes. Still a bounded local cap, but large
  // enough that a dense region digest is not truncated.
  assert.equal(DEFAULT_MAX_TOKENS, 32768);
});

test('DEFAULT_CONTEXT_WINDOW uses the dsh-llm unconfigured-model context assumption', () => {
  // dsh-llm-pi-ai: DEFAULT_CONTEXT_WINDOW = 262144 (256k).
  assert.equal(DEFAULT_CONTEXT_WINDOW, 262144);
});

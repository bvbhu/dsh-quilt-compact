/**
 * End-to-end check that a VOLATILE Config still yields a correct engine config.
 *
 * cordis hands the plugin the resolved schema output, where every `.volatile()`
 * field is a `{ get(), [write] }` reference. The engine must unwrap those, or
 * `resolveConfig` would read an object where it expects a number. The unit
 * tests pass plain objects, so only a real container exercises this path.
 */
import { Context } from '@deepseek-ai/cordis';
import assert from 'node:assert/strict';
import QuiltCompactEngine, { Config } from '../../lib/index.js';

const ctx = new Context();
ctx.provide('llm', { async stream() {} });
ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 0, nodes: [] }) });
ctx.provide('sessions', { async flush() {} });

const raw = {
  chunkRatio: 0.55,
  chunkOverlapRatio: 0.2,
  fallbackToSessionModel: false,
  chunkPromptSuffix: 'SUFFIX',
  mergePromptSuffix: 'MERGE',
  tiers: [{ name: 'primary', models: [{ provider: 'p1', model: 'm1', maxConcurrent: 2, cooldown: { mode: 'duration', hours: 3 } }] }],
  preprocessing: { dedup: false, purgeErrors: true },
};

// What cordis actually delivers to the constructor.
const resolved = Config(raw);
console.log('resolved chunkRatio is a reference?', typeof resolved.chunkRatio?.get === 'function');
console.log('resolved tiers is a reference?', typeof resolved.tiers?.get === 'function');

ctx.plugin(QuiltCompactEngine, raw);
await new Promise((r) => setImmediate(r));
await new Promise((r) => setImmediate(r));

const engine = ctx.compaction;
assert.ok(engine, 'engine mounted');
const c = engine.config;

// Every value must be a plain, unwrapped value.
assert.equal(c.chunkRatio, 0.55, 'chunkRatio unwrapped');
assert.equal(c.chunkOverlapRatio, 0.2);
assert.equal(c.fallbackToSessionModel, false);
assert.equal(c.chunkPromptSuffix, 'SUFFIX');
assert.equal(c.mergePromptSuffix, 'MERGE');
assert.ok(Array.isArray(c.tiers), 'tiers is a plain array');
assert.equal(c.tiers[0].models[0].maxConcurrent, 2);
assert.equal(c.tiers[0].models[0].cooldown.hours, 3);
assert.equal(c.preprocessing.dedup, false);
assert.equal(c.preprocessing.purgeErrors, true);
// Defaults must still apply to fields the user omitted. `headMiddleTail` was
// removed from the config surface entirely; the chunker owns length control.
assert.equal(c.preprocessing.logCondense.mode, 'balanced');

console.log('\nVOLATILE-CONFIG OK: engine.config is fully unwrapped and defaults still apply');

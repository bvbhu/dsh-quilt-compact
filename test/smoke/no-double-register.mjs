/**
 * Regression check: the plugin constructs `BasicCompactionEngine` internally in
 * two places (createDefaultCompression for the session-model fallback, and
 * readBasicPolicy for the automatic-pressure policy). Both MUST land their
 * `compaction` service registration on a throwaway context — if either
 * registered on the live context, mounting this plugin would fail with
 * 'service "compaction" has been registered at <BasicCompactionEngine>'.
 *
 * The existing smoke test never exercises the fallback path, so this closes
 * that gap.
 */
import { Context } from '@deepseek-ai/cordis';
import assert from 'node:assert/strict';
import { readBasicPolicy, createDefaultCompression } from '../../lib/default-compression.js';
import QuiltCompactEngine from '../../lib/index.js';

// 1. readBasicPolicy() must not register anything on a live context.
const live = new Context();
live.provide('llm', { async stream() {} });
live.provide('tokenMeter', { measure: () => ({ totalTokens: 0, nodes: [] }) });
live.provide('sessions', { async flush() {} });

const policy = readBasicPolicy();
assert.equal(policy.thresholdRatio, 0.8);
assert.equal(live.compaction, undefined, 'readBasicPolicy must not register compaction on the live context');

// 2. Mount the chain engine — this must succeed on a context where nothing else
//    has claimed `compaction`.
live.plugin(QuiltCompactEngine, {
  tiers: [{ name: 'primary', models: [{ provider: 'p1', model: 'm1', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 5 } }] }],
});
await new Promise((r) => setImmediate(r));
assert.ok(live.compaction instanceof QuiltCompactEngine, 'the chain engine owns ctx.compaction');

// 3. The fallback facade must be constructible AFTER the chain owns the
//    service — this is the path that runs during a real cooled-pool fallback.
const facade = createDefaultCompression(live);
assert.ok(facade, 'fallback facade constructed');
assert.ok(live.compaction instanceof QuiltCompactEngine, 'the chain engine still owns ctx.compaction after building the fallback facade');
assert.notEqual(live.compaction, facade, 'the facade did not hijack the service slot');

// 4. And the facade really is usable: its own ctx points at the live one.
assert.equal(facade.ctx, live, 'facade redirected to the live context for llm access');
assert.equal(typeof facade.summarize, 'function');

console.log('NO-DOUBLE-REGISTER OK: readBasicPolicy + fallback facade both stay off the live compaction slot');

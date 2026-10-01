/**
 * Regression check: the plugin constructs `BasicCompactionEngine` internally
 * for the automatic-pressure policy (readBasicPolicy). It MUST land that
 * `compaction` service registration on a throwaway context — if it registered
 * on the live context, mounting this plugin would fail with
 * 'service "compaction" has been registered at <BasicCompactionEngine>'.
 *
 * The session-model fallback no longer builds a BasicCompactionEngine facade:
 * it is implemented directly on the engine (`fallbackSummarize`), so this also
 * asserts the engine exposes it and that exercising it does not touch the
 * `compaction` service slot.
 */
import { Context } from '@deepseek-ai/cordis';
import assert from 'node:assert/strict';
import { readBasicPolicy } from '../../lib/default-compression.js';
import QuiltCompactEngine from '../../lib/index.js';

// 1. readBasicPolicy() must not register anything on a live context.
const live = new Context();
const llmCalls = [];
live.provide('llm', {
  async *stream(options) {
    llmCalls.push(options);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'fallback digest' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fallback digest' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
});
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
const engine = live.compaction;
assert.ok(engine instanceof QuiltCompactEngine, 'the chain engine owns ctx.compaction');

// 3. The direct fallback summarizer is the only fallback path — it must be a
//    method on the engine and must not touch the `compaction` slot.
assert.equal(typeof engine.fallbackSummarize, 'function', 'fallbackSummarize is the direct session-model fallback');

const { session } = { session: { id: 's-fallback', requestHeader: () => undefined } };
const agent = { session, options: { provider: 'session-p', model: 'session-m' } };
const result = await engine.fallbackSummarize(
  { messages: [{ role: 'system', content: [{ type: 'text', text: 'sys' }] }] },
  agent,
  undefined,
);
assert.equal(result.provider, 'session-p', 'fallback routes to the agent options target');
assert.equal(llmCalls.length, 1, 'fallback is exactly one llm call');
assert.equal(llmCalls[0].messages[0].role, 'system', 'fallback replays the conversation prefix');
assert.equal(llmCalls[0].messages.at(-1).role, 'user', 'instruction is the final user message');
assert.ok(live.compaction instanceof QuiltCompactEngine, 'the chain engine still owns ctx.compaction after the fallback ran');
console.log('NO-DOUBLE-REGISTER OK: readBasicPolicy + the direct fallback both stay off the live compaction slot');

/**
 * Regression check: the plugin reuses the OFFICIAL `dsh-compaction-basic`
 * engine (`BasicCompactionEngine`) for the session-model fallback
 * (`summarize`) and the automatic-pressure policy (`config`). The Service
 * constructor registers its instance under `compaction` on the context it is
 * given — the engine hands it `ctx.isolate('compaction')`, a throwaway child
 * scope, so that registration must NEVER shadow the plugin's own `compaction`
 * slot (otherwise mounting would fail with
 * 'service "compaction" has been registered at <BasicCompactionEngine>').
 *
 * It also validates the earlier production failure mode: the basic instance
 * must resolve `llm` through the SAME live fiber chain (no ctx redirection —
 * the old redirected-ctx facade threw `cannot get property "llm" without
 * inject` under loader realm mounting). The fallback call below goes through
 * `basicFallback.summarize` on the live context and must actually stream.
 */
import { Context } from '@deepseek-ai/cordis';
import assert from 'node:assert/strict';
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';
import QuiltCompactEngine from '../../lib/index.js';

// 1. Mount the chain engine — this must succeed and own `compaction`.
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

live.plugin(QuiltCompactEngine, {
  tiers: [{ name: 'primary', models: [{ provider: 'p1', model: 'm1', maxConcurrent: 1, cooldownHours: 5 }] }],
});
await new Promise((r) => setImmediate(r));
const engine = live.compaction;
assert.ok(engine instanceof QuiltCompactEngine, 'the chain engine owns ctx.compaction');

// 2. The fallback delegates to the official basic engine instance.
assert.ok(engine.basicFallback instanceof BasicCompactionEngine, 'fallback delegates to BasicCompactionEngine');
assert.equal(engine.basicFallback.config.auto, false, 'no automatic listeners from the internal instance');
assert.equal(engine.basicFallback.config.maxTokens, 32768, 'the fallback cap matches DEFAULT_MAX_TOKENS');

// 3. Exercising the fallback must resolve llm through the live context (the
//    isolated child inherits the same fiber chain) — and must not steal the
//    `compaction` slot.
const session = { id: 's-fallback', requestHeader: () => undefined };
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
assert.match(
  String(llmCalls[0].messages.at(-1).content[0].text),
  /^You are now acting as a compaction engine/,
  'the instruction is dsh-compaction-basic\'s own, not a re-implemented copy',
);
assert.ok(live.compaction instanceof QuiltCompactEngine, 'the chain engine still owns ctx.compaction after the fallback ran');

// 4. The pressure policy is read from the same live instance's config.
assert.equal(engine.basicFallback.config.thresholdRatio, 0.8, 'policy comes from the live basic config');
console.log('NO-DOUBLE-REGISTER OK: basic delegation resolves llm on the live context and stays off the compaction slot');

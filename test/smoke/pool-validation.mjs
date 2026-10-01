/**
 * End-to-end check that the engine validates its model pool against the live
 * registry, warns about unusable routes, and re-checks on a live config edit.
 */
import { Context } from '@deepseek-ai/cordis';
import assert from 'node:assert/strict';
import QuiltCompactEngine from '../../lib/index.js';

/** A context whose llm registry advertises exactly `catalog`. */
function makeCtx(catalog, log) {
  const ctx = new Context();
  ctx.logger = {
    info: (...a) => log.push(['info', a.join(' ')]),
    warn: (...a) => log.push(['warn', a.join(' ')]),
    error: (...a) => log.push(['error', a.join(' ')]),
    debug: () => {},
  };
  ctx.provide('llm', {
    listProviders: () => Object.keys(catalog).map((id) => ({ id, name: id })),
    listModels: async (p) => (catalog[p] ?? []).map((id) => ({ provider: p, id, name: id })),
    async stream() { throw new Error('unused'); },
  });
  ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 0, nodes: [] }) });
  ctx.provide('sessions', { async flush() {} });
  return ctx;
}

const drain = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };

// --- 1. a fully resolvable pool validates ---------------------------------
{
  const log = [];
  const ctx = makeCtx({ alpha: ['m1', 'm2'] }, log);
  ctx.plugin(QuiltCompactEngine, {
    tiers: [{ name: 'primary', models: [{ provider: 'alpha', model: 'm1', cooldownHours: 1 }] }],
  });
  await drain();
  assert.ok(log.some(([l, m]) => l === 'info' && /model pool validated \(1 routes\)/.test(m)),
    `expected a validation success log, got ${JSON.stringify(log)}`);
}

// --- 2. an unusable route warns with its reason ---------------------------
{
  const log = [];
  const ctx = makeCtx({ alpha: ['m1'] }, log);
  ctx.plugin(QuiltCompactEngine, {
    tiers: [
      { name: 'primary', models: [{ provider: 'alpha', model: 'm1', cooldownHours: 1 }] },
      { name: 'fallback', models: [
        { provider: 'alpha', model: 'typo', cooldownHours: 1 },
        { provider: 'ghost', model: 'm1', cooldownHours: 1 },
      ] },
    ],
  });
  await drain();
  const warns = log.filter(([l]) => l === 'warn').map(([, m]) => m);
  assert.ok(warns.some((m) => /alpha\/typo .*not in the provider catalog/.test(m)), `missing catalog warn: ${JSON.stringify(warns)}`);
  assert.ok(warns.some((m) => /ghost\/m1 .*provider is not registered/.test(m)), `missing provider warn: ${JSON.stringify(warns)}`);
  assert.ok(warns.some((m) => /2 of the configured pool routes are not available/.test(m)), `missing summary warn: ${JSON.stringify(warns)}`);
}

// --- 3. a live config edit re-runs validation ----------------------------
{
  const log = [];
  const ctx = makeCtx({ alpha: ['m1'] }, log);
  ctx.plugin(QuiltCompactEngine, {
    tiers: [{ name: 'primary', models: [{ provider: 'alpha', model: 'm1', cooldownHours: 1 }] }],
  });
  await drain();
  const before = log.length;
  ctx.emit('loader/volatile-update');
  await drain();
  assert.ok(log.length > before, 'a volatile update must re-run pool validation');
}

// --- 4. a broken registry does not prevent mounting ----------------------
{
  const log = [];
  const ctx = new Context();
  ctx.logger = {
    info: (...a) => log.push(['info', a.join(' ')]),
    warn: (...a) => log.push(['warn', a.join(' ')]),
    error: () => {}, debug: () => {},
  };
  ctx.provide('llm', { listProviders: () => { throw new Error('registry exploded'); }, async stream() {} });
  ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 0, nodes: [] }) });
  ctx.provide('sessions', { async flush() {} });
  ctx.plugin(QuiltCompactEngine, {
    tiers: [{ name: 'primary', models: [{ provider: 'a', model: 'b', cooldownHours: 1 }] }],
  });
  await drain();
  assert.ok(ctx.compaction, 'the engine must still mount when validation cannot run');
  assert.ok(log.some(([l, m]) => l === 'warn' && /validation could not run/.test(m)), `expected a soft warning, got ${JSON.stringify(log)}`);
}

console.log('POOL-VALIDATION OK: validated / warned / re-checked on edit / degraded without blocking mount');

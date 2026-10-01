/**
 * Unit tests for runtime model-pool validation: the pool may only reference
 * models the live registry actually advertises.
 * @module dsh-quilt-compact/test/unit/model-pool
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateModelPool, collectAvailableRoutes } from '../../lib/model-pool.js';

/** A stub `ctx.llm` with a fixed provider→models catalog. */
function fakeCtx(catalog, { throwOnList = [] } = {}) {
  return {
    llm: {
      listProviders: () => Object.keys(catalog).map((id) => ({ id, name: id })),
      listModels: async (provider) => {
        if (throwOnList.includes(provider)) throw new Error('no catalog');
        return (catalog[provider] ?? []).map((id) => ({ provider, id, name: id }));
      },
    },
  };
}

const configWith = (routes) => ({
  tiers: [{ name: 'primary', models: routes.map(([provider, model]) => ({ provider, model, cooldownHours: 1 })) }],
});

test('collectAvailableRoutes reports the registry catalog', async () => {
  const { routes, providers, unlistable } = await collectAvailableRoutes(fakeCtx({ a: ['m1', 'm2'], b: ['x'] }));
  assert.deepEqual([...providers].sort(), ['a', 'b']);
  assert.deepEqual([...routes].sort(), ['a/m1', 'a/m2', 'b/x']);
  assert.equal(unlistable.size, 0);
});

test('a provider that cannot list models is unlistable, not missing', async () => {
  const { routes, unlistable } = await collectAvailableRoutes(fakeCtx({ a: ['m1'], b: ['x'] }, { throwOnList: ['b'] }));
  assert.deepEqual([...routes], ['a/m1']);
  assert.deepEqual([...unlistable], ['b']);
});

test('a fully available pool validates', async () => {
  const result = await validateModelPool(fakeCtx({ a: ['m1'] }), configWith([['a', 'm1']]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.unknown, []);
});

test('an unknown provider is reported as not registered', async () => {
  const result = await validateModelPool(fakeCtx({ a: ['m1'] }), configWith([['zzz', 'm1']]));
  assert.equal(result.ok, false);
  assert.equal(result.unknown.length, 1);
  assert.equal(result.unknown[0].key, 'zzz/m1');
  assert.match(result.unknown[0].reason, /not registered/);
});

test('a known provider with an unknown model is reported as not in the catalog', async () => {
  const result = await validateModelPool(fakeCtx({ a: ['m1'] }), configWith([['a', 'nope']]));
  assert.equal(result.ok, false);
  assert.equal(result.unknown[0].key, 'a/nope');
  assert.match(result.unknown[0].reason, /not in the provider catalog/);
});

test('a route under an unlistable provider is flagged with its own reason', async () => {
  const result = await validateModelPool(
    fakeCtx({ a: ['m1'], b: ['x'] }, { throwOnList: ['b'] }),
    configWith([['b', 'anything']]),
  );
  assert.equal(result.ok, false);
  assert.match(result.unknown[0].reason, /does not publish a model catalog/);
});

test('every bad route is reported, across tiers', async () => {
  const ctx = fakeCtx({ a: ['m1'] });
  const config = {
    tiers: [
      { name: 'primary', models: [{ provider: 'a', model: 'm1' }, { provider: 'a', model: 'bad1' }] },
      { name: 'fallback', models: [{ provider: 'nope', model: 'bad2' }] },
    ],
  };
  const result = await validateModelPool(ctx, config);
  assert.equal(result.unknown.length, 2);
  assert.deepEqual(result.unknown.map((u) => u.tier), ['primary', 'fallback']);
});

test('an unavailable registry surfaces as a diagnosable error', async () => {
  const broken = { llm: { listProviders: () => { throw new Error('registry down'); } } };
  await assert.rejects(() => collectAvailableRoutes(broken), /cannot enumerate providers.*registry down/);
});

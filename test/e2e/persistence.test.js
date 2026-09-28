/**
 * Persistence e2e: cooldown state lands in `ctx.storage.domain` and survives
 * a reopen, and the state file contains only route cooldown timestamps.
 * @module dsh-quilt-compact/test/e2e/persistence
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { Storage } from '@deepseek-ai/dsh-storage';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { CompactionChainEngine, chainStateSpec } from '../../lib/index.js';
import { createTestContext } from '../helpers/fixture.js';

/** Wire a real storage hub + json backend + domain facility onto `ctx`. */
async function mountRealStorage(ctx, root) {
  const storage = new Storage(ctx);
  const backend = new JsonStorageBackend(root);
  storage.backend.register('json', backend);
  const facility = new DomainFacility(ctx, { backend: 'json' });
  storage.mount('domain', facility);
  ctx.provide('storageDomain', facility);
  return { storage, backend, facility };
}

test('cooldown writes are persisted as json and survive a reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-quilt-compact-'));
  try {
    // First process lifetime: fail p1/m1 through the engine.
    const { ctx, llm } = createTestContext({ behaviors: { 'p1/m1': { kind: 'fail', code: 'RATE_LIMIT' } } });
    await mountRealStorage(ctx, root);
    const engine = new CompactionChainEngine(ctx, {
      tiers: [{ name: 'primary', models: [{ provider: 'p1', model: 'm1', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 5 } }] }],
    });
    const store = await engine.ensureStore();
    assert.equal(store.constructor.name, 'DomainCooldownStore');
    // p1/m1 always fails -> cooldown written -> batch collapses to the
    // session-model fallback (which succeeds here). The important assertion
    // is that the cooldown landed durably through the domain.
    await engine.summarize(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'secret session content that must never persist '.repeat(10) }] }] },
      { session: { id: 's1', requestHeader: () => undefined }, options: { provider: 'sess', model: 'sess-m' } },
      undefined,
    );
    const until = store.cooldownUntil('p1/m1');
    assert.ok(until > Date.now(), 'cooldown written through the domain');

    // The on-disk unit file holds ONLY the route cooldown timestamp.
    const fileText = await readFile(join(root, 'compaction_chain_state.json'), 'utf8');
    const document = JSON.parse(fileText);
    assert.equal(document.unit.name, 'compaction_chain_state');
    // The global singleton is served from `initial` and only materializes on
    // the first write, so the fresh file still carries the null sentinel.
    assert.equal(document.global, null);
    assert.deepEqual(Object.keys(document.tables), ['routes']);
    assert.ok(document.tables.routes['p1/m1']?.cooldownUntil === until);
    assert.ok(!fileText.includes('secret session content'), 'no session content in the state file');
    assert.ok(!fileText.includes('sess-m'), 'no model digests in the state file');

    // Second process lifetime: reopen the same root and read the record back.
    const ctx2 = new Context();
    ctx2.logger = { info() {}, warn() {}, error() {} };
    await mountRealStorage(ctx2, root);
    const reopened = await ctx2.storage.domain.open(chainStateSpec);
    assert.equal(reopened.table('routes').get('p1/m1').cooldownUntil, until);
    assert.equal(reopened.global.get().schemaVersion, 1);
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('engine falls back to in-memory state when storage-domain is not mounted', async () => {
  const { ctx } = createTestContext({ behaviors: { 'p1/m1': { kind: 'fail' } } });
  const engine = new CompactionChainEngine(ctx, {
    tiers: [{ name: 'primary', models: [{ provider: 'p1', model: 'm1', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 5 } }] }],
  });
  const store = await engine.ensureStore();
  assert.equal(store.constructor.name, 'MemoryCooldownStore');
});

test('domain spec round-trips through a real backend with no global write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-quilt-compact-'));
  try {
    const ctx = new Context();
    ctx.logger = { info() {}, warn() {}, error() {} };
    await mountRealStorage(ctx, root);
    const domain = await ctx.storage.domain.open(chainStateSpec);
    assert.deepEqual(domain.global.get(), { schemaVersion: 1 });
    await domain.table('routes').put('p/m', { cooldownUntil: 123456789 });
    assert.equal(domain.table('routes').get('p/m').cooldownUntil, 123456789);
    const fileText = await readFile(join(root, 'compaction_chain_state.json'), 'utf8');
    assert.ok(fileText.includes('"p/m"'));
    assert.ok(fileText.includes('123456789'));
    await domain.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

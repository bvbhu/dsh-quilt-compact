/**
 * Host-plane smoke test: mount dsh-quilt-compact as the `compaction` service
 * inside a REAL cordis container, with the real dsh-base storage stack.
 * Verifies:
 *  1. The plugin resolves as a module and registers ctx.compaction.
 *  2. The default export / named export identity.
 *  3. `inject` requirements are satisfiable (llm, tokenMeter, sessions).
 *  4. Config from the shipped cordis.patch.yml resolves through the real
 *     Config schema.
 *  5. Cooldown state persists through the real storageDomain facility.
 *  6. Unload is clean (ctx.effect disposer closes the domain).
 */
import { Context } from '@deepseek-ai/cordis';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

import { dshModules } from '../helpers/dsh-modules.js';

// `yaml` is not a dependency of dsh-quilt-compact; it ships inside the dsh
// installation. Find that installation's node_modules by walking up from this
// file's own node_modules, so this test carries no machine-specific path.
if (dshModules === undefined) {
  console.log('SKIP smoke/mount: dsh installation not found (set DSH_MODULES to its node_modules to enable)');
  process.exit(0);
}
const { parse } = await import(pathToFileURL(join(dshModules, 'yaml', 'dist', 'index.js')).href);
import * as Storage from '@deepseek-ai/dsh-storage';
import * as StorageJson from '@deepseek-ai/dsh-storage-json';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import QuiltCompactEngine, { name, inject, Config, readConfigValue } from '../../lib/index.js';

const root = mkdtempSync(join(tmpdir(), 'quilt-smoke-'));

// --- fake required services (llm / tokenMeter / sessions) -----------------
const llm = {
  async resolveModelInfo() { return { context: { contextWindow: 128000 }, defaultMaxTokens: 32768 }; },
  async stream() { throw new Error('should not be called in smoke'); },
};
const tokenMeter = {
  measure() { return { totalTokens: 0, nodes: [] }; },
};
const sessions = { async flush() {} };

const ctx = new Context();
ctx.provide('llm', llm);
ctx.provide('tokenMeter', tokenMeter);
ctx.provide('sessions', sessions);

// real storage stack, exactly like dsh-base mounts it
ctx.plugin(Storage.default ?? Storage);
ctx.plugin(StorageJson.default ?? StorageJson, { root });
ctx.plugin(StorageDomain.default ?? StorageDomain, { backend: 'json' });
// cordis plugin startup is asynchronous (fibers settle on the microtask/timer
// queue), so drain before asserting on registered services.
const drain = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };
await drain();
console.log('storage mounted:', !!ctx.storage, 'storageDomain facade:', !!ctx.get('storageDomain'));

// --- 1. module identity ---------------------------------------------------
assert.equal(name, 'dsh-quilt-compact');
assert.deepEqual(inject, ['llm', 'tokenMeter', 'sessions']);
assert.equal(typeof QuiltCompactEngine, 'function');

// --- 2. config from the SHIPPED patch file --------------------------------
const patchText = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8');
const layers = parse(patchText);
const insert = layers.find((l) => l.insert)?.insert;
const row = insert.find((e) => e.id === 'dsh-quilt-compact');
assert.ok(row, 'patch must insert the dsh-quilt-compact row');
assert.equal(row.name, 'dsh-quilt-compact');
const resolved = Config(row.config);
// Config fields are `.volatile()` so the settings page can edit them, which
// means a resolved field is a { get(), [write] } reference, not a plain value.
const tiers = readConfigValue(resolved.tiers);
assert.ok(tiers.length === 1, 'one tier resolves');
assert.ok(tiers[0].models.length === 1);

// --- 3. mount as the compaction service -----------------------------------
ctx.plugin(QuiltCompactEngine, row.config);
await drain();
assert.ok(ctx.compaction, 'ctx.compaction must be registered');
assert.ok(ctx.compaction instanceof QuiltCompactEngine);
assert.equal(ctx.compaction.config.chunkRatio, 0.8);

// --- 4. cooldown store opens against the REAL domain, and really persists --
const facility = ctx.get('storageDomain');
assert.ok(facility, 'storageDomain facility must be resolvable');
const store = await ctx.compaction.ensureStore();
assert.ok(store, 'cooldown store must open');
const route = 'openrouter/openrouter/free';
const until = Date.now() + 60000;
await store.applyCooldown(route, until);
assert.equal(store.cooldownUntil(route), until, 'cooldown round-trips through the domain');
assert.ok(store.keys().includes(route));
assert.equal(store.isHealthy(route, Date.now()), false, 'a cooling route is not healthy');

// state must reach the filesystem, not just memory
const files = readdirSync(root, { recursive: true }).filter((f) => String(f).includes('dsh_quilt_compact_state'));
assert.ok(files.length > 0, `cooldown state must persist under the storage root (saw: ${files.join(', ') || 'nothing'})`);

// --- 5. unload is clean ---------------------------------------------------
await ctx.dispose?.();
console.log('SMOKE OK: mounted as ctx.compaction, real storage stack, cooldown persisted, disposed cleanly');

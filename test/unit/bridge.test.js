/**
 * Unit tests for the settings bridge core (lib/bridge.js) and its cordis
 * wiring (lib/bridge-host.js). No network, no real ws server — reads and
 * writes are injected stubs, and the locate/write logic is exercised with a
 * scripted configEditor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBridgeHandlers,
  createBridgeRoutes,
  guardBridgeRequest,
  readJsonBody,
  writeJson,
} from '../../lib/bridge.js';

function sampleDeps(overrides = {}) {
  return {
    locate: () => ({ kind: 'preset', entry: { options: { id: 'preset-standard' } }, rowConfig: { tiers: [] } }),
    read: () => ({ ok: true, revision: 'abc123', value: { tiers: [] } }),
    write: async () => ({ ok: true }),
    catalog: async () => ({ ok: true, value: { groups: [{ id: 'p1', name: 'P1', models: [{ id: 'm1' }] }] } }),
    status: () => ({ engineServing: 'preset', basicDisabled: true, presetOverridden: true }),
    ...overrides,
  };
}

test('describe returns config, revision, catalog and status', async () => {
  const handlers = createBridgeHandlers(sampleDeps());
  const out = await handlers.describe();
  assert.equal(out.ok, true);
  assert.equal(out.value.source, 'preset');
  assert.equal(out.value.revision, 'abc123');
  assert.equal(out.value.catalog.groups[0].id, 'p1');
  assert.equal(out.value.status.engineServing, 'preset');
});

test('describe reports no-target when the backend row is absent', async () => {
  const handlers = createBridgeHandlers(sampleDeps({ locate: () => undefined }));
  const out = await handlers.describe();
  assert.equal(out.ok, false);
  assert.equal(out.code, 'no-target');
});

test('describe propagates a failed read', async () => {
  const handlers = createBridgeHandlers(sampleDeps({ read: () => ({ ok: false, code: 'conflict', message: 'x' }) }));
  const out = await handlers.describe();
  assert.equal(out.ok, false);
  assert.equal(out.code, 'conflict');
});

test('mutate forwards config and revision to the writer', async () => {
  const written = [];
  const handlers = createBridgeHandlers(sampleDeps({
    write: async (config, revision) => { written.push({ config, revision }); return { ok: true }; },
  }));
  const out = await handlers.mutate({ config: { chunkRatio: 0.5 }, revision: 'abc123' });
  assert.equal(out.ok, true);
  assert.equal(written.length, 1);
  assert.equal(written[0].revision, 'abc123');
});

test('mutate rejects non-object bodies', async () => {
  const handlers = createBridgeHandlers(sampleDeps());
  for (const bad of [undefined, null, 42, 'x', []]) {
    const out = await handlers.mutate(bad);
    assert.equal(out.ok, false);
    assert.equal(out.code, 'rejected');
  }
});

test('mutate reports no-target when the backend row is absent', async () => {
  const handlers = createBridgeHandlers(sampleDeps({ locate: () => undefined }));
  const out = await handlers.mutate({ config: {}, revision: 'r' });
  assert.equal(out.code, 'no-target');
});

test('mutate surfaces writer rejections verbatim (conflict/invalid/write-failed)', async () => {
  for (const code of ['conflict', 'invalid', 'write-failed']) {
    const handlers = createBridgeHandlers(sampleDeps({ write: async () => ({ ok: false, code, message: 'boom' }) }));
    const out = await handlers.mutate({ config: {}, revision: 'r' });
    assert.equal(out.ok, false);
    assert.equal(out.code, code);
    assert.equal(out.message, 'boom');
  }
});

test('guardBridgeRequest rejects non-loopback and non-POST', () => {
  const out = [];
  const send = (json, status) => out.push({ json, status });
  assert.equal(guardBridgeRequest({ method: 'POST', headers: { host: '127.0.0.1:3080' } }, {}, send), true);
  assert.equal(out.length, 0);
  assert.equal(guardBridgeRequest({ method: 'GET', headers: { host: '127.0.0.1:3080' } }, {}, send), false);
  assert.equal(out.at(-1).status, 405);
  assert.equal(guardBridgeRequest({ method: 'POST', headers: { host: 'example.com' } }, {}, send), false);
  assert.equal(out.at(-1).status, 403);
});

test('readJsonBody parses a small JSON payload', async () => {
  const req = { on: (ev, cb) => { if (ev === 'data') cb(Buffer.from('{"a":1}')); if (ev === 'end') cb(); if (ev === 'error') {} } };
  const body = await readJsonBody(req);
  assert.deepEqual(body, { a: 1 });
});

test('readJsonBody resolves undefined on malformed JSON', async () => {
  const req = { on: (ev, cb) => { if (ev === 'data') cb(Buffer.from('not-json')); if (ev === 'end') cb(); if (ev === 'error') {} } };
  const body = await readJsonBody(req);
  assert.equal(body, undefined);
});

test('writeJson serializes a status payload', () => {
  const chunks = [];
  const res = {
    writeHead: (status, headers) => { res.status = status; res.headers = headers; },
    end: (payload) => chunks.push(payload),
  };
  writeJson(res, 200, { ok: true, value: { a: 1 } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(chunks.join('')), { ok: true, value: { a: 1 } });
});

test('createBridgeRoutes yields three exact routes under the prefix', () => {
  const routes = createBridgeRoutes(sampleDeps());
  assert.equal(routes.length, 3);
  assert.deepEqual(routes.map((r) => r.path), [
    '/api/dsh-quilt-compact/describe',
    '/api/dsh-quilt-compact/mutate',
    '/api/dsh-quilt-compact/status',
  ]);
  for (const r of routes) assert.equal(r.kind, 'exact');
});

// --- bridge-host: locate / write against a scripted configEditor -------------

import { createBridgeDeps, registerQuiltBridge } from '../../lib/bridge-host.js';

function fakeEditor(entries) {
  return {
    entries: () => entries,
    edit: async (entry, change) => { fakeEditor.lastEdit = { entry, change }; },
  };
}

const presetEntry = {
  options: {
    id: 'preset-standard',
    name: '@deepseek-ai/dsh-agent-preset',
    config: {
      id: 'standard',
      order: 1,
      plugins: [
        { id: 'persona', name: '@deepseek-ai/dsh-persona' },
        {
          id: 'compaction',
          name: 'cordis:group',
          group: true,
          isolate: { compaction: true, toolResultPruner: true },
          config: [
            { id: 'dsh-quilt-compact', name: 'dsh-quilt-compact', config: { tiers: [], chunkRatio: 0.8 } },
            { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
          ],
        },
      ],
    },
  },
};

const hostEntry = {
  options: { id: 'dsh-quilt-compact', name: 'dsh-quilt-compact', config: { tiers: [], chunkRatio: 0.8 } },
};

function ctxWith(entries, extra = {}) {
  const get = (name) => {
    if (name === 'configEditor') return fakeEditor(entries);
    if (name === 'llm') return extra.llm ?? { listProviders: async () => [{ id: 'p1', name: 'P1' }], listModels: async () => [{ id: 'm1', name: 'M1' }] };
    if (name === 'webServer') return extra.webServer;
    return undefined;
  };
  const effects = [];
  const ctx = { get, effect: (fn) => effects.push(fn) };
  return { ctx, effects };
}

test('bridge-host locate prefers the preset-standard nested row', () => {
  const { ctx } = ctxWith([presetEntry, hostEntry]);
  const deps = createBridgeDeps(ctx);
  const target = deps.locate();
  assert.equal(target.kind, 'preset');
  assert.equal(target.rowConfig.chunkRatio, 0.8);
});

test('bridge-host locate falls back to the host row', () => {
  const { ctx } = ctxWith([hostEntry]);
  const deps = createBridgeDeps(ctx);
  const target = deps.locate();
  assert.equal(target.kind, 'host');
});

test('bridge-host locate is undefined when neither row exists', () => {
  const { ctx } = ctxWith([]);
  const deps = createBridgeDeps(ctx);
  assert.equal(deps.locate(), undefined);
});

test('bridge-host write on the preset target restates the whole config and replaces only the nested row', async () => {
  const { ctx } = ctxWith([presetEntry]);
  const deps = createBridgeDeps(ctx);
  const target = deps.locate();
  const current = deps.read(target);
  const nextConfig = {
    chunkRatio: 0.9,
    tiers: [{
      name: 't',
      models: [{ provider: 'p1', model: 'm1', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 5 } }],
    }],
  };
  const out = await deps.write(nextConfig, current.revision);
  assert.equal(out.ok, true);
  const change = fakeEditor.lastEdit.change;
  const next = change(structuredClone(presetEntry.options.config), {});
  assert.equal(next.plugins.length, presetEntry.options.config.plugins.length);
  const group = next.plugins.find((p) => p.id === 'compaction');
  const quilt = group.config.find((r) => r.id === 'dsh-quilt-compact');
  assert.equal(quilt.config.chunkRatio, 0.9);
  assert.deepEqual(quilt.config.tiers, nextConfig.tiers);
  // untouched rows survive
  assert.equal(next.plugins[0].id, 'persona');
  assert.equal(group.config.find((r) => r.id === 'command-compact').id, 'command-compact');
});

test('bridge-host write on the host target replaces the whole config', async () => {
  const { ctx } = ctxWith([hostEntry]);
  const deps = createBridgeDeps(ctx);
  const target = deps.locate();
  const current = deps.read(target);
  const nextConfig = {
    chunkRatio: 0.5,
    tiers: [{
      name: 'primary',
      models: [{ provider: 'p1', model: 'm1', maxConcurrent: 1, cooldown: { mode: 'dailyReset', hour: 0 } }],
    }],
  };
  const out = await deps.write(nextConfig, current.revision);
  assert.equal(out.ok, true);
  const change = fakeEditor.lastEdit.change;
  const next = change({}, {});
  assert.equal(next.chunkRatio, 0.5);
  assert.deepEqual(next.tiers, nextConfig.tiers);
});

test('bridge-host write rejects a stale revision', async () => {
  const { ctx } = ctxWith([presetEntry]);
  const deps = createBridgeDeps(ctx);
  const out = await deps.write({}, 'stale-revision');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'conflict');
});

test('bridge-host write rejects malformed config via resolveConfig', async () => {
  const { ctx } = ctxWith([presetEntry]);
  const deps = createBridgeDeps(ctx);
  const target = deps.locate();
  const current = deps.read(target);
  const out = await deps.write({ tiers: 42 }, current.revision);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'invalid');
});

test('registerQuiltBridge is a no-op without a webServer', () => {
  const { ctx, effects } = ctxWith([presetEntry]);
  const dispose = registerQuiltBridge(ctx);
  assert.equal(typeof dispose, 'function');
  assert.equal(effects.length, 0); // no webServer -> no routes, no cleanup effect
});

test('registerQuiltBridge registers routes when a webServer exists', () => {
  const registered = [];
  const webServer = { register: (route) => { registered.push(route); return () => {}; } };
  const { ctx, effects } = ctxWith([presetEntry], { webServer });
  const dispose = registerQuiltBridge(ctx);
  assert.equal(registered.length, 3);
  assert.deepEqual(registered.map((r) => r.path), [
    '/api/dsh-quilt-compact/describe',
    '/api/dsh-quilt-compact/mutate',
    '/api/dsh-quilt-compact/status',
  ]);
  assert.equal(effects.length, 1);
  assert.equal(typeof dispose, 'function');
});
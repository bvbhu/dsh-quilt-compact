/**
 * Render the settings card against a realistic config + catalog and drive the
 * save path, proving the page's data flow works:
 *   - the card renders without throwing (registered into plugins.row.config)
 *   - provider/model pickers are populated from the catalog (never free text)
 *   - a saved route missing from the catalog is shown as unavailable
 *   - a provider change clears the paired model id
 *   - saving writes the WHOLE tiers array as clean JSON, fenced on revision
 *
 * The page talks to the settings bridge (`/api/dsh-quilt-compact/*`), so the
 * fake host here is a stubbed `fetch` answering describe/mutate — no
 * configForms, no remote.session.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../client/client.js', import.meta.url), 'utf8');

// --- React stub rendering to a plain tree ------------------------------------
// Function components are invoked during the walk, the way React would render
// them, so the tree below reflects real output rather than component wrappers.
const h = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
});
const React = { createElement: h, Fragment: Symbol('Fragment') };

/** Whether a node is a component we must invoke to see its output. */
const isComponent = (node) => typeof node.type === 'function';

/**
 * Render a node, invoking function components (host elements like 'div'/'select'
 * stay as-is). Returns the expanded node.
 */
function render(node) {
  if (node === null || typeof node !== 'object') return node;
  if (isComponent(node)) return render(node.type(node.props));
  return { ...node, children: (node.children ?? []).map(render).filter((c) => c !== null && c !== undefined) };
}

/** Depth-first walk over a rendered tree. */
function walk(node, visit) {
  if (node === null || typeof node !== 'object') return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/** Every node whose `type` matches. */
function findAll(tree, type) {
  const found = [];
  walk(tree, (n) => { if (n.type === type) found.push(n); });
  return found;
}

// --- module table ------------------------------------------------------------
function makeStore() {
  let value;
  const listeners = new Set();
  return {
    // Real dsh-client-store snapshot handle: getSnapshot/subscribe/set — there
    // is deliberately NO `get()`; a caller that reaches for one reproduces the
    // live bug this smoke guards against (TypeError inside the slot render).
    getSnapshot: () => value,
    set: (next) => { value = next; for (const l of listeners) l(); },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

const moduleTable = {
  react: {
    createElement: h,
    Fragment: React.Fragment,
    // The renderer's RootEntry renders our SafeCard through React's own
    // useSyncExternalStore; replay that seam with the current snapshot.
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  },
  'react/jsx-runtime': { jsx: h, jsxs: h, Fragment: React.Fragment },
  '@deepseek-ai/dsh-client-ui-primitives': {
    SettingsForm: 'SettingsForm', SettingsFormModel: 'SettingsFormModel',
    SettingsValueField: 'SettingsValueField', SettingsSecretField: 'SettingsSecretField',
    settingsNumberField: () => ({}), settingsTextField: () => ({}), Switch: 'Switch',
  },
  '@deepseek-ai/dsh-client-store': { createSnapshotStore: makeStore },
};

const styleTags = [];
globalThis.document = {
  querySelector: (sel) => styleTags.find((t) => `style[data-plugin-css=${JSON.stringify(t.dataset.pluginCss)}]` === sel) ?? null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: (tag) => styleTags.push(tag) },
};

let registered;
globalThis.window = {
  __ModuleLoader__: { load: ({ id, factory }) => { registered = { id, exports: factory((n) => moduleTable[n]) }; } },
};
new Function('window', 'document', 'console', source)(globalThis.window, globalThis.document, console);

// --- fake host: the settings bridge ------------------------------------------
/** A fetch stub that answers the bridge endpoints against a mutable config. */
function makeBridge({ config = CONFIG, writable = true, catalog = CATALOG } = {}) {
  let revision = 7;
  const mutations = [];
  const catalogPayload = catalog;
  const fetchStub = async (url, init) => {
    const path = String(url);
    const body = init?.body === undefined ? undefined : JSON.parse(init.body);
    const send = (payload) => ({
      ok: true,
      status: 200,
      json: async () => payload,
    });
    if (path.endsWith('/describe')) {
      return send({
        ok: true,
        value: {
          source: 'preset',
          config,
          revision,
          catalog: catalogPayload.ok ? catalogPayload.value : { groups: [] },
          catalogError: catalogPayload.ok ? undefined : 'catalog-failed',
          status: { engineServing: 'preset', basicDisabled: true, presetOverridden: true },
        },
      });
    }
    if (path.endsWith('/mutate')) {
      mutations.push(body);
      assert.equal(body.revision, revision, 'mutate must fence on the revision it read');
      if (!writable) return send({ ok: false, code: 'rejected', message: 'read-only' });
      config = body.config;
      revision += 1;
      return send({ ok: true });
    }
    if (path.endsWith('/status')) {
      return send({ ok: true, value: { engineServing: 'preset', basicDisabled: true, presetOverridden: true } });
    }
    throw new Error(`unexpected bridge path: ${path}`);
  };
  return { fetchStub, mutations, revision: () => revision, config: () => config };
}

const CONFIG = {
  chunkRatio: 0.8,
  chunkOverlapRatio: 0.1,
  fallbackToSessionModel: true,
  chunkPromptSuffix: '',
  mergePromptSuffix: '',
  tiers: [{
    name: 'primary',
    models: [
      { provider: 'alpha', model: 'm1', maxConcurrent: 1, cooldown: { mode: 'dailyReset', hour: 0 } },
      { provider: 'beta', model: 'gone', maxConcurrent: 2, cooldown: { mode: 'duration', hours: 5 } },
    ],
  }],
  preprocessing: {
    dedup: true, purgeErrors: true,
    headMiddleTail: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
    astSkeleton: { enabled: true, maxDepth: 2 },
    logCondense: { mode: 'balanced', maxLines: 200 },
  },
};

const CATALOG = {
  ok: true,
  value: {
    groups: [
      { id: 'alpha', name: 'Alpha', models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }] },
      { id: 'beta', name: 'Beta', models: [{ id: 'm1', name: 'Beta M1' }] },
    ],
    failures: [],
  },
};

/**
 * Mount the plugin; the caller owns the bridge fetch stub installation.
 * Returns the rendered card helpers.
 */
async function mount() {
  let captured;      // { options, Component }
  const ctx = {
    locale: { bind: () => (key) => key, register: () => () => {} },
    effect: (fn) => { fn(); return () => {}; },
    on: () => () => {},
    remote: {
      session: { modelCatalog: async () => CATALOG },
      $on: () => () => {},
    },
    slots: {
      inject: (_name, cb) => cb(),
      register: (options, Component) => { captured = { options, Component }; return () => {}; },
    },
    configForms: {
      get: () => { throw new Error('configForms must not be used: the page goes through the bridge'); },
      whileServed: () => () => {},
    },
  };
  registered.exports.apply(ctx);
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
  assert.ok(captured, 'the card registered into plugins.row.config');
  const face = captured.options.inject();
  const stateOf = (f = face) => {
    // The face no longer carries a snapshot: the card reads the controller's
    // store live (useSyncExternalStore). Tests read the same store.
    const c = f.controller;
    assert.ok(c, 'the face exposes the controller');
    return c.store.getSnapshot() ?? {};
  };
  return {
    captured,
    face,
    stateOf,
    tree: render(captured.Component(face)),
    rerender: () => render(captured.Component(captured.options.inject())),
    faceOf: () => captured.options.inject(),
  };
}

/**
 * Run a callback with the bridge fetch stub installed, then restore. The page
 * performs its bridge fetch lazily (initial describe, then save), so the stub
 * must stay in place for the whole scenario.
 */
async function withBridge({ catalog = CATALOG, config = CONFIG, writable = true } = {}, run) {
  const previousFetch = globalThis.fetch;
  const bridge = makeBridge({ catalog, config, writable });
  globalThis.fetch = bridge.fetchStub;
  try {
    const mounted = await mount();
    return await run(mounted, bridge);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

// --- 1. renders, and pickers come from the catalog ---------------------------
{
  const { captured, face, tree, stateOf } = await withBridge({}, async (mounted) => mounted);
  assert.equal(captured.options.name, 'plugins.row.config');
  assert.equal(captured.options.key, 'dsh-quilt-compact#dsh-quilt-compact');
  assert.ok(tree, 'the card rendered');

  // The face must NOT carry a frozen snapshot (that was the live crash: the
  // real dsh-client-store has no `.get()`, and a snapshot in the inject face
  // goes stale in rootInjectCache anyway).
  assert.ok(face.controller !== undefined, 'face exposes the controller');
  assert.equal(face.state, undefined, 'face no longer snapshots state');

  const selects = findAll(tree, 'select');
  assert.ok(selects.length >= 4, `expected provider/model/cooldown selects, got ${selects.length}`);
  const optionValues = selects.flatMap((s) => (s.children ?? []).map((o) => o.props?.value));
  assert.ok(optionValues.includes('alpha') && optionValues.includes('beta'), 'providers come from the catalog');
  assert.ok(optionValues.includes('m2'), 'models come from the catalog');

  // The saved-but-missing route is flagged.
  const badges = findAll(tree, 'span').filter((n) => n.props?.className === 'qc-badge');
  assert.equal(badges.length, 1, 'exactly the missing route is marked unavailable');

  const state = stateOf();
  assert.equal(state.catalogStatus, 'ready');
  assert.equal(state.error, undefined, 'a valid config produces no validation error');
  assert.equal(state.source, 'preset', 'the serving path is surfaced');
}

// --- 2. changing the provider clears the paired model ------------------------
{
  await withBridge({}, async ({ rerender }) => {
    // Find the first provider select and fire its onChange.
    const tree = rerender();
    const providerSelect = findAll(tree, 'select').find((s) => (s.children ?? []).some((o) => o.props?.value === 'alpha'));
    assert.ok(providerSelect, 'found the provider select');
    providerSelect.props.onChange({ target: { value: 'beta' } });
    const after = rerender();
    const betaSelected = findAll(after, 'select').find((s) => s.props?.value === 'beta');
    assert.ok(betaSelected, 'the provider selection changed');
    // The paired model must be cleared, never left pointing at the old provider.
    const modelSelects = findAll(after, 'select').filter((s) => (s.children ?? []).some((o) => ['', 'm1', 'm2'].includes(o.props?.value)));
    assert.ok(modelSelects.some((s) => s.props?.value === ''), 'the model id was cleared with its provider');
  });
}

// --- 3. save writes the whole array as clean JSON ---------------------------
{
  await withBridge({}, async ({ face }, bridge) => {
    assert.equal(bridge.mutations.length, 0, 'nothing is written before an explicit save');
    await face.save();
    assert.equal(bridge.mutations.length, 1, 'one bridge mutate call');
    const { config: sent, revision } = bridge.mutations[0];
    assert.equal(revision, 7, 'fenced on the revision that was read');
    const paths = Object.keys(sent).sort();
    assert.deepEqual(paths, ['chunkOverlapRatio', 'chunkPromptSuffix', 'chunkRatio', 'fallbackToSessionModel', 'mergePromptSuffix', 'preprocessing', 'tiers']);
    const tiers = sent.tiers;
    assert.ok(Array.isArray(tiers) && tiers.length === 1);
    assert.equal(tiers[0].models.length, 2);
    // Exactly one cooldown shape per model, and clean JSON throughout.
    for (const model of tiers[0].models) {
      const keys = Object.keys(model.cooldown);
      assert.ok(model.cooldown.mode === 'duration' || model.cooldown.mode === 'dailyReset');
      assert.deepEqual(keys.sort(), model.cooldown.mode === 'duration' ? ['hours', 'mode'] : ['hour', 'mode']);
    }
    assert.equal(JSON.stringify(sent).includes('undefined'), false, 'no undefined reaches the write');
  });
}

// --- 4. a failed catalog still renders and keeps saved entries ---------------
{
  await withBridge({ catalog: { ok: false, error: { message: 'down' } } }, async ({ tree, stateOf }) => {
    assert.equal(stateOf().catalogStatus, 'error'); // describe ok but catalog unavailable
    assert.ok(tree, 'the card still renders when the catalog fails');
    const text = JSON.stringify(tree);
    assert.ok(text.includes('catalogFailed'), 'the failure is surfaced');
    // Saved entries must survive a catalog failure, not vanish.
    assert.equal(stateOf().draft.tiers[0].models.length, 2, 'saved models are retained');
  });
}

// --- 5. invalid input blocks the save ---------------------------------------
{
  await withBridge({}, async ({ face, rerender, faceOf }, bridge) => {
    const tree = rerender();
    // Locate the field by its exact label text, not by a substring of a subtree.
    const labelText = (label) => (label.children ?? [])
      .map((c) => (typeof c === 'string' ? c : Array.isArray(c?.children) ? c.children.filter((x) => typeof x === 'string').join('') : ''))
      .join('');
    const ratioField = findAll(tree, 'label').find((n) => labelText(n) === 'chunkRatio');
    assert.ok(ratioField, 'found the chunkRatio field by label');
    const input = findAll(ratioField, 'input')[0];
    assert.ok(input, 'the chunkRatio field has an input');
    assert.equal(input.props.value, '0.8', 'it is the ratio field');
    input.props.onChange({ target: { value: '2' } });
    // The host re-reads the face on every render; do the same.
    void rerender();
    const state = faceOf().controller.store.getSnapshot();
    assert.ok(state.error, 'an out-of-range ratio is reported immediately');
    await face.save();
    assert.equal(bridge.mutations.length, 0, 'an out-of-range ratio must not be written');
  });
}

console.log('CLIENT-RENDER OK: bridge channel, row-config seat, catalog-driven pickers, unavailable flagged, whole-array clean-JSON save, invalid blocked');

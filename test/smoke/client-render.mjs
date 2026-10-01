/**
 * Render the settings card against a realistic config + catalog and drive the
 * save path, proving the page's data flow works:
 *   - the card renders without throwing (registered into plugins.row.config
 *     and plugins.bundle.config, connect-trae style)
 *   - provider/model pickers are populated from the catalog (never free text)
 *   - a saved route missing from the catalog is shown as unavailable
 *   - a provider change refills the paired model from the new provider, so
 *     the draft stays valid and Save is never silently disabled
 *   - the card shell collapses and the section tabs switch panels
 *   - saving writes the WHOLE tiers array as clean JSON, fenced on revision
 *   - the save button stays clickable under a validation error; clicking it
 *     surfaces the message instead of writing
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

/** The visible label text of a rendered `label` node (spans joined, inputs ignored). */
const labelText = (label) => (label.children ?? [])
  .map((c) => (typeof c === 'string' ? c : Array.isArray(c?.children) ? c.children.filter((x) => typeof x === 'string').join('') : ''))
  .join('');

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
      { provider: 'alpha', model: 'm1', maxConcurrent: 1, cooldownHours: 1 },
      { provider: 'beta', model: 'gone', maxConcurrent: 2, cooldownHours: 5 },
    ],
  }],
  preprocessing: {
    dedup: true, purgeErrors: true,
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
 * Returns the rendered card helpers. The plugin registers into BOTH config
 * seats; the helpers read the row-config registration.
 */
async function mount() {
  const registrations = [];
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
      register: (options, Component) => { registrations.push({ options, Component }); return () => {}; },
    },
    configForms: {
      get: () => { throw new Error('configForms must not be used: the page goes through the bridge'); },
      whileServed: () => () => {},
    },
  };
  registered.exports.apply(ctx);
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
  assert.ok(registrations.length >= 2, 'the card registered into both config seats');
  const captured = registrations.find((r) => r.options.name === 'plugins.row.config');
  assert.ok(captured, 'the row-config seat is registered');
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
    registrations,
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

// --- 1. renders, both seats, pickers come from the catalog -------------------
{
  const { captured, registrations, face, tree, stateOf } = await withBridge({}, async (mounted) => mounted);
  assert.equal(captured.options.name, 'plugins.row.config');
  assert.equal(captured.options.key, 'dsh-quilt-compact#dsh-quilt-compact');
  const bundle = registrations.find((r) => r.options.name === 'plugins.bundle.config');
  assert.ok(bundle, 'the bundle-config seat is registered too (connect-trae style)');
  assert.equal(bundle.options.key, 'dsh-quilt-compact');
  assert.ok(tree, 'the card rendered');

  // The face must NOT carry a frozen snapshot (that was the live crash: the
  // real dsh-client-store has no `.get()`, and a snapshot in the inject face
  // goes stale in rootInjectCache anyway).
  assert.ok(face.controller !== undefined, 'face exposes the controller');
  assert.equal(face.state, undefined, 'face no longer snapshots state');

  // The card shell is a collapsible header (title + description + caret) and
  // opens expanded; the section tab bar is present with the pool tab active.
  const buttons = findAll(tree, 'button');
  assert.ok(buttons.some((b) => b.props?.className?.includes('qc-head')), 'the shell header is a button');
  const tabLabels = buttons
    .filter((b) => b.props?.className?.includes('qc-tab'))
    .flatMap((b) => (b.children ?? []).filter((c) => typeof c === 'string'));
  assert.ok(tabLabels.includes('poolHeading') && tabLabels.includes('tuningHeading') && tabLabels.includes('preprocessingHeading') && tabLabels.includes('runRecordHeading'),
    `expected the four section tabs, got ${JSON.stringify(tabLabels)}`);
  assert.ok(buttons.some((b) => b.props?.className?.includes('qc-tab-active')), 'a tab is active');

  const selects = findAll(tree, 'select');
  // provider + model selects per model (cooldown is a number field now: the
  // mode selector was removed with daily-reset).
  assert.ok(selects.length >= 4, `expected provider/model selects, got ${selects.length}`);
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
  assert.equal(state.view?.open, true, 'the shell starts expanded');
  assert.equal(state.view?.tab, 'pool', 'the pool tab starts active');
}

// --- 1b. the shell collapses and tabs switch panels --------------------------
{
  const { face, rerender, stateOf } = await withBridge({}, async (mounted) => mounted);
  face.toggleOpen();
  assert.equal(stateOf().view.open, false, 'the shell collapses');
  const collapsed = rerender();
  const collapsedBody = findAll(collapsed, 'div').filter((n) => n.props?.className === 'qc-body');
  assert.equal(collapsedBody.length, 0, 'the body is hidden when collapsed');
  face.toggleOpen();
  face.setTab('tuning');
  assert.equal(stateOf().view.tab, 'tuning', 'the tuning tab activates');
  const tuned = rerender();
  const ratioLabels = findAll(tuned, 'label').map(labelText);
  assert.ok(ratioLabels.includes('chunkRatio'), 'the tuning fields render under their tab');
  face.setTab('runrecord');
  assert.equal(stateOf().view.tab, 'runrecord', 'the runrecord tab activates');
  const logged = rerender();
  const logLabels = findAll(logged, 'label').map(labelText);
  assert.ok(logLabels.includes('runRecordEnabled'), 'the run-record fields render under their tab');
}

// --- 2. changing the provider refills the paired model -----------------------
{
  await withBridge({}, async ({ rerender, faceOf }) => {
    // Find the first provider select and fire its onChange.
    const tree = rerender();
    const providerSelect = findAll(tree, 'select').find((s) => (s.children ?? []).some((o) => o.props?.value === 'alpha'));
    assert.ok(providerSelect, 'found the provider select');
    providerSelect.props.onChange({ target: { value: 'beta' } });
    const after = rerender();
    const betaSelected = findAll(after, 'select').find((s) => s.props?.value === 'beta');
    assert.ok(betaSelected, 'the provider selection changed');
    // The paired model is refilled with the new provider's first model (was:
    // cleared to '' — that left the draft invalid and silently disabled Save).
    const modelSelect = findAll(after, 'select').find((s) => s.props?.value === 'm1');
    assert.ok(modelSelect, 'the model was refilled from the new provider');
    const state = faceOf().controller.store.getSnapshot();
    assert.equal(state.error, undefined, 'the refilled pairing is valid');
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
    assert.deepEqual(paths, ['chunkOverlapRatio', 'chunkPromptSuffix', 'chunkRatio', 'fallbackToSessionModel', 'mergePromptSuffix', 'preprocessing', 'runRecord', 'tiers']);
    const tiers = sent.tiers;
    assert.ok(Array.isArray(tiers) && tiers.length === 1);
    assert.equal(tiers[0].models.length, 2);
    // Cooldown is a single positive number of hours per model.
    for (const model of tiers[0].models) {
      assert.ok(model.cooldownHours > 0, 'a positive hour count');
      assert.equal(typeof model.cooldownHours, 'number');
      assert.equal(model.cooldown, undefined, 'no nested cooldown object is written');
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

// --- 5. invalid input blocks the write, but Save stays clickable -------------
{
  await withBridge({}, async ({ face, rerender, faceOf }, bridge) => {
    // The ratio field lives on the 分块与兜底 tab: switch to it first.
    const initial = rerender();
    const tabButton = findAll(initial, 'button').find((b) => (b.children ?? []).includes('tuningHeading'));
    assert.ok(tabButton, 'found the tuning tab');
    tabButton.props.onClick();
    const tree = rerender();
    // Locate the field by its exact label text, not by a substring of a subtree.
    const ratioField = findAll(tree, 'label').find((n) => labelText(n) === 'chunkRatio');
    assert.ok(ratioField, 'found the chunkRatio field by label');
    const input = findAll(ratioField, 'input')[0];
    assert.ok(input, 'the chunkRatio field has an input');
    assert.equal(input.props.value, '0.8', 'it is the ratio field');
    input.props.onChange({ target: { value: '2' } });
    // The host re-reads the face on every render; do the same.
    const afterEdit = rerender();
    const state = faceOf().controller.store.getSnapshot();
    assert.ok(state.error, 'an out-of-range ratio is reported immediately');
    // The save button must NOT be disabled by the validation error (it was:
    // an edit that transiently cleared a field made Save look dead). Clicking
    // it surfaces the message instead of writing.
    const saveBtn = findAll(afterEdit, 'button').find((b) => b.props?.className?.includes('qc-btn-primary'));
    assert.ok(saveBtn, 'the save button is present');
    assert.notEqual(saveBtn.props.disabled, true, 'save stays clickable under a validation error');
    await face.save();
    assert.equal(bridge.mutations.length, 0, 'an out-of-range ratio must not be written');
    const after = faceOf().controller.store.getSnapshot();
    assert.equal(after.error, 'invalidRatio', 'the attempted save surfaces the reason');
  });
}

console.log('CLIENT-RENDER OK: both config seats, collapsible shell, tabs, catalog-driven pickers, unavailable flagged, provider refill keeps Save valid, whole-array clean-JSON save, invalid surfaced on click');

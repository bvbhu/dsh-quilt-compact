/**
 * Cordis wiring for the dsh-quilt-compact settings bridge.
 *
 * Resolves the bridge's injected dependencies against the live host context:
 *
 * - locate(): the row the page edits. When the `standard` agent preset is
 *   overridden (web/desktop), the backend row lives inside `preset-standard`'s
 *   plugin list — the bridge targets that entry and the nested row. Otherwise
 *   it targets the plain host-plane `dsh-quilt-compact` row.
 * - read()/write(): through `configEditor`, the exact persistence path the
 *   official editor uses (file lock, reconcile, hot apply). Writing the preset
 *   target must restate the WHOLE `preset-standard` config because a patch
 *   replaces `config` wholesale; the change only touches the nested
 *   `dsh-quilt-compact` row's config inside the `compaction` group.
 * - catalog(): the runtime model catalog (`ctx.llm`), source of the page's
 *   provider/model choices.
 *
 * The bridge only registers when a `webServer` is present (web/desktop
 * profiles); headless/sdk have no web UI and no webServer, so the effect is a
 * no-op there and the bundle stays loadable (optional service inject).
 *
 * @module dsh-quilt-compact/bridge-host
 */
import { resolveConfig } from './config.js';
import { createBridgeRoutes } from './bridge.js';

/** Max bytes the mutate body may carry. */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * Shared route ownership, per webServer instance.
 *
 * `webServer.register` throws on a duplicate exact path, and more than one
 * engine instance can settle (the include-tree row and a preset engine both
 * call {@link registerQuiltBridge} against the same host-plane service).
 * Swallowing that duplicate left the second instance owning NOTHING: when the
 * first instance disposed, every route disappeared while the surviving engine —
 * which had registered no routes of its own — could not bring them back, and
 * the settings page silently lost its bridge.
 *
 * Ownership is therefore shared and reference-counted per path: the first
 * instance registers the route, later ones join as standbys, and when the owner
 * releases the route while standbys remain, one of them re-registers its OWN
 * handler (each instance's routes close over that instance's deps). The registry
 * is keyed by the webServer INSTANCE so that separate servers — and separate
 * test fixtures — never share ownership.
 *
 * @type {WeakMap<object, Map<string, { path: string, owner: object | undefined, dispose: (() => void) | undefined, standby: object[] }>>}
 */
const routeRegistries = new WeakMap();

/** Whether a `webServer.register` failure means "this exact path exists". */
function isDuplicateRoute(error) {
  return /duplicate/i.test(error instanceof Error ? error.message : String(error));
}

/** The per-webServer path registry, created on first use. */
function registryFor(ws) {
  let registry = routeRegistries.get(ws);
  if (registry === undefined) {
    registry = new Map();
    routeRegistries.set(ws, registry);
  }
  return registry;
}

/**
 * Claim one exact path for one engine instance: register it when the server
 * accepts it, join as a standby when the server reports a duplicate.
 *
 * The server is asked FIRST, before the ownership record is trusted: an owner
 * that went away without releasing (a fixture that was never disposed, an
 * abrupt realm unload) would otherwise shadow a path the server would happily
 * accept, and the bridge would silently never register again.
 *
 * @returns a handle for {@link releaseRoute}.
 */
function claimRoute(ws, route) {
  const registry = registryFor(ws);
  let state = registry.get(route.path);
  if (state === undefined) {
    state = { path: route.path, owner: undefined, dispose: undefined, standby: [] };
    registry.set(route.path, state);
  }
  try {
    const dispose = ws.register(route);
    const handle = { path: route.path, ws, route, state, active: true };
    if (state.owner !== undefined) {
      // The server accepted a path we still tracked as owned: that record is
      // stale, so retire it instead of handing the route back to a dead owner.
      state.owner.active = false;
    }
    state.owner = handle;
    state.dispose = dispose;
    return handle;
  } catch (error) {
    if (!isDuplicateRoute(error)) {
      // Genuine registration failure: leave no half-built entry behind.
      if (state.owner === undefined && state.standby.length === 0) registry.delete(route.path);
      throw error;
    }
    // A sibling instance already serves this exact path: join as a standby so
    // the routes survive when that instance goes away (see `releaseRoute`).
    const handle = { path: route.path, ws, route, state, active: true };
    state.standby.push(handle);
    return handle;
  }
}

/**
 * Release one claimed path. An owner hands the route over to a surviving
 * standby (which re-registers its own handler) before letting it go; the last
 * participant disposes the registration and drops the entry.
 */
function releaseRoute(handle) {
  if (handle.active !== true) return;
  handle.active = false;
  const { state, ws } = handle;
  const registry = registryFor(ws);
  if (state.owner === handle) {
    try {
      state.dispose?.();
    } catch {
      // A failing disposer must not break engine teardown.
    }
    state.dispose = undefined;
    state.owner = undefined;
    while (state.standby.length > 0) {
      const next = state.standby.shift();
      if (next.active !== true) continue;
      try {
        state.dispose = next.ws.register(next.route);
        state.owner = next;
        return;
      } catch {
        // The adopter could not register either; try the next standby.
      }
    }
    registry.delete(state.path);
    return;
  }
  const index = state.standby.indexOf(handle);
  if (index >= 0) state.standby.splice(index, 1);
  if (state.owner === undefined && state.standby.length === 0) registry.delete(state.path);
}

/**
 * Register the bridge routes when a web server exists. This is called from the
 * Engine constructor, so it runs from whichever realm the engine mounts in:
 * the host plane (headless/sdk) or the agent-preset `compaction` group
 * (web/desktop). `webServer` and `configEditor` are host-plane services that
 * are NOT isolated, so the preset-group context resolves them along its parent
 * chain; the routes are registered once per engine instance and disposed with
 * its owning context.
 *
 * The webServer may not be up when the engine constructs: cordis activates
 * rows by inject dependency, the engine does not depend on webServer, and in
 * web profiles the include-tree row can mount before `dsh-web-app` starts the
 * server. A one-shot `ctx.get('webServer')` snapshot would miss it and leave
 * the settings page bridge dead forever. Instead we wait for the service the
 * way the official bridge plugins do (`ctx.inject(['webServer'], ...)`), and
 * only fall back to an immediate snapshot when inject is unavailable.
 *
 * Duplicate registrations (e.g. both the include-tree engine and a preset
 * engine settling) are tolerated: `webServer.register` throws on duplicate
 * exact paths, and we treat that as "already served by a sibling instance"
 * rather than failing the engine.
 *
 * @param {import('cordis').Context} ctx - context with webServer (optional), configEditor, llm.
 * @returns {() => void} disposer, or a no-op when no webServer is present.
 */
export function registerQuiltBridge(ctx) {
  const install = (webCtx) => {
    const ws = webCtx.get?.('webServer');
    if (ws === undefined || typeof ws.register !== 'function') return () => {};
    const deps = createBridgeDeps(webCtx);
    const routes = createBridgeRoutes(deps, '/api/dsh-quilt-compact', MAX_BODY_BYTES);
    const handles = [];
    for (const route of routes) {
      // A sibling instance may already serve this exact path: join it as a
      // standby owner instead of failing the engine (see `claimRoute`).
      handles.push(claimRoute(ws, route));
    }
    const disposeAll = () => { for (const handle of handles.splice(0)) releaseRoute(handle); };
    webCtx.effect(() => disposeAll, 'dsh-quilt-compact: bridge routes');
    return disposeAll;
  };

  // Already up: register now. Not yet: wait for the service (free-search
  // pattern). No inject available: ephemeral snapshot, best effort.
  if (ctx.get?.('webServer') !== undefined) return install(ctx);
  if (typeof ctx.inject !== 'function') return () => {};
  let installed;
  const fiber = ctx.inject(['webServer'], (webCtx) => {
    installed = install(webCtx);
  });
  return () => { installed?.(); void fiber?.dispose?.(); };
}

/**
 * Normalize a raw config into the plain object the page edits, resolving any
 * schemastery volatile references (`{ get() }`) so the JSON payload is source
 * text, not live bindings.
 */
function plainConfig(raw) {
  if (raw === undefined || raw === null) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = unwrap(value);
  }
  return out;
}

function unwrap(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function' && value[Symbol.for('cosmokit.volatile.write')] !== undefined) {
    return unwrap(value.get());
  }
  if (Array.isArray(value)) return value.map(unwrap);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = unwrap(v);
    return out;
  }
  return value;
}

/** Locate the preset-group row inside a plugin list, by id and depth. */
function findNestedRow(pluginList, groupId, rowId) {
  if (!Array.isArray(pluginList)) return undefined;
  const group = pluginList.find((p) => p && p.id === groupId && p.group === true);
  const rows = group && Array.isArray(group.config) ? group.config : [];
  return rows.find((r) => r && r.id === rowId);
}

/**
 * Build the bridge dependency bundle from a live context.
 * @param {import('cordis').Context} ctx - context with configEditor, llm (optional webServer).
 * @returns {import('./bridge.js').BridgeDeps}
 */
export function createBridgeDeps(ctx) {
  /** Read the current profile entry list once. */
  const editorEntries = () => {
    const editor = ctx.get('configEditor');
    if (editor === undefined) return [];
    try {
      return editor.entries();
    } catch {
      return [];
    }
  };

  /** The page's target: preset-standard override first, host row otherwise. */
  function locate() {
    const entries = editorEntries();
    const preset = entries.find((e) => e.options?.id === 'preset-standard');
    if (preset !== undefined) {
      const nested = findNestedRow(preset.options?.config?.plugins, 'compaction', 'dsh-quilt-compact');
      if (nested !== undefined) {
        return { kind: 'preset', entry: preset, rowConfig: plainConfig(nested.config) };
      }
    }
    const host = entries.find((e) => e.options?.id === 'dsh-quilt-compact');
    if (host !== undefined) {
      return { kind: 'host', entry: host, rowConfig: plainConfig(host.options?.config) };
    }
    return undefined;
  }

  function read(target) {
    const revision = revisionOf(target.entry, target.rowConfig);
    return { ok: true, revision, value: target.rowConfig };
  }

  /** Content hash of the load-bearing shape: entry id, full raw config. */
  function revisionOf(entry, config) {
    const raw = JSON.stringify([entry.options?.id, entry.options?.name, config]);
    let h = 2166136261;
    for (let i = 0; i < raw.length; i += 1) {
      h ^= raw.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  async function write(config, expectedRevision) {
    const editor = ctx.get('configEditor');
    if (editor === undefined) {
      return { ok: false, code: 'no-editor', message: 'configEditor is not available in this profile.' };
    }
    const target = locate();
    if (target === undefined) {
      return { ok: false, code: 'no-target', message: 'dsh-quilt-compact is not mounted as the compaction backend in this profile.' };
    }
    if (typeof config !== 'object' || config === null) {
      return { ok: false, code: 'rejected', message: 'malformed config payload' };
    }
    if (JSON.stringify(config).length > MAX_BODY_BYTES) {
      return { ok: false, code: 'rejected', message: 'config payload too large' };
    }
    // Fence: refuse a write whose base is out of date.
    const current = read(target);
    if (current.revision !== String(expectedRevision)) {
      return { ok: false, code: 'conflict', message: 'configuration changed elsewhere; discard your draft and retry.' };
    }
    // Schema-validate by resolving: resolveConfig throws on malformed input.
    try {
      resolveConfig(config);
    } catch (error) {
      return { ok: false, code: 'invalid', message: error instanceof Error ? error.message : String(error) };
    }
    try {
      await editor.edit(target.entry, (currentEntryConfig) => {
        let next = currentEntryConfig ?? {};
        if (target.kind === 'preset') {
          // Restate the full preset config; replace only the compaction-group
          // row's config inside the nested plugin list.
          const plugins = Array.isArray(next.plugins) ? next.plugins.map((p) => ({ ...p })) : [];
          const group = plugins.find((p) => p && p.id === 'compaction');
          if (group !== undefined && Array.isArray(group.config)) {
            return {
              ...next,
              plugins: plugins.map((p) => {
                if (p !== group) return p;
                return {
                  ...p,
                  config: group.config.map((r) => (r && r.id === 'dsh-quilt-compact' ? { ...r, config } : r)),
                };
              }),
            };
          }
          return { ...next, plugins };
        }
        // Host row: replace the whole config.
        return { ...next, ...config };
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof Error && /conflict|no longer/i.test(error.message)) {
        return { ok: false, code: 'conflict', message: error.message };
      }
      return { ok: false, code: 'write-failed', message: error instanceof Error ? error.message : String(error) };
    }
  }

  async function catalog() {
    const llm = ctx.get('llm');
    if (llm === undefined || typeof llm.listProviders !== 'function') {
      return { ok: false, code: 'no-llm', message: 'llm service unavailable' };
    }
    try {
      const providers = await llm.listProviders();
      const groups = [];
      for (const provider of providers) {
        let models = [];
        try {
          models = await llm.listModels(provider.id);
        } catch {
          models = [];
        }
        groups.push({
          id: provider.id,
          name: provider.name ?? provider.id,
          models: models.map((m) => ({ id: m.id, name: m.name ?? m.id })),
        });
      }
      return { ok: true, value: { groups } };
    } catch (error) {
      return { ok: false, code: 'catalog-failed', message: error instanceof Error ? error.message : String(error) };
    }
  }

  function status() {
    const entries = editorEntries();
    const hasPreset = entries.some((e) => e.options?.id === 'preset-standard');
    const host = entries.find((e) => e.options?.id === 'dsh-quilt-compact');
    const basic = entries.find((e) => e.options?.id === 'compaction-basic');
    let engineServing = 'none';
    if (hasPreset) {
      const nested = findNestedRow(
        entries.find((e) => e.options?.id === 'preset-standard')?.options?.config?.plugins,
        'compaction',
        'dsh-quilt-compact'
      );
      if (nested !== undefined) engineServing = 'preset';
    } else if (host !== undefined) {
      engineServing = 'host';
    }
    return {
      engineServing,
      basicDisabled: basic?.options?.disabled === true,
      presetOverridden: hasPreset,
    };
  }

  return { locate, read, write, catalog, status };
}
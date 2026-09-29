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
    const disposers = [];
    for (const route of routes) {
      try {
        disposers.push(ws.register(route));
      } catch (error) {
        // A sibling engine instance already served this exact path (the
        // include-tree row and a preset engine can both settle). Keep the
        // routes the instance itself owns and drop the duplicate.
        if (!/duplicate/i.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
    const disposeAll = () => { for (const dispose of disposers) dispose(); };
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
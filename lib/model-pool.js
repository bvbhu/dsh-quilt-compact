/**
 * Runtime validation of the configured model pool against the models that are
 * actually registered in this DSH installation.
 *
 * Why this exists: the pool is written by hand in `cordis.patch.yml`, and
 * nothing in the schema can tell a real route from a typo — `provider: trae`
 * and `provider: traa` are both just strings. A wrong route only fails later,
 * inside a compaction, when the pool has already been tried and the turn is
 * already in trouble. This check moves that failure to plugin load.
 *
 * The authoritative source is the live `ctx.llm` registry, NOT the static
 * profile document: providers are registered at runtime by whatever plugin
 * owns them (`dsh-llm-pi-ai` from its settings section, `dsh-connect-*` from
 * `registerAdapter()`), so only the registry knows the real set.
 *
 * @module dsh-quilt-compact/model-pool
 */

/**
 * Collect every route the live registry currently advertises.
 *
 * A provider whose adapter cannot list models is reported as `unlistable`
 * rather than missing: `listModels()` may legitimately throw for a provider
 * that routes requests without publishing a catalog, and that is not a
 * configuration error.
 *
 * @param ctx - live context whose `llm` registry is read.
 * @param signal - optional cancellation for model discovery.
 * @returns `{ routes, providers, unlistable }` where `routes` is a Set of
 *   `provider/model` keys.
 */
export async function collectAvailableRoutes(ctx, signal) {
  const routes = new Set();
  const providers = new Set();
  const unlistable = new Set();

  let registered;
  try {
    registered = ctx.llm.listProviders();
  } catch (error) {
    throw new Error(`dsh-quilt-compact: cannot enumerate providers (${String(error)}); the model pool cannot be validated`);
  }

  for (const provider of registered) {
    const id = typeof provider === 'string' ? provider : provider?.id ?? provider?.provider;
    if (typeof id !== 'string' || id.length === 0) continue;
    providers.add(id);
    let models;
    try {
      models = await ctx.llm.listModels(id);
    } catch {
      // A provider that cannot list models is not evidence of a bad pool.
      unlistable.add(id);
      continue;
    }
    for (const model of models ?? []) {
      if (typeof model?.id === 'string' && model.id.length > 0) routes.add(`${id}/${model.id}`);
    }
  }

  return { routes, providers, unlistable };
}

/**
 * Check every pool route against the registry.
 *
 * @param ctx - live context whose `llm` registry is read.
 * @param config - resolved engine config (`tiers`).
 * @param signal - optional cancellation for model discovery.
 * @returns `{ ok, unknown, routes, providers, unlistable }`; `unknown` lists
 *   `{ tier, provider, model, key, reason }` for each unresolvable entry.
 */
export async function validateModelPool(ctx, config, signal) {
  const { routes, providers, unlistable } = await collectAvailableRoutes(ctx, signal);
  const unknown = [];
  for (const tier of config.tiers) {
    for (const entry of tier.models) {
      const key = `${entry.provider}/${entry.model}`;
      if (routes.has(key)) continue;
      // A provider that exists but cannot enumerate models is reported
      // differently from one that is not registered at all.
      const reason = !providers.has(entry.provider)
        ? 'provider is not registered'
        : unlistable.has(entry.provider)
          ? 'provider does not publish a model catalog'
          : 'model is not in the provider catalog';
      unknown.push({ tier: tier.name, provider: entry.provider, model: entry.model, key, reason });
    }
  }
  return { ok: unknown.length === 0, unknown, routes, providers, unlistable };
}

/**
 * Load-time validation and resolved configuration for the dsh-quilt-compact
 * backend.
 *
 * The schema mirrors the design-v3 config surface; defaults are resolved in
 * code (`resolveConfig`) exactly like `dsh-compaction-basic` does, so the
 * public schema stays permissive while the resolved config is immutable and
 * complete.
 *
 * @module dsh-quilt-compact/config
 */
import z from '@deepseek-ai/schemastery';

/** Default fraction of a model context window one chunk may occupy. */
const DEFAULT_CHUNK_RATIO = 0.8;
/** Default overlap between adjacent chunks, as a fraction of `chunkTokens`. */
const DEFAULT_CHUNK_OVERLAP_RATIO = 0.1;
/**
 * Default merge window (归并前最多保留多少上下文, tokens). `mergeMaxContextTokens`
 * ALWAYS resolves to a value: 128k when the config does not set it — there is
 * no "unset → pool-derived" branch. 128k is the typical large-model window and
 * the "ten condensed digests fit within 100k" engineering assumption.
 */
const DEFAULT_MERGE_MAX_CONTEXT_TOKENS = 128000;
/** Session-model fallback is enabled unless configured off. */
const DEFAULT_FALLBACK_TO_SESSION_MODEL = true;
/**
 * Stage-0 preprocessing defaults.
 *
 * There is deliberately NO `headMiddleTail` entry. That transform deleted the
 * middle of an oversized document, and length management is the chunker's job
 * (see `stage0/pipeline.js`): a destructive trim here cost ~35 points of
 * measured recall against letting Stage 0c handle size.
 */
const DEFAULT_PREPROCESSING = Object.freeze({
  dedup: true,
  purgeErrors: true,
  astSkeleton: Object.freeze({ enabled: true, maxDepth: 2 }),
  logCondense: Object.freeze({ mode: 'balanced', maxLines: 200 }),
});

/** Run-log defaults (JSONL snapshot+result evaluation file). */
const DEFAULT_RUN_RECORD = Object.freeze({
  enabled: false,
  maxEntries: 200,
  snapshotChars: 20000,
  path: '',
});

/** Cooldown mode: fixed-duration or daily-reset at a fixed UTC hour. */
const cooldownSchema = z.union([
  z.object({
    mode: z.string(),
    hours: z.number().min(0),
  }),
  z.object({
    mode: z.string(),
    hour: z.number().step(1).min(0).max(23),
  }),
]);

/** One pool model entry. */
const modelSchema = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  maxConcurrent: z.number().step(1).min(1),
  cooldown: cooldownSchema.required(),
});

/** One tier of the model pool. */
const tierSchema = z.object({
  name: z.string().required(),
  models: z.array(modelSchema).min(1).required(),
});

/** Stage-0 preprocessing configuration (kept in step with `Config`). */
const preprocessingSchema = z.object({
  dedup: z.boolean(),
  purgeErrors: z.boolean(),
  astSkeleton: z.object({
    enabled: z.boolean(),
    maxDepth: z.number().step(1).min(0),
  }),
  logCondense: z.object({
    mode: z.string(),
    maxLines: z.number().step(1).min(0),
  }),
});

/** Run-log (JSONL snapshot+result evaluation file) configuration. */
const runRecordSchema = z.object({
  enabled: z.boolean(),
  maxEntries: z.number().step(1).min(1),
  snapshotChars: z.number().step(1).min(0),
  path: z.string(),
});

/**
 * Public plugin configuration.
 *
 * Every field is `.volatile()`. A volatile field is what makes a value
 * editable at runtime: `dsh-settings` accepts a write only under a volatile
 * node (`isVolatilePath`), and the plugin receives the field as a live
 * `{ get(), [write] }` reference instead of a frozen copy, so an edit reaches
 * the running engine without a restart. `resolveConfig()` unwraps those
 * references, so the rest of the plugin still sees plain values.
 *
 * Note that volatility is necessary but NOT sufficient for a settings UI:
 * `dsh-settings` reports `autoGenerate` for clients that build pages from the
 * schema, and no shipped client does so. The page for this plugin is
 * `client/client.js`, registered into the `plugins.item` slot.
 *
 * `tiers` is volatile as a WHOLE rather than field-by-field: schemastery
 * rejects a volatile field inside an array element (`volatile fields require a
 * fixed object path without an enclosing volatile field`), because an array
 * element's path contains a `*` wildcard. Marking the whole array is therefore
 * the only legal shape, and it is also the right one — a model pool is edited
 * as a unit, and the config layer replaces arrays wholesale anyway.
 */
export const Config = z.object({
  chunkRatio: z.number().min(0).volatile(),
  chunkOverlapRatio: z.number().min(0).volatile(),
  fallbackToSessionModel: z.boolean().volatile(),
  chunkPromptSuffix: z.string().volatile(),
  mergePromptSuffix: z.string().volatile(),
  tiers: z.array(tierSchema).min(1).required().volatile(),
  // 归并前最多保留多少上下文（归并窗口，token 数）。恒有值：设置后归并窗口
  // = 该值，未设置时默认 128k（DEFAULT_MERGE_MAX_CONTEXT_TOKENS）。
  mergeMaxContextTokens: z.number().step(1).min(1).volatile(),
  preprocessing: z.object({
    dedup: z.boolean(),
    purgeErrors: z.boolean(),
    astSkeleton: z.object({
      enabled: z.boolean(),
      maxDepth: z.number().step(1).min(0),
    }),
    logCondense: z.object({
      mode: z.string(),
      maxLines: z.number().step(1).min(0),
    }),
  }).volatile(),
  runRecord: runRecordSchema.volatile(),
});

/** Complete public top-level configuration key set. */
const CONFIG_KEYS = new Set([
  'chunkRatio',
  'chunkOverlapRatio',
  'fallbackToSessionModel',
  'chunkPromptSuffix',
  'mergePromptSuffix',
  'tiers',
  'mergeMaxContextTokens',
  'preprocessing',
  'runRecord',
]);

/**
 * Removed top-level keys that old configs may still carry.
 *
 * `mergeTiers` (v7's dedicated merge pool) is gone: the merge reuses the main
 * `tiers` and descends them to find a large-window route, and the merge window
 * is controlled by `mergeMaxContextTokens`. A config written before the removal
 * still spells `mergeTiers` out. Such a config must keep LOADING — an upgrade
 * that throws on every stale-but-harmless field is a migration, not a cleanup —
 * so the key is accepted here, ignored by the pipeline, and reported through
 * {@link resolveConfig}'s return value for a one-line warning.
 */
const DEPRECATED_CONFIG_KEYS = new Set(['mergeTiers']);

/** Complete model-entry key set. */
const MODEL_KEYS = new Set(['provider', 'model', 'maxConcurrent', 'cooldown']);
/** Complete tier key set. */
const TIER_KEYS = new Set(['name', 'models']);
/**
 * Complete preprocessing key set.
 *
 * `headMiddleTail` is deliberately NOT here: it was removed from the pipeline
 * (length control belongs to the chunker). Its value is still read below only
 * to detect and warn about stale configs — see `resolvePreprocessing`.
 */
const PREPROCESSING_KEYS = new Set([
  'dedup',
  'purgeErrors',
  'astSkeleton',
  'logCondense',
]);

/**
 * Legacy preprocessing keys that old configs may still carry.
 *
 * The `headMiddleTail` transform deleted the middle of oversized documents and
 * was removed from the running pipeline; a config written before that removal
 * still spells the block out. Such a config must keep LOADING — an upgrade that
 * throws on every stale-but-harmless field is a migration, not a cleanup — so
 * the key is accepted here, ignored by the pipeline, and reported through
 * {@link resolvePreprocessing}'s return value for a one-line warning.
 */
const DEPRECATED_PREPROCESSING_KEYS = new Set(['headMiddleTail']);

/** Reject stale or misspelled keys before defaults can hide them. */
function validateKeys(config, keys, name) {
  for (const key of Object.keys(config)) {
    if (!keys.has(key)) throw new Error(`${name}: unknown key "${key}"`);
  }
}

/**
 * Unwrap a schemastery volatile reference.
 *
 * `Config` marks its fields `.volatile()` so the Web settings page can edit
 * them live. A volatile field resolves to a `{ get(), [cosmokit.volatile.write] }`
 * reference rather than the plain value (see `@deepseek-ai/cosmokit`), so every
 * read has to go through `.get()`. Plain values — which is what the unit tests
 * and a direct `new QuiltCompactEngine(ctx, {...})` supply — pass through
 * unchanged, which keeps `resolveConfig()` usable both ways.
 *
 * @param value - a resolved config field, possibly a volatile reference.
 * @returns the current plain value.
 */
export function readConfigValue(value) {
  return isUnknownRecord(value) && typeof value.get === 'function' ? value.get() : value;
}

/** Unwrap every top-level field of a resolved config object. */
function unwrapConfig(config) {
  const plain = {};
  for (const [key, value] of Object.entries(config)) plain[key] = readConfigValue(value);
  return plain;
}

/** Resolve and validate the raw plugin configuration. */
export function resolveConfig(rawConfig = {}) {
  if (!isUnknownRecord(rawConfig)) throw new Error('QuiltCompactConfig must be an object');
  const config = unwrapConfig(rawConfig);
  // A removed key (`mergeTiers`) is accepted so stale configs keep loading; it
  // is reported through the return value for a warning. Everything else must
  // still be a known key.
  validateKeys(config, new Set([...CONFIG_KEYS, ...DEPRECATED_CONFIG_KEYS]), 'QuiltCompactConfig');
  const deprecatedConfig = Object.keys(config).filter((key) => DEPRECATED_CONFIG_KEYS.has(key));

  const chunkRatio = config.chunkRatio ?? DEFAULT_CHUNK_RATIO;
  assertRatio('QuiltCompactConfig.chunkRatio', chunkRatio);
  const chunkOverlapRatio = config.chunkOverlapRatio ?? DEFAULT_CHUNK_OVERLAP_RATIO;
  if (typeof chunkOverlapRatio !== 'number' || !Number.isFinite(chunkOverlapRatio) || chunkOverlapRatio < 0) {
    throw new Error(`QuiltCompactConfig.chunkOverlapRatio (${String(chunkOverlapRatio)}) must be a finite number >= 0`);
  }
  if (chunkOverlapRatio >= 1) {
    throw new Error(`QuiltCompactConfig.chunkOverlapRatio (${chunkOverlapRatio}) must be less than 1`);
  }
  const fallbackToSessionModel = config.fallbackToSessionModel ?? DEFAULT_FALLBACK_TO_SESSION_MODEL;
  if (typeof fallbackToSessionModel !== 'boolean') throw new Error('QuiltCompactConfig.fallbackToSessionModel must be a boolean');
  if (config.chunkPromptSuffix !== undefined && typeof config.chunkPromptSuffix !== 'string') {
    throw new Error('QuiltCompactConfig.chunkPromptSuffix must be a string');
  }
  if (config.mergePromptSuffix !== undefined && typeof config.mergePromptSuffix !== 'string') {
    throw new Error('QuiltCompactConfig.mergePromptSuffix must be a string');
  }

  const tiers = resolveTiers(config.tiers);
  // 归并前最多保留多少上下文（归并窗口，token 数）。恒有值：未设置时默认
  // 128k（DEFAULT_MERGE_MAX_CONTEXT_TOKENS）——不存在"未设置 → 池推导"分支。
  const mergeMaxContextTokens = config.mergeMaxContextTokens ?? DEFAULT_MERGE_MAX_CONTEXT_TOKENS;
  if (typeof mergeMaxContextTokens !== 'number'
    || !Number.isInteger(mergeMaxContextTokens)
    || mergeMaxContextTokens < 1) {
    throw new Error(`QuiltCompactConfig.mergeMaxContextTokens (${String(mergeMaxContextTokens)}) must be a positive integer`);
  }
  const preprocessing = resolvePreprocessing(config.preprocessing);
  const runRecord = resolveRunRecord(config.runRecord);

  return Object.freeze({
    chunkRatio,
    chunkOverlapRatio,
    fallbackToSessionModel,
    chunkPromptSuffix: config.chunkPromptSuffix ?? '',
    mergePromptSuffix: config.mergePromptSuffix ?? '',
    tiers,
    // 归并前最多保留多少上下文（归并窗口）。归并没有专用模型池：归并链复用
    // 主 `tiers`，在池内逐级下降（tier → tier）找 contextWindow 装得下归并的
    // 路由；这个配置直接设定归并预算（默认 128k，恒有值）。
    mergeMaxContextTokens,
    preprocessing: preprocessing.value,
    runRecord,
    deprecatedPreprocessing: Object.freeze(preprocessing.deprecated),
    deprecatedConfig: Object.freeze(deprecatedConfig),
  });
}

/** Validate, detach, and freeze one tier list. */
function resolveTiers(configured) {
  if (configured === undefined) {
    throw new Error('QuiltCompactConfig.tiers is required: the model pool must declare at least one tier');
  }
  if (!Array.isArray(configured) || configured.length === 0) {
    throw new Error('QuiltCompactConfig.tiers must be a non-empty array');
  }
  const seenNames = new Set();
  const seenRoutes = new Set();
  return configured.map((tier, index) => {
    if (!isUnknownRecord(tier)) throw new Error(`QuiltCompactConfig.tiers[${index}] must be an object`);
    validateKeys(tier, TIER_KEYS, `QuiltCompactConfig.tiers[${index}]`);
    if (typeof tier.name !== 'string' || tier.name.length === 0) {
      throw new Error(`QuiltCompactConfig.tiers[${index}].name must be a non-empty string`);
    }
    if (seenNames.has(tier.name)) throw new Error(`QuiltCompactConfig: duplicate tier name "${tier.name}"`);
    seenNames.add(tier.name);
    if (!Array.isArray(tier.models) || tier.models.length === 0) {
      throw new Error(`QuiltCompactConfig.tiers[${index}] (${tier.name}): models must be a non-empty array`);
    }
    const models = tier.models.map((source, modelIndex) => {
      if (!isUnknownRecord(source)) {
        throw new Error(`QuiltCompactConfig.tiers[${index}].models[${modelIndex}] must be an object`);
      }
      validateKeys(source, MODEL_KEYS, `QuiltCompactConfig.tiers[${index}].models[${modelIndex}]`);
      assertNonEmptyString(`...models[${modelIndex}].provider`, source.provider);
      assertNonEmptyString(`...models[${modelIndex}].model`, source.model);
      const maxConcurrent = source.maxConcurrent ?? 1;
      if (typeof maxConcurrent !== 'number' || !Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
        throw new Error(`QuiltCompactConfig.tiers[${index}].models[${modelIndex}].maxConcurrent (${String(maxConcurrent)}) must be a positive integer`);
      }
      if (!isUnknownRecord(source.cooldown)) {
        throw new Error(`QuiltCompactConfig.tiers[${index}].models[${modelIndex}].cooldown must be an object`);
      }
      const cooldown = resolveCooldown(source.cooldown, `QuiltCompactConfig.tiers[${index}].models[${modelIndex}].cooldown`);
      const routeKey = `${source.provider}/${source.model}`;
      if (seenRoutes.has(routeKey)) {
        throw new Error(`QuiltCompactConfig: duplicate pool route "${routeKey}"`);
      }
      seenRoutes.add(routeKey);
      return Object.freeze({
        provider: source.provider,
        model: source.model,
        maxConcurrent,
        cooldown,
        key: routeKey,
      });
    });
    return Object.freeze({
      name: tier.name,
      models: Object.freeze(models),
    });
  });
}

/** Validate one cooldown config and return the frozen literal. */
function resolveCooldown(value, name) {
  if (value.mode === 'duration') {
    if (!('hours' in value) || typeof value.hours !== 'number' || !Number.isFinite(value.hours) || value.hours <= 0) {
      throw new Error(`${name}: duration hours must be a positive finite number`);
    }
    if ('hour' in value) throw new Error(`${name}: 'hour' is only valid for dailyReset`);
    return Object.freeze({ mode: 'duration', hours: value.hours });
  }
  if (value.mode === 'dailyReset') {
    if (!('hour' in value) || typeof value.hour !== 'number' || !Number.isInteger(value.hour) || value.hour < 0 || value.hour > 23) {
      throw new Error(`${name}: dailyReset hour must be an integer from 0 through 23`);
    }
    if ('hours' in value) throw new Error(`${name}: 'hours' is only valid for duration`);
    return Object.freeze({ mode: 'dailyReset', hour: value.hour });
  }
  throw new Error(`${name}: cooldown mode must be 'duration' or 'dailyReset', got ${String(value.mode)}`);
}

/** Resolve Stage-0 preprocessing with defaults, shallow-validated. */
function resolvePreprocessing(configured) {
  if (configured === undefined) return { value: deepCopy(DEFAULT_PREPROCESSING), deprecated: [] };
  if (!isUnknownRecord(configured)) throw new Error('QuiltCompactConfig.preprocessing must be an object');
  // A key may be unknown-but-currently-accepted (a deprecated key written by an
  // older config) or unknown-and-misspelled (a NEW mistake). validateKeys is
  // strict; let it reject everything EXCEPT the exact legacy names, which we
  // then report through the return value for a warning.
  validateKeys(
    configured,
    new Set([...PREPROCESSING_KEYS, ...DEPRECATED_PREPROCESSING_KEYS]),
    'QuiltCompactConfig.preprocessing',
  );
  // Detect keys from configs written before their removal. They are NOT in
  // PREPROCESSING_KEYS (so misspelled NEW keys still fail loud), but an exact
  // match here turns the hard throw into a reported deprecation.
  const deprecated = Object.keys(configured).filter((key) => DEPRECATED_PREPROCESSING_KEYS.has(key));
  const astSkeleton = configured.astSkeleton ?? DEFAULT_PREPROCESSING.astSkeleton;
  if (!isUnknownRecord(astSkeleton)) throw new Error('QuiltCompactConfig.preprocessing.astSkeleton must be an object');
  const ast = {
    enabled: astSkeleton.enabled ?? DEFAULT_PREPROCESSING.astSkeleton.enabled,
    maxDepth: astSkeleton.maxDepth ?? DEFAULT_PREPROCESSING.astSkeleton.maxDepth,
  };
  if (typeof ast.enabled !== 'boolean') throw new Error('QuiltCompactConfig.preprocessing.astSkeleton.enabled must be a boolean');
  assertNonNegativeInteger('QuiltCompactConfig.preprocessing.astSkeleton.maxDepth', ast.maxDepth);
  const logCondense = configured.logCondense ?? DEFAULT_PREPROCESSING.logCondense;
  if (!isUnknownRecord(logCondense)) throw new Error('QuiltCompactConfig.preprocessing.logCondense must be an object');
  const mode = logCondense.mode ?? DEFAULT_PREPROCESSING.logCondense.mode;
  if (mode !== 'balanced' && mode !== 'head' && mode !== 'tail') {
    throw new Error(`QuiltCompactConfig.preprocessing.logCondense.mode must be 'balanced', 'head', or 'tail', got ${String(mode)}`);
  }
  const maxLines = logCondense.maxLines ?? DEFAULT_PREPROCESSING.logCondense.maxLines;
  assertNonNegativeInteger('QuiltCompactConfig.preprocessing.logCondense.maxLines', maxLines);
  return {
    value: Object.freeze({
      dedup: configured.dedup ?? DEFAULT_PREPROCESSING.dedup,
      purgeErrors: configured.purgeErrors ?? DEFAULT_PREPROCESSING.purgeErrors,
      astSkeleton: Object.freeze(ast),
      logCondense: Object.freeze({ mode, maxLines }),
    }),
    deprecated,
  };
}

/** Validate one run-log config with defaults, frozen. */
function resolveRunRecord(configured) {
  if (configured === undefined) return deepCopy(DEFAULT_RUN_RECORD);
  if (!isUnknownRecord(configured)) throw new Error('QuiltCompactConfig.runRecord must be an object');
  const enabled = configured.enabled ?? DEFAULT_RUN_RECORD.enabled;
  if (typeof enabled !== 'boolean') throw new Error('QuiltCompactConfig.runRecord.enabled must be a boolean');
  assertNonNegativeInteger('QuiltCompactConfig.runRecord.maxEntries', configured.maxEntries ?? DEFAULT_RUN_RECORD.maxEntries);
  if ((configured.maxEntries ?? DEFAULT_RUN_RECORD.maxEntries) < 1) {
    throw new Error('QuiltCompactConfig.runRecord.maxEntries must be >= 1');
  }
  assertNonNegativeInteger('QuiltCompactConfig.runRecord.snapshotChars', configured.snapshotChars ?? DEFAULT_RUN_RECORD.snapshotChars);
  const path = configured.path ?? DEFAULT_RUN_RECORD.path;
  if (typeof path !== 'string') throw new Error('QuiltCompactConfig.runRecord.path must be a string');
  return Object.freeze({
    enabled,
    maxEntries: configured.maxEntries ?? DEFAULT_RUN_RECORD.maxEntries,
    snapshotChars: configured.snapshotChars ?? DEFAULT_RUN_RECORD.snapshotChars,
    path,
  });
}

/** Deep-copy a frozen nested default so callers never mutate shared state. */
function deepCopy(value) {
  if (Array.isArray(value)) return value.map(deepCopy);
  if (isUnknownRecord(value)) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = deepCopy(entry);
    return out;
  }
  return value;
}

function isUnknownRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(name, value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`);
}

function assertNonNegativeInteger(name, value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} (${String(value)}) must be a non-negative integer`);
  }
}

function assertRatio(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} (${String(value)}) must be a number in (0, 1]`);
  }
}

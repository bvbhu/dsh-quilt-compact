/**
 * Config resolution and validation.
 * @module dsh-quilt-compact/test/unit/config
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../lib/config.js';
import { chainStateSpec, routeKey } from '../../lib/spec.js';

const base = () => ({
  tiers: [
    {
      name: 'primary',
      models: [
        { provider: 'openrouter', model: 'openrouter/free', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 24 } },
        { provider: 'sensenova-1', model: 'deepseek-v4-flash', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 5 } },
      ],
    },
  ],
});

test('defaults are applied for every omitted field', () => {
  const config = resolveConfig(base());
  assert.equal(config.chunkRatio, 0.8);
  assert.equal(config.chunkOverlapRatio, 0.1);
  assert.equal(config.fallbackToSessionModel, true);
  assert.equal(config.chunkPromptSuffix, '');
  assert.equal(config.mergePromptSuffix, '');
  assert.equal(config.preprocessing.dedup, true);
  assert.equal(config.preprocessing.purgeErrors, true);
  // `headMiddleTail` was removed from the config surface entirely: the
  // transform deleted content to manage length, which is the chunker's job.
  assert.deepEqual(Object.keys(config.preprocessing).sort(), ['astSkeleton', 'dedup', 'logCondense', 'purgeErrors']);
  assert.equal(config.preprocessing.astSkeleton.enabled, true);
  assert.equal(config.preprocessing.astSkeleton.maxDepth, 2);
  assert.equal(config.preprocessing.logCondense.mode, 'balanced');
  assert.equal(config.preprocessing.logCondense.maxLines, 200);
  assert.deepEqual(config.runRecord, { enabled: false, maxEntries: 200, snapshotChars: 0, path: '' });
});

test('runRecord resolution applies defaults and validates ranges', () => {
  const partial = resolveConfig({ ...base(), runRecord: { enabled: false } });
  assert.equal(partial.runRecord.enabled, false);
  assert.equal(partial.runRecord.maxEntries, 200);
  assert.equal(partial.runRecord.snapshotChars, 0);
  assert.equal(partial.runRecord.path, '');
  const pinned = resolveConfig({ ...base(), runRecord: { enabled: true, maxEntries: 5, snapshotChars: 1000, path: 'D:/tmp/runs.jsonl' } });
  assert.deepEqual(pinned.runRecord, { enabled: true, maxEntries: 5, snapshotChars: 1000, path: 'D:/tmp/runs.jsonl' });
  assert.throws(() => resolveConfig({ ...base(), runRecord: { maxEntries: 0 } }), /maxEntries must be >= 1/);
  assert.throws(() => resolveConfig({ ...base(), runRecord: { snapshotChars: -1 } }), /non-negative integer/);
  assert.throws(() => resolveConfig({ ...base(), runRecord: { enabled: 'yes' } }), /must be a boolean/);
});

test('maxConcurrent defaults to 1 and route keys are provider/model', () => {
  const config = resolveConfig(base());
  const [first, second] = config.tiers[0].models;
  assert.equal(first.maxConcurrent, 1);
  assert.equal(first.key, routeKey('openrouter', 'openrouter/free'));
  assert.equal(second.key, 'sensenova-1/deepseek-v4-flash');
});

test('decimal duration hours survive resolution', () => {
  const config = resolveConfig({
    tiers: [{ name: 't', models: [{ provider: 'p', model: 'm', cooldown: { mode: 'duration', hours: 0.5 } }] }],
  });
  assert.equal(config.tiers[0].models[0].cooldown.hours, 0.5);
});

test('rejects unknown top-level keys', () => {
  assert.throws(() => resolveConfig({ ...base(), nope: 1 }), /unknown key "nope"/);
});

test('rejects unknown model keys', () => {
  assert.throws(
    () => resolveConfig({ tiers: [{ name: 't', models: [{ provider: 'p', model: 'm', retry: 3, cooldown: { mode: 'duration', hours: 1 } }] }] }),
    /unknown key "retry"/,
  );
});

test('a legacy headMiddleTail block loads, is ignored, and is reported deprecated', () => {
  // Configs written before the removal still spell the block out. They must
  // keep LOADING (an upgrade that throws on stale-but-harmless fields is a
  // migration, not a cleanup), be ignored by the pipeline, and be surfaced so
  // the engine can warn once.
  const config = resolveConfig({
    tiers: [{ name: 't', models: [{ provider: 'p', model: 'm', cooldown: { mode: 'duration', hours: 1 } }] }],
    preprocessing: {
      dedup: true,
      purgeErrors: true,
      headMiddleTail: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
      logCondense: { mode: 'balanced', maxLines: 200 },
    },
  });
  assert.deepEqual(config.deprecatedPreprocessing, ['headMiddleTail'], 'the stale key is reported, not thrown');
  assert.deepEqual(
    Object.keys(config.preprocessing).sort(),
    ['astSkeleton', 'dedup', 'logCondense', 'purgeErrors'],
    'the ignored block does not leak into the running preprocessing config',
  );
});

test('an unknown preprocessing key still fails loud', () => {
  assert.throws(
    () => resolveConfig({
      tiers: [{ name: 't', models: [{ provider: 'p', model: 'm', cooldown: { mode: 'duration', hours: 1 } }] }],
      preprocessing: { hmt: { thresholdChars: 8192 } },
    }),
    /unknown key "hmt"/,
    'a genuinely misspelled NEW key must still throw',
  );
});

test('rejects a tier without models', () => {
  assert.throws(() => resolveConfig({ tiers: [{ name: 't', models: [] }] }), /models must be a non-empty array/);
});

test('rejects missing tiers entirely', () => {
  assert.throws(() => resolveConfig({}), /tiers is required/);
});

test('rejects duplicate route keys across tiers', () => {
  assert.throws(
    () => resolveConfig({
      tiers: [
        { name: 'a', models: [{ provider: 'p', model: 'm', cooldown: { mode: 'duration', hours: 1 } }] },
        { name: 'b', models: [{ provider: 'p', model: 'm', cooldown: { mode: 'duration', hours: 1 } }] },
      ],
    }),
    /duplicate pool route "p\/m"/,
  );
});

test('rejects invalid cooldown shapes', () => {
  assert.throws(
    () => resolveConfig({ tiers: [{ name: 't', models: [{ provider: 'p', model: 'm', cooldown: { mode: 'duration', hours: 0 } }] }] }),
    /positive finite number/,
  );
  assert.throws(
    () => resolveConfig({ tiers: [{ name: 't', models: [{ provider: 'p', model: 'm', cooldown: { mode: 'duration', hours: -1 } }] }] }),
    /positive finite number/,
  );
  assert.throws(
    () => resolveConfig({ tiers: [{ name: 't', models: [{ provider: 'p', model: 'm', cooldown: { mode: 'duration', hours: 1, hour: 3 } }] }] }),
    /'hour' is not valid/,
  );
  // daily-reset was removed: a fixed UTC hour produced multi-hour blind windows.
  assert.throws(
    () => resolveConfig({ tiers: [{ name: 't', models: [{ provider: 'p', model: 'm', cooldown: { mode: 'dailyReset', hour: 0 } }] }] }),
    /daily-reset was removed/,
  );
  assert.throws(
    () => resolveConfig({ tiers: [{ name: 't', models: [{ provider: 'p', model: 'm', cooldown: { mode: 'weekly' } }] }] }),
    /daily-reset was removed/,
  );
});

test('a cooldown without hours defaults to one hour (and mode may be omitted)', () => {
  const omitted = resolveConfig({ tiers: [{ name: 't', models: [{ provider: 'p', model: 'm', cooldown: {} }] }] });
  assert.deepEqual(omitted.tiers[0].models[0].cooldown, { mode: 'duration', hours: 1 });
  const bare = resolveConfig({ tiers: [{ name: 't', models: [{ provider: 'p', model: 'm', cooldown: { hours: 3 } }] }] });
  assert.deepEqual(bare.tiers[0].models[0].cooldown, { mode: 'duration', hours: 3 });
});

test('rejects chunkOverlapRatio >= 1', () => {
  assert.throws(() => resolveConfig({ ...base(), chunkOverlapRatio: 1 }), /must be less than 1/);
});

test('the domain spec validates at load time (underscore name, non-null global)', () => {
  assert.equal(chainStateSpec.name, 'dsh_quilt_compact_state');
  assert.equal(chainStateSpec.version, 1);
  assert.ok(chainStateSpec.tables.routes);
  assert.deepEqual(chainStateSpec.global.initial, { schemaVersion: 1 });
});

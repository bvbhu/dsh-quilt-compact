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
        { provider: 'openrouter', model: 'openrouter/free', maxConcurrent: 1, cooldown: { mode: 'dailyReset', hour: 0 } },
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
  assert.deepEqual(config.preprocessing.headMiddleTail, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 });
  assert.equal(config.preprocessing.astSkeleton.enabled, true);
  assert.equal(config.preprocessing.astSkeleton.maxDepth, 2);
  assert.equal(config.preprocessing.logCondense.mode, 'balanced');
  assert.equal(config.preprocessing.logCondense.maxLines, 200);
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
    () => resolveConfig({ tiers: [{ name: 't', models: [{ provider: 'p', model: 'm', cooldown: { mode: 'duration', hours: 1, hour: 3 } }] }] }),
    /'hour' is only valid for dailyReset/,
  );
  assert.throws(
    () => resolveConfig({ tiers: [{ name: 't', models: [{ provider: 'p', model: 'm', cooldown: { mode: 'weekly', hour: 0 } }] }] }),
    /cooldown mode must be 'duration' or 'dailyReset'/,
  );
  assert.throws(
    () => resolveConfig({ tiers: [{ name: 't', models: [{ provider: 'p', model: 'm', cooldown: { mode: 'dailyReset', hour: 24 } }] }] }),
    /integer from 0 through 23/,
  );
});

test('rejects chunkOverlapRatio >= 1', () => {
  assert.throws(() => resolveConfig({ ...base(), chunkOverlapRatio: 1 }), /must be less than 1/);
});

test('the domain spec validates at load time (underscore name, non-null global)', () => {
  assert.equal(chainStateSpec.name, 'compaction_chain_state');
  assert.equal(chainStateSpec.version, 1);
  assert.ok(chainStateSpec.tables.routes);
  assert.deepEqual(chainStateSpec.global.initial, { schemaVersion: 1 });
});

/**
 * Cooldown arithmetic and store semantics.
 * @module dsh-quilt-compact/test/unit/cooldown
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCooldownUntil, MemoryCooldownStore } from '../../lib/cooldown.js';

test('duration cooldown adds fixed hours (integer and decimal)', () => {
  const now = 1_000_000_000_000;
  assert.equal(computeCooldownUntil({ mode: 'duration', hours: 5 }, now), now + 5 * 3600 * 1000);
  assert.equal(computeCooldownUntil({ mode: 'duration', hours: 0.5 }, now), now + 0.5 * 3600 * 1000);
  assert.equal(computeCooldownUntil({ mode: 'duration', hours: 0.0001 }, now), now + 360);
});

test('dailyReset cooldown rolls to the next UTC hour point', () => {
  // 2026-01-02 03:20:00 UTC -> next 04:00 UTC
  const now = Date.UTC(2026, 0, 2, 3, 20, 0, 0);
  const until = computeCooldownUntil({ mode: 'dailyReset', hour: 4 }, now);
  assert.equal(until, Date.UTC(2026, 0, 2, 4, 0, 0, 0));
});

test('dailyReset with hour already passed goes to tomorrow', () => {
  const now = Date.UTC(2026, 0, 2, 15, 0, 0, 0);
  const until = computeCooldownUntil({ mode: 'dailyReset', hour: 4 }, now);
  assert.equal(until, Date.UTC(2026, 0, 3, 4, 0, 0, 0));
});

test('dailyReset exactly at the hour point waits until the next day', () => {
  const now = Date.UTC(2026, 0, 2, 4, 0, 0, 0);
  const until = computeCooldownUntil({ mode: 'dailyReset', hour: 4 }, now);
  assert.equal(until, Date.UTC(2026, 0, 3, 4, 0, 0, 0));
});

test('dailyReset hour 0 (UTC midnight) rolls across month boundaries', () => {
  const now = Date.UTC(2026, 11, 31, 23, 30, 0, 0);
  const until = computeCooldownUntil({ mode: 'dailyReset', hour: 0 }, now);
  assert.equal(until, Date.UTC(2027, 0, 1, 0, 0, 0, 0));
});

test('memory store: healthy without a record, cooldown after apply, lazy expiry', async () => {
  const store = new MemoryCooldownStore();
  const key = 'p/m';
  assert.equal(store.isHealthy(key, 1_000), true);

  await store.applyCooldown(key, 2_000);
  assert.equal(store.isHealthy(key, 1_999), false);
  assert.equal(store.isHealthy(key, 2_000), true);
  // lazy cleanup: expired record stays in the store, reads treat it as healthy
  assert.deepEqual(store.keys(), [key]);
  assert.equal(store.cooldownUntil(key), 2_000);
});

test('memory store: applyCooldown is write-throttled (no transition, no write)', async () => {
  const store = new MemoryCooldownStore();
  const key = 'p/m';
  await store.applyCooldown(key, 5_000);
  await store.applyCooldown(key, 5_000); // same timestamp: no-op
  assert.equal(store.cooldownUntil(key), 5_000);
  await store.applyCooldown(key, 6_000); // transition: writes
  assert.equal(store.cooldownUntil(key), 6_000);
});

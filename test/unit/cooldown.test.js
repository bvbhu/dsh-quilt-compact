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
  assert.equal(computeCooldownUntil({ mode: 'duration', hours: 1 }, now), now + 3600 * 1000);
  assert.equal(computeCooldownUntil({ mode: 'duration', hours: 0.5 }, now), now + 0.5 * 3600 * 1000);
  assert.equal(computeCooldownUntil({ mode: 'duration', hours: 0.0001 }, now), now + 360);
});

test('cooldown is duration-only: no timezone-dependent reset', () => {
  // A fixed UTC hour used to be supported and silently produced multi-hour
  // blind windows when misconfigured. Duration is anchored to the failure.
  const now = Date.UTC(2026, 0, 2, 3, 20, 0, 0);
  const until = computeCooldownUntil({ mode: 'duration', hours: 1 }, now);
  assert.equal(until, now + 3600 * 1000, 'one hour from the failure, not from a wall-clock hour');
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

test('clearAll drops every cooldown so the whole pool is healthy again', async () => {
  const store = new MemoryCooldownStore();
  await store.applyCooldown('p1/m1', 5_000);
  await store.applyCooldown('p1/m2', 7_000);
  await store.applyCooldown('p2/m3', 9_000);
  assert.equal(store.isHealthy('p1/m1', 1_000), false);
  assert.equal(store.isHealthy('p2/m3', 1_000), false);

  await store.clearAll();

  assert.deepEqual(store.keys(), [], 'no records survive a reset');
  for (const key of ['p1/m1', 'p1/m2', 'p2/m3']) {
    assert.equal(store.isHealthy(key, 1_000), true, `${key} is healthy after the reset`);
    assert.equal(store.cooldownUntil(key), 0);
  }
  // Writes still work afterwards (the reset did not corrupt the store).
  await store.applyCooldown('p1/m1', 8_000);
  assert.equal(store.isHealthy('p1/m1', 1_000), false, 'a new failure re-cools the route');
});

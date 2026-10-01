/**
 * Cooldown arithmetic and the two cooldown-state store implementations.
 *
 * A route is HEALTHY while `cooldownUntil <= now`. Writes happen ONLY on a
 * cooldown transition (after a model call fails); expiry is lazily cleaned:
 * reads treat an expired record as healthy and never write it back.
 *
 * @module dsh-quilt-compact/cooldown
 */

/**
 * Compute the next `cooldownUntil` (epoch ms) from the cooldown duration.
 *
 * `now + hours * 3600 * 1000` (hours supports decimals).
 *
 * @param cooldownHours - the route's cooldown duration in hours (positive).
 * @param now - current epoch ms.
 * @returns the cooldown-until timestamp.
 */
export function computeCooldownUntil(cooldownHours, now) {
  return now + (cooldownHours ?? 0) * 3600 * 1000;
}

/**
 * Cooldown state store interface.
 *
 * Implementations must be safe to call concurrently; the domain-backed store
 * serializes writes through the domain write chain, and the memory store
 * applies the same queued-write discipline in-process.
 */
export class CooldownStore {
  /**
   * Current `cooldownUntil` for a route, or `0` when no record exists
   * (a route with no record is healthy).
   * @param key - route key (`provider/model`).
   * @returns epoch ms, or 0 when never cooled.
   */
  cooldownUntil(key) {
    throw new Error('CooldownStore.cooldownUntil must be implemented by a subclass');
  }

  /**
   * Whether the route is healthy at `now`.
   * @param key - route key.
   * @param now - current epoch ms.
   */
  isHealthy(key, now) {
    return this.cooldownUntil(key) <= now;
  }

  /**
   * Durably record a cooldown transition. A no-op when the route already
   * carries exactly this timestamp (write throttling: only transitions hit
   * the medium).
   * @param key - route key.
   * @param until - cooldown-until epoch ms.
   */
  async applyCooldown(key, until) {
    throw new Error('CooldownStore.applyCooldown must be implemented by a subclass');
  }

  /**
   * Drop EVERY cooldown record, making all routes healthy again. Used by the
   * "all routes cooled" recovery: a whole-pool cooldown would otherwise park
   * compaction until the earliest route expires (hours, with the 1h default),
   * so the engine clears them once and retries instead of failing outright.
   */
  async clearAll() {
    throw new Error('CooldownStore.clearAll must be implemented by a subclass');
  }

  /** Snapshot all route keys, for diagnostics and tests. */
  keys() {
    throw new Error('CooldownStore.keys must be implemented by a subclass');
  }
}

/**
 * Domain-backed store over `ctx.storage.domain` (the `dsh_quilt_compact_state`
 * domain's `routes` table). Reads are synchronous from the domain's
 * authoritative memory; writes queue on the domain write chain and are
 * validated by zod + atomically persisted by the json backend.
 */
export class DomainCooldownStore extends CooldownStore {
  /**
   * @param domain - opened domain handle for {@link chainStateSpec}.
   */
  constructor(domain) {
    super();
    this.domain = domain;
    this.table = domain.table('routes');
  }

  cooldownUntil(key) {
    const record = this.table.get(key);
    return record === undefined ? 0 : record.cooldownUntil;
  }

  async applyCooldown(key, until) {
    if (this.table.get(key)?.cooldownUntil === until) return;
    await this.table.put(key, { cooldownUntil: until });
  }

  async clearAll() {
    await Promise.all([...this.table.keys()].map((key) => this.table.delete(key)));
  }

  keys() {
    return [...this.table.keys()];
  }
}

/**
 * In-memory store used when the storage-domain form is not mounted (or its
 * open fails). Same write-throttle semantics as the domain store; nothing is
 * persisted across process restarts. Cooldown transitions are still
 * serialized per key so concurrent failures cannot interleave.
 */
export class MemoryCooldownStore extends CooldownStore {
  constructor() {
    super();
    this.records = new Map();
    this.chain = Promise.resolve();
  }

  cooldownUntil(key) {
    return this.records.get(key)?.cooldownUntil ?? 0;
  }

  applyCooldown(key, until) {
    const job = this.chain.then(() => {
      const current = this.records.get(key)?.cooldownUntil;
      if (current !== until) this.records.set(key, { cooldownUntil: until });
    });
    this.chain = job.then(() => undefined, () => undefined);
    return job;
  }

  clearAll() {
    const job = this.chain.then(() => {
      this.records.clear();
    });
    this.chain = job.then(() => undefined, () => undefined);
    return job;
  }

  keys() {
    return [...this.records.keys()];
  }
}

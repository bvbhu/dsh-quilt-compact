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
 * Compute the next `cooldownUntil` (epoch ms) for one cooldown config.
 *
 * - `duration`: `now + hours * 3600 * 1000` (hours supports decimals).
 * - `dailyReset`: the next UTC `hour:00` point strictly after `now`; when
 *   today's hour has passed (or we are exactly at it), tomorrow's.
 *
 * @param config - resolved cooldown config (`{ mode, hours }` or `{ mode, hour }`).
 * @param now - current epoch ms.
 * @returns the cooldown-until timestamp.
 */
export function computeCooldownUntil(config, now) {
  if (config.mode === 'duration') {
    return now + config.hours * 3600 * 1000;
  }
  const next = new Date(now);
  next.setUTCHours(config.hour, 0, 0, 0);
  if (next.getTime() <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime();
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

  /** Snapshot all route keys, for diagnostics and tests. */
  keys() {
    throw new Error('CooldownStore.keys must be implemented by a subclass');
  }
}

/**
 * Domain-backed store over `ctx.storage.domain` (the `compaction_chain_state`
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

  keys() {
    return [...this.records.keys()];
  }
}

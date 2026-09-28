/**
 * Cooldown-state domain specification and route-key vocabulary.
 *
 * The design-v3 sketch used `compaction-chain-state` (hyphenated) with a
 * nullable global and a `z.record` table wrapper. Both deviate from the
 * storage-domain contract, so the shipped spec adjusts them:
 *
 * - `UNIT_NAME_RE` (`/^[a-z][a-z0-9_]*$/`) forbids hyphens; the domain name
 *   is `compaction_chain_state`.
 * - `defineDomain` rejects a global schema that accepts `null` (null is the
 *   medium's "never written" sentinel), so the global is a non-null
 *   `{ schemaVersion: 1 }` with an `initial` value.
 * - Tables are declared per-record with `domainTable(schema)`; keys are plain
 *   strings on the medium, so no `z.record` wrapper is needed.
 *
 * The state file therefore contains ONLY route cooldown timestamps plus the
 * schema-version global — no session content ever crosses this domain.
 *
 * @module dsh-quilt-compact/spec
 */
import z from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';

/** Domain spec for the cooldown state; one record per pool route. */
export const chainStateSpec = defineDomain({
  name: 'compaction_chain_state',
  version: 1,
  global: {
    schema: z.object({ schemaVersion: z.literal(1) }),
    initial: { schemaVersion: 1 },
  },
  tables: {
    routes: domainTable(z.object({
      cooldownUntil: z.number(),
    })),
  },
});

/** Stable record key for one exact provider/model pool route. */
export function routeKey(provider, model) {
  return `${provider}/${model}`;
}

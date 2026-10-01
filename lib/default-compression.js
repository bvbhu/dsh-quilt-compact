/**
 * Automatic-pressure policy read from the DEFAULT compression plugin
 * (`dsh-compaction-basic`).
 *
 * The session-model fallback no longer delegates to that plugin at runtime:
 * the former facade redirected a `BasicCompactionEngine` instance's `ctx` to
 * ours, which breaks under the loader's realm mounting (the redirected
 * instance's service access cannot resolve `llm`). The engine now implements
 * the fallback directly — see {@link module:dsh-quilt-compact/engine} — and
 * this module keeps only the scratch-construction policy reader.
 *
 * The scratch construction reads that plugin's resolved automatic-pressure
 * defaults on a throwaway root context with `auto: false` (no automatic
 * listeners, never mounted as a service), so replacing the `compaction`
 * service never changes WHEN the harness decides to compact.
 *
 * @module dsh-quilt-compact/default-compression
 */
import { Context } from '@deepseek-ai/cordis';
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';

/**
 * Last-resort automatic-pressure policy, used only when
 * `dsh-compaction-basic` cannot be instantiated. Mirrors that plugin's own
 * defaults; `test/unit/policy.test.js` asserts both directions against a live
 * engine, so this table cannot drift unnoticed.
 */
const FALLBACK_POLICY = Object.freeze({
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  headroomTokens: 65536,
  compactionRetries: 1,
  maxOverflowRetries: 1,
});

let cachedPolicy;

/**
 * Read `dsh-compaction-basic`'s resolved automatic-pressure defaults.
 *
 * Built on a throwaway root context with `auto: false` — no automatic
 * listeners registered, never mounted as a service — so it cannot shadow this
 * plugin's own `compaction` registration. Cached: this policy is fixed for the
 * process lifetime.
 *
 * @returns `{ thresholdRatio, retainRatio, headroomTokens, compactionRetries,
 *   maxOverflowRetries }`, or {@link FALLBACK_POLICY} when the default plugin
 *   is unavailable.
 */
export function readBasicPolicy() {
  if (cachedPolicy !== undefined) return cachedPolicy;
  try {
    const { config } = new BasicCompactionEngine(new Context(), { auto: false });
    cachedPolicy = Object.freeze({
      thresholdRatio: config.thresholdRatio ?? FALLBACK_POLICY.thresholdRatio,
      retainRatio: config.retainRatio ?? FALLBACK_POLICY.retainRatio,
      headroomTokens: config.headroomTokens ?? FALLBACK_POLICY.headroomTokens,
      compactionRetries: config.compactionRetries ?? FALLBACK_POLICY.compactionRetries,
      maxOverflowRetries: config.maxOverflowRetries ?? FALLBACK_POLICY.maxOverflowRetries,
    });
  } catch {
    cachedPolicy = FALLBACK_POLICY;
  }
  return cachedPolicy;
}

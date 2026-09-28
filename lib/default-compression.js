/**
 * Direct facade over the DEFAULT compression plugin (`dsh-compaction-basic`).
 *
 * The chain's session-model fallback delegates here instead of re-implementing
 * the default behavior: `BasicCompactionEngine.summarize()` replays the
 * original conversation prefix (system prompt + region messages, unchanged)
 * and appends its `COMPACTION_INSTRUCTION` as the FINAL user message, so the
 * auxiliary call is a genuine prefix of the last routed request and the
 * provider's warm KV cache is reused (design v3 §3.4, updated).
 *
 * The basic engine is constructed on a throwaway root context with `auto:
 * false` (no automatic listeners), then redirected to the caller's context
 * for `llm` access. Its `compaction` service registration lands on the
 * throwaway context, so it can never clobber the chain engine that owns
 * `ctx.compaction`.
 *
 * The same scratch-construction trick powers {@link readBasicPolicy}, which
 * reads that plugin's resolved automatic-pressure defaults so replacing the
 * `compaction` service never changes WHEN the harness decides to compact.
 *
 * @module dsh-quilt-compact/default-compression
 */
import { Context } from '@deepseek-ai/cordis';
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';

/**
 * Build the fallback summarizer facade.
 * @param ctx - live context whose `llm` the default summarizer will use.
 * @returns `{ summarize(input, agent, signal) }` returning the default
 *   summarizer result (`summary`, `rawOutput`, `llmStreamCall`, `provider`,
 *   `model`, `maxTokens`, `usage`).
 */
export function createDefaultCompression(ctx) {
  // Construct on a scratch context so the basic engine's own 'compaction'
  // service registration is discarded instead of shadowing ours.
  const scratch = new Context();
  const basic = new BasicCompactionEngine(scratch, { auto: false });
  basic.ctx = ctx;
  return basic;
}

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
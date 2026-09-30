/**
 * Context budget math shared by the chunk and merge stages.
 *
 * The model's `contextWindow` (as reported by `resolveModelInfo`) is the
 * COMBINED input+output budget of one request, and DSH adapters do not clamp
 * `maxTokens` down to the window. A chunk budget that treated the whole window
 * as input (`contextWindow * chunkRatio`) silently produced requests that
 * exceeded the real limit the moment output tokens were reserved — the model
 * then failed as if it were broken, and the pool cooled it for a capacity
 * problem.
 *
 * Every budget below therefore subtracts, in order:
 *
 * - the output reservation (`min(DEFAULT_MAX_TOKENS, 15% of the window)`, the
 *   same 15% the design reserves for generation);
 * - a prompt overhead allowance (instruction + framing tokens);
 * - a safety headroom so tokenizer density never overruns the window.
 *
 * `chunkRatio` intentionally does NOT mean "fraction of the context window".
 * It means "fraction of the usable INPUT budget one chunk may occupy", so a
 * `chunkRatio` of 0.8 still leaves real headroom for output + prompt.
 *
 * @module dsh-quilt-compact/budget
 */
import { DEFAULT_MAX_TOKENS } from './summarize.js';

/** Fraction of the context window reserved for generated output tokens. */
export const OUTPUT_RESERVATION_RATIO = 0.15;

/** Estimated fixed prompt tokens (instruction + framing) per pool call. */
export const PROMPT_OVERHEAD_TOKENS = 512;

/** Safety headroom kept free so the heuristic never overruns the window. */
export const SAFETY_HEADROOM_TOKENS = 512;

/**
 * Default context window used when a route's capacity cannot be resolved
 * (`resolveModelInfo` failed, or the info carries no contextWindow). v7:
 * unknown capacity is NO LONGER treated as unbounded — it joins capacity
 * matching under this default, so a route whose real window is unknown is
 * matched conservatively instead of "always fits".
 */
export const DEFAULT_CONTEXT_WINDOW = 262144;

/**
 * Floor of the single-level merge window when the config does NOT set
 * `mergeMaxContextTokens` (v7). The merge is one call over ALL chunk digests,
 * so its input budget must fit some pool model. Typical models expose
 * >= 128k, and "ten condensed digests fit within 100k" is the design
 * assumption; the floor keeps the pool-derived default merge budget sane even
 * when every pool model reports a tiny window (the caller then falls back —
 * see `resolveMergeWindow`). A configured `mergeMaxContextTokens` replaces
 * this derivation entirely.
 */
export const MERGE_WINDOW_FLOOR = 128000;

/**
 * Tokens reserved for the generated digest of one request on a model whose
 * combined window is `contextWindow`: bounded by `DEFAULT_MAX_TOKENS` (the
 * per-call output cap) and the window's 15% reservation.
 * @param contextWindow - combined context window of the target model.
 * @returns the output-token reservation for one call.
 */
export function computeOutputBudget(contextWindow) {
  return Math.min(DEFAULT_MAX_TOKENS, Math.floor(contextWindow * OUTPUT_RESERVATION_RATIO));
}

/**
 * Tokens of one request that may be spent on INPUT (prompt content) before the
 * request can no longer fit the window: window minus output reservation minus
 * prompt overhead minus safety headroom. Never below 1.
 * @param contextWindow - combined context window of the target model.
 * @returns the usable input budget in tokens.
 */
export function computeUsableInputTokens(contextWindow) {
  return Math.max(
    1,
    contextWindow
      - computeOutputBudget(contextWindow)
      - PROMPT_OVERHEAD_TOKENS
      - SAFETY_HEADROOM_TOKENS,
  );
}

/**
 * Core token budget one chunk may occupy: `chunkRatio` of the usable input
 * budget (see the module doc). Never below 1 so a degenerate window still
 * produces a single-line chunk.
 * @param contextWindow - combined context window of the chunking model.
 * @param chunkRatio - fraction of the usable INPUT budget one chunk may use.
 * @returns the chunk core budget in tokens.
 */
export function computeChunkBudget(contextWindow, chunkRatio) {
  return Math.max(1, Math.floor(computeUsableInputTokens(contextWindow) * chunkRatio));
}

/**
 * Resolve the DEFAULT single-level merge window (v7): `max(MERGE_WINDOW_FLOOR,
 * smallest known context window among the pool's routes)`. Unknown-capacity
 * routes join the min under `DEFAULT_CONTEXT_WINDOW` (v7 default, not
 * unbounded). This is the fallback when the config does NOT set
 * `mergeMaxContextTokens`; the engine overrides it with the configured value
 * when present. The caller must verify that some healthy pool model can
 * actually hold this window before dispatching the merge; otherwise it falls
 * back. The merge reuses the MAIN tiers pool and descends tiers to find a
 * route with enough context — there is no dedicated merge pool.
 *
 * @param capacities - per-route capacity map from `resolvePoolCapacities`
 *   (absent entries = unknown -> default window).
 * @param tiers - resolved tier list the merge chain runs over (the main
 *   `tiers`; the merge descends them tier by tier).
 * @returns the merge window in tokens.
 */
export function resolveMergeWindow(capacities, tiers) {
  let min = Infinity;
  for (const tier of tiers) {
    for (const model of tier.models) {
      const cap = capacities?.get?.(model.key);
      const window = cap?.contextWindow;
      const known = Number.isInteger(window) && window > 0 ? window : DEFAULT_CONTEXT_WINDOW;
      if (known < min) min = known;
    }
  }
  if (!Number.isFinite(min)) min = DEFAULT_CONTEXT_WINDOW;
  return Math.max(MERGE_WINDOW_FLOOR, min);
}
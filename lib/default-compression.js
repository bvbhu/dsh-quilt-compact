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
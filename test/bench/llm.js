/**
 * Digest personas for the benchmark's scripted model.
 *
 * A benchmark that grades the PIPELINE must not silently grade the model. These
 * personas pin the cheap model so two runs of the suite differ only if the
 * pipeline changed.
 *
 * @module dsh-quilt-compact/test/bench/llm
 */
import { countTokens } from '../../lib/tokenizer.js';

/**
 * Render one request's first user message into a deterministic digest that
 * guarantees the "smaller than the shadowed region" check can pass while
 * exercising the real Stage 0 / chunk / merge machinery.
 *
 * A summarizer that echoes its prompt in full cannot shrink anything: the
 * built-in check ("summary must be smaller than the shadowed region") then
 * rejects EVERY run and the benchmark measures nothing. The compression HERE is
 * the mechanical part a fixed script can honestly simulate — dropping blank
 * lines, boilerplate filler, and duplicate lines — while every line carrying
 * compaction-worthy signal is preserved verbatim. What remains unmeasured is
 * genuinely the PIPELINE's contribution, which is what "persona" is meant to
 * hold constant.
 */
function digestMaterial(messages) {
  const parts = messages.map((message) => (message.content ?? []).map((block) => block.text ?? '').join(''));
  // The final message is the instruction, not material to condense.
  return parts.slice(0, -1).join('\n');
}

/** Whether a line is worth paying tokens for (mirrors `salient.js` weights). */
function keepworthy(line) {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  if (/^\[filler\s+\d+\]/.test(trimmed)) return false;
  if (/^\[condensed: .*removed\]$/.test(trimmed) && !/including/.test(trimmed)) return false;
  return true;
}

/**
 * Render one request into a digest under one persona.
 * @param messages - the request messages the pipeline built.
 * @param behavior - persona name.
 * @returns the digest text the stream will emit.
 */
function summarize(messages, behavior) {
  if (behavior === 'forgetful') {
    return 'SUMMARY: the user asked for work; several files were inspected and edited; continue from here.';
  }
  const material = digestMaterial(messages);
  const lines = material.split('\n');
  if (behavior === 'leak') {
    // Every 4th line is lost — leaks exactly what the pipeline chose to show.
    const leaked = lines.filter((line, index) => index % 4 !== 3);
    return `SUMMARY:\n${leaked.join('\n')}`;
  }
  // `perfect`: keep every informative line, drop structure-only noise.
  const kept = [...new Set(lines.filter(keepworthy))];
  return `SUMMARY:\n${kept.join('\n')}`;
}

/**
 * Scripted fake `llm` service whose per-route summarizer is one of three
 * personas:
 *
 * - `perfect` (default): copies the prompt through untouched. This is the
 *   CEILING — any fact lost here was lost by the PIPELINE (trim, skeletonize,
 *   chunk boundary), not by the model.
 * - `leak`: drops every 4th non-empty line of the material it is shown, i.e.
 *   leaks exactly what it was shown. This is the PROBE-SENSITIVITY control: a
 *   pipeline that kept a fact in the prompt shows it here and loses it, while
 *   one that trimmed the fact away never had it to leak.
 * - `forgetful`: emits a short generic checkpoint instead: the FLOOR.
 *
 * @param options.behavior - persona name; defaults to `perfect`.
 */
export function createFakeLlm(options = {}) {
  const behavior = options.behavior ?? 'perfect';
  const calls = [];
  const llm = {
    calls,
    setBehavior(next) { behavior = next; },
    async *stream(opts) {
      const messages = opts.messages ?? [];
      calls.push({
        provider: opts.provider,
        model: opts.model,
        messages,
        maxTokens: opts.maxTokens,
        purpose: opts.purpose,
        sessionId: opts.sessionId,
        signal: opts.signal,
      });
      const text = summarize(messages, behavior);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
    async resolveModelInfo(provider, model) {
      const key = `${provider}/${model}`;
      const window = options.windows?.[key] ?? options.contextWindow ?? 200000;
      return {
        provider,
        model,
        name: model,
        context: { contextWindow: window },
        defaultMaxTokens: 32768,
      };
    },
  };
  return llm;
}

/**
 * The digest material one request carries: the joined conversation lines it was
 * asked to condense.
 * @param messages - the request messages.
 */
function joinMaterial(messages) {
  return messages
    .map((message) => (message.content ?? []).map((block) => block.text ?? '').join(''))
    .join('\n');
}

/**
 * Wrap a live `ctx.llm` so the real-model lane can run the SAME pipeline the
 * deterministic personas run.
 *
 * The engine calls `llm.stream(opts)` exactly as it would in production; this
 * wrapper records each call (for the capacity invariant and call counting),
 * forwards to the real adapter, and shapes the finish like the fake does. It is
 * deliberately thin: the real model does the actual condensing, so the
 * benchmark measures end-to-end faithfulness with real comprehension rather
 * than the deterministic persona ceiling.
 *
 * Use with `run.mjs --real` (or any llmFactory injection); it is NOT part of
 * the CI lane — real models are nondeterministic and rate-limited.
 *
 * @param ctx - a context whose `llm` is a real adapter.
 * @param options - ignored; kept for factory-shape symmetry.
 * @returns the wrapper llm.
 */
export function createRealLlm(ctx, options = {}) {
  const real = ctx.llm;
  if (real === undefined || typeof real.stream !== 'function') {
    throw new Error('createRealLlm requires ctx.llm.stream (a live adapter)');
  }
  // Guard against silently benchmarking the deterministic fixture: the shared
  // test fixture's fake llm also implements stream(), but a `--real` run over
  // it would measure a constant `digest(route, len=N)` stub and report garbage
  // as if it were a real model. The fixture's stub is uniquely identifiable by
  // its `behavior(key, ...)` registration method (no live adapter has one).
  if (typeof real.behavior === 'function') {
    throw new Error(
      'createRealLlm: ctx.llm is the scripted test fixture, not a live adapter. '
      + 'Run --real inside a real DSH environment (or inject a real llmFactory), '
      + 'never against the deterministic fake.',
    );
  }
  const calls = [];
  const llm = {
    calls,
    async *stream(opts) {
      const messages = opts.messages ?? [];
      calls.push({
        provider: opts.provider,
        model: opts.model,
        messages,
        maxTokens: opts.maxTokens,
        purpose: opts.purpose,
        sessionId: opts.sessionId,
        signal: opts.signal,
      });
      for await (const chunk of real.stream(opts)) yield chunk;
    },
    async resolveModelInfo(provider, model) {
      return real.resolveModelInfo(provider, model);
    },
  };
  return llm;
}

/**
 * Estimate the input tokens one request actually pays for, using the REAL
 * deepseek-v4 tokenizer — the same counter the engine's budget math uses.
 *
 * This is the honest counterpart to the engine's planning estimate: it counts
 * the real request messages (including the instruction the pipeline appends),
 * so an invariant like `input + maxTokens <= contextWindow` is checkable
 * against what would actually be sent to a provider.
 *
 * @param messages - the request messages the pipeline built.
 * @returns the estimated input-token cost of the request.
 */
export function estimateRequestTokens(messages) {
  return (messages ?? [])
    .flatMap((message) => message.content ?? [])
    .reduce((sum, block) => sum + countTokens(String(block.text ?? '')), 0) + 4;
}

/**
 * Cheap, deterministic token estimate for one message: ~4 chars per token.
 * Mirrors `@deepseek-ai/dsh-token-meter/estimate`'s fixed density without
 * pulling the dependency into the persona module.
 * @param message - a derived request message.
 */
function estimateMessageTokens(message) {
  const chars = (message?.content ?? []).reduce((sum, block) => sum + String(block.text ?? '').length, 0);
  return Math.ceil(chars / 4) + 4;
}

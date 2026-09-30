/**
 * Digest personas for the benchmark's scripted model.
 *
 * A benchmark that grades the PIPELINE must not silently grade the model. These
 * personas pin the cheap model so two runs of the suite differ only if the
 * pipeline changed.
 *
 * @module dsh-quilt-compact/test/bench/llm
 */

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
      return {
        provider,
        model,
        name: model,
        context: { contextWindow: options.contextWindow ?? 200000 },
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
 * Cheap, deterministic token estimate for one message: ~4 chars per token.
 * Mirrors `@deepseek-ai/dsh-token-meter/estimate`'s fixed density without
 * pulling the dependency into the persona module.
 * @param message - a derived request message.
 */
function estimateMessageTokens(message) {
  const chars = (message?.content ?? []).reduce((sum, block) => sum + String(block.text ?? '').length, 0);
  return Math.ceil(chars / 4) + 4;
}

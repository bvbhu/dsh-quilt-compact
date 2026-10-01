/**
 * Built-in summarization prompts and the one-shot `ctx.llm.stream()` call
 * helper shared by chunk and merge stages.
 *
 * The plugin configures NO retry parameters of its own (design decision):
 * every call is a direct stream whose retry behavior comes from the PROVIDER's
 * configured `retryPolicy` (the same policy `dsh-llm-retry` applies to the
 * agent loop, read via `ctx.llm.providerRetryPolicy`). A 429/5xx on a pool
 * route therefore backs off and retries per that policy instead of instantly
 * cooling the route — the plugin only sees a failure (and writes a cooldown)
 * after the provider's own retries are exhausted. When a provider exposes no
 * policy the call stays a single attempt, exactly like `dsh-compaction-basic`'s
 * summarizer. DSH's `retryPolicy` executor (`dsh-llm-retry`) itself only acts
 * on agent-loop request failures, so without this wrapper a compaction call
 * would bypass the policy entirely.
 *
 * @module dsh-quilt-compact/summarize
 */
import { BlockAssembler, LlmError, contentHasImage } from '@deepseek-ai/dsh-llm';

/**
 * Output-token cap for one chunk/merge generation. The design removed
 * `maxTokens` from the public config; this constant bounds each auxiliary call
 * so the framed checkpoint cannot silently balloon past the shrink check.
 *
 * Value mirrors `dsh-llm`'s unconfigured-model assumption
 * (`DEFAULT_MAX_TOKENS = 32768`, i.e. 32k): still a bounded local cap, but one
 * that cannot truncate a dense region digest the way a 4k cap could.
 */
export const DEFAULT_MAX_TOKENS = 32768;

/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>';
const SUMMARY_CLOSE_TAG = '</compacted-summary>';

/**
 * Built-in chunk instruction. Delivered as the FINAL user message after the
 * excerpt, so instructions sit at the end where the model attends most; the
 * configured `chunkPromptSuffix` appends after it.
 */
export const CHUNK_PROMPT = [
  'You are a compaction engine. Condense the conversation EXCERPT above into a terse factual digest that lets another model resume without loss of essential context.',
  '',
  'Rules:',
  '- Use terse markdown bullets under stable headings: ## Request, ## Decisions, ## Files and Code, ## Errors and Fixes, ## Pending Work, ## Next Step, ## Critical Context.',
  '- Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and corrections faithfully.',
  '- If an excerpt section is empty, write "(none)". Never invent facts.',
  '- Output only the digest text: do not call any tool or take any other action.',
].join('\n');

/**
 * Digest size cap appended to the chunk instruction (v7). The merge is a
 * single call over ALL chunk digests, so every digest must stay within its
 * proportional cap `cap_i = U × chunkTokens_i / T` (see design §2.3/§4); the
 * cap is injected into the prompt so the model budgets its output, and
 * `Σ cap_i ≤ U < mergeWindow` guarantees the single merge fits.
 */
export function digestCapInstruction(capTokens) {
  if (capTokens === undefined || capTokens === null) return '';
  return `- Keep the digest at or under ${capTokens} tokens: a longer digest would overflow the single merge call. Prefer density over exhaustiveness.`;
}

/**
 * Built-in merge instruction. The merge model sees every chunk digest
 * (including overlapping tails) and must produce ONE consolidated checkpoint,
 * deduplicating the overlaps.
 */
export const MERGE_PROMPT = [
  'You are a compaction engine. The numbered digests above are summaries of consecutive, overlapping excerpts of one conversation.',
  '',
  'Merge them into ONE consolidated checkpoint with these terse markdown sections, in order:',
  '## Primary Request and Intent, ## Key Technical Concepts, ## Files and Code, ## Errors and Fixes, ## Pending Jobs, ## Current Work, ## Next Step, ## Critical Context.',
  '',
  'Rules:',
  '- Deduplicate facts repeated across overlapping digests; keep each fact once.',
  '- Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and corrections faithfully.',
  '- Write "(none)" for an empty section; never drop a section.',
  '- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint: preserve still-true facts, drop stale ones, and merge newer information into this single consolidated summary.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
].join('\n');

/**
 * Built-in fallback (session-model) instruction. Delivered as the FINAL user
 * message after a replay of the conversation prefix, mirroring
 * `dsh-compaction-basic`'s cache-reusing summarizer: the call is a genuine
 * prefix of the last routed request plus one appended user message, so the
 * provider's warm KV cache is reused instead of invalidated. The fallback is
 * one call over the whole region; when a single chunk would have sufficed,
 * that call IS the one-pass completion.
 */
export const CHECKPOINT_PROMPT = [
  'You are a compaction engine. Condense the conversation ABOVE into one consolidated checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output terse markdown under these sections, in order:',
  '## Primary Request and Intent, ## Key Technical Concepts, ## Files and Code, ## Errors and Fixes, ## Pending Jobs, ## Current Work, ## Next Step, ## Critical Context.',
  '',
  'Rules:',
  '- Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and corrections faithfully.',
  '- Write "(none)" for an empty section; never drop a section.',
  '- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint: preserve still-true facts, drop stale ones, and merge newer information into this single consolidated summary.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
].join('\n');

/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.';

/** Chunk instruction text: built-in prompt + cap instruction + configured suffix. */
export function chunkInstruction(config, capTokens) {
  const cap = digestCapInstruction(capTokens);
  const parts = [CHUNK_PROMPT];
  if (cap.length > 0) parts.push(cap);
  if (config.chunkPromptSuffix.length > 0) parts.push(config.chunkPromptSuffix);
  return parts.join('\n\n');
}

/** Merge instruction text: built-in prompt + configured suffix. */
export function mergeInstruction(config) {
  return config.mergePromptSuffix.length === 0
    ? MERGE_PROMPT
    : `${MERGE_PROMPT}\n\n${config.mergePromptSuffix}`;
}

/** Fallback (session-model) instruction: checkpoint prompt + merge suffix. */
export function fallbackInstruction(config) {
  return config.mergePromptSuffix.length === 0
    ? CHECKPOINT_PROMPT
    : `${CHECKPOINT_PROMPT}\n\n${config.mergePromptSuffix}`;
}

/** User message for one chunk call: the excerpt, then the instruction. */
export function chunkMessages(chunkText, config, capTokens) {
  return [
    { role: 'user', content: [{ type: 'text', text: chunkText }] },
    { role: 'user', content: [{ type: 'text', text: chunkInstruction(config, capTokens) }] },
  ];
}

/** User message for the merge call: joined chunk digests, then the instruction. */
export function mergeMessages(digests, config) {
  const joined = digests
    .map((digest, index) => `--- digest ${index + 1} ---\n${digest}`)
    .join('\n\n');
  return [
    { role: 'user', content: [{ type: 'text', text: joined }] },
    { role: 'user', content: [{ type: 'text', text: mergeInstruction(config) }] },
  ];
}

/**
 * Run one direct `ctx.llm.stream()` call and assemble its text output.
 * @param ctx - context providing the `llm` service.
 * @param options - `provider`, `model`, `messages`, optional `signal`; the
 *   caller supplies `sessionId`/`purpose`/`maxTokens` when relevant.
 * @returns assembled blocks, usage, and the raw terminal finish.
 */
export async function streamText(ctx, options) {
  const assembler = new BlockAssembler();
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
  const finish = assembler.finish;
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new LlmError(finish.failure.message, finish.failure.code, finish.failure);
  }
  if (finish.kind === 'max-tokens') {
    const error = new Error('summarization truncated at the token cap (incomplete digest)');
    error.code = 'MAX_TOKENS';
    throw error;
  }
  const rawOutput = assembler.blocks();
  const summary = summaryTextBlocks(rawOutput);
  if (!summary.some((block) => block.text.trim().length > 0)) {
    throw new Error('summarization produced no text summary content');
  }
  return {
    rawOutput,
    summary,
    usage: assembler.usage,
  };
}

/** Keep only text blocks; image output is rejected before framing. */
function summaryTextBlocks(blocks) {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT');
  }
  return blocks.filter((block) => block.type === 'text');
}

/**
 * Exponential backoff with jitter, mirroring `dsh-llm-retry`'s `localDelay`
 * so a compaction call waits exactly as long as the agent loop would on the
 * same provider policy.
 */
function retryDelayMs(policy, retry, random) {
  const exponent = Math.min(retry - 1, 1024);
  const exponential = Math.min(policy.initialDelayMs * 2 ** exponent, policy.maxDelayMs);
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * random();
  return Math.min(exponential * jitter, policy.maxDelayMs);
}

/** Cancellable sleep: resolves `false` when the signal aborts during the wait. */
function sleepCancellable(ms, signal) {
  if (signal?.aborted === true) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run one direct `ctx.llm.stream()` call, retrying per the PROVIDER's
 * configured `retryPolicy` (read via `ctx.llm.providerRetryPolicy`) — the same
 * policy the agent loop's `dsh-llm-retry` applies. `mode: 'always'` retries
 * indefinitely; `mode: 'normal'` retries only codes in `retryableCodes`, up to
 * `maxRetries`, honoring `providerRetryAfterMs` when the provider sends one
 * within `maxDelayMs`. Cancellation is never retried. When the provider
 * exposes no policy the call is a single attempt (legacy behavior).
 *
 * Each retry logs one warn line, so the run's log answers "how long did the
 * provider's policy hold this call" without any config of the plugin's own.
 *
 * @param ctx - context providing the `llm` service (and `logger`).
 * @param options - `streamText` options: `provider`, `model`, `messages`,
 *   optional `signal`.
 * @param internals - `{ random }` test hook.
 * @returns the same shape {@link streamText} returns.
 */
export async function streamTextWithRetry(ctx, options, internals = {}) {
  let policy;
  try {
    policy = ctx.llm.providerRetryPolicy?.(options.provider);
  } catch {
    policy = undefined;
  }
  if (policy === undefined || typeof policy !== 'object') return streamText(ctx, options);

  const random = internals.random ?? Math.random;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await streamText(ctx, options);
    } catch (error) {
      if (options.signal?.aborted === true) throw error;
      const code = error instanceof LlmError ? error.code : undefined;
      const retryable = policy.mode === 'always'
        ? true
        : typeof code === 'string' && Array.isArray(policy.retryableCodes) && policy.retryableCodes.includes(code);
      if (!retryable) throw error;
      if (policy.mode !== 'always' && attempt >= policy.maxRetries) throw error;
      const after = error.providerRetryAfterMs;
      const delayMs = typeof after === 'number' && Number.isFinite(after) && after > 0 && after <= policy.maxDelayMs
        ? after
        : retryDelayMs(policy, attempt + 1, random);
      ctx.logger?.warn?.(`dsh-quilt-compact call retry: route=${options.provider}/${options.model} attempt=${attempt + 1}${policy.mode === 'always' ? '/always' : `/${policy.maxRetries}`} code=${code ?? 'unknown'} delayMs=${Math.round(delayMs)} (${String(error.message).slice(0, 120)})`);
      if (!await sleepCancellable(delayMs, options.signal)) throw error;
    }
  }
}

/** Join summary text blocks into one plain string (for the merge input). */
export function blocksToText(blocks) {
  return blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

/**
 * Wrap the final summary blocks in the durable checkpoint framing used by
 * `dsh-compaction-basic`, so resume behavior stays consistent.
 */
export function frameSummary(summary) {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ];
}

/**
 * Built-in summarization prompts and the one-shot `ctx.llm.stream()` call
 * helper shared by chunk and merge stages.
 *
 * The plugin configures NO retry parameters (design decision): every call is
 * a single-attempt direct stream, exactly like `dsh-compaction-basic`'s
 * summarizer. DSH's `retryPolicy` executor (`dsh-llm-retry`) only acts on
 * agent-loop request failures, so a chunk-call failure IS the
 * "retryPolicy exhausted" boundary the model chain turns into a cooldown.
 *
 * @module dsh-quilt-compact/summarize
 */
import { BlockAssembler, LlmError, contentHasImage } from '@deepseek-ai/dsh-llm';

/**
 * Built-in cap for one chunk/merge generation. The design removed `maxTokens`
 * from the public config; this constant bounds each auxiliary call so the
 * final checkpoint cannot silently balloon past the shrink check.
 */
export const BUILTIN_MAX_TOKENS = 4096;

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

/** Chunk instruction text: built-in prompt + configured suffix. */
export function chunkInstruction(config) {
  return config.chunkPromptSuffix.length === 0
    ? CHUNK_PROMPT
    : `${CHUNK_PROMPT}\n\n${config.chunkPromptSuffix}`;
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
export function chunkMessages(chunkText, config) {
  return [
    { role: 'user', content: [{ type: 'text', text: chunkText }] },
    { role: 'user', content: [{ type: 'text', text: chunkInstruction(config) }] },
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

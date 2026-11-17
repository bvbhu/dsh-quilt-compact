/**
 * Compaction-only LLM stream interception.
 *
 * This is the new, cooperative seam for dsh-quilt-compact. It does NOT replace
 * `ctx.compaction`, does NOT disable `dsh-compaction-basic`, and does NOT
 * register an adapter. The host keeps owning:
 *
 * - pressure / model-switch / overflow triggers,
 * - surface range selection,
 * - compaction/start + compaction/summary + compaction/end transactions,
 * - the "summary must be smaller" check.
 *
 * We only intercept `purpose === 'compaction'` calls on the `llm/stream`
 * waterfall, which `dsh-compaction-basic` sends for every summarization. The
 * original downstream stream is drained first: this preserves the contract of
 * the waterfall and, importantly, still passes the request through any
 * connect-style provider adapter or other `llm/stream` middleware. If the
 * downstream call fails, the interceptor is transparent and returns the
 * original chunks unchanged.
 *
 * On a successful downstream call, the replayed messages in `options.messages`
 * are split into model-sized chunks and merged into a compact checkpoint. A
 * structured <session-search-anchors> block is appended so the
 * @deepseek-ai/dsh-experimental-session-search tools can recover the original
 * events by exact session id + seq range, rather than by noisy keyword search.
 *
 * @module dsh-quilt-compact/intercept
 */
import { Config, resolveConfig } from './config.js';
import { ModelChain, chunkJob, mergeJob } from './model-chain.js';
import { DomainCooldownStore, MemoryCooldownStore } from './cooldown.js';
import { chainStateSpec } from './spec.js';
import { runStage0 } from './stage0/pipeline.js';
import { lineTokenCost, sliceNextChunk } from './stage0/chunk.js';
import { computeChunkBudget, computeUsableInputTokens } from './budget.js';
import {
  ANCHOR_PROMPT_INSTRUCTION,
  CHUNK_PROMPT,
  MERGE_PROMPT,
  buildAnchorBlock,
  chunkInstruction,
  mergeInstruction,
} from './summarize.js';

/** Default context window when a route publishes none. */
const DEFAULT_CONTEXT_WINDOW = 262144;

function isCompactionRequest(options) {
  return options?.purpose === 'compaction';
}

/**
 * The compaction instruction appended by dsh-compaction-basic is not part of
 * the replayed conversation region. Strip it before chunking/matching; an
 * unrecognized final user message from another backend is left untouched.
 */
function regionMessages(options) {
  const messages = Array.isArray(options?.messages) ? [...options.messages] : [];
  const last = messages.at(-1);
  const text = Array.isArray(last?.content)
    ? last.content.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('\n')
    : (typeof last?.content === 'string' ? last.content : '');
  if (last?.role === 'user' && /compaction engine|condense the conversation|structured checkpoint/i.test(text)) {
    messages.pop();
  }
  return messages;
}

/** Re-emit raw chunks from an array. */
async function* emitChunks(chunks) {
  for (const chunk of chunks) yield chunk;
}

/** Build a short deterministic id for one compaction request. */
function requestFingerprint(options) {
  const parts = [
    String(options?.sessionId ?? ''),
    ...(options?.messages ?? []).map((message) => {
      const content = message?.content;
      if (typeof content === 'string') return `${message.role ?? ''}:${content}`;
      if (!Array.isArray(content)) return `${message.role ?? ''}:${String(content ?? '')}`;
      return `${message.role ?? ''}:${content.map((block) => String(block?.text ?? '')).join('')}`;
    }),
  ].join('\n');
  let hash = 2166136261;
  for (let index = 0; index < parts.length; index += 1) {
    hash ^= parts.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase();
}

/**
 * Derive the exact shadowed surface span from the live session. The replayed
 * input is system head + shadowed region; comparing derived messages against
 * the compaction request's messages locates that span without changing DSH's
 * transaction. Returns `{ sessionId, seqStart, seqEnd }` when confident.
 */
function deriveSpan(ctx, options) {
  const sessionId = options?.sessionId;
  if (sessionId === undefined) return { sessionId: null, seqStart: null, seqEnd: null };
  let session;
  try { session = ctx.sessions?.get?.(sessionId); } catch { session = undefined; }
  if (session === undefined) return { sessionId: String(sessionId), seqStart: null, seqEnd: null };
  const nodes = session.surface?.nodes ?? [];
  const replayed = regionMessages(options);
  const fingerprint = (message) => {
    const content = message?.content;
    if (typeof content === 'string') return `${message.role ?? ''}:${content}`;
    if (!Array.isArray(content)) return `${message.role ?? ''}:${JSON.stringify(content ?? '')}`;
    return `${message.role ?? ''}:${content.map((block) => `${block?.type ?? ''}:${String(block?.text ?? block?.arguments ?? '')}`).join('|')}`;
  };
  const replayKeys = replayed.map(fingerprint);
  const surfaceKeys = [];
  for (const seq of nodes) {
    const message = session.deriveEventMessage?.(session.eventAt?.(seq));
    surfaceKeys.push(message === null || message === undefined ? '' : fingerprint(message));
  }
  // The replayed input is the compacted prefix (optionally preceded by the
  // system head), followed on the surface by a retained tail. Match from the
  // first surface node and allow the window to end before the tail.
  if (replayKeys.length === 0 || surfaceKeys.length < replayKeys.length) {
    return { sessionId: String(sessionId), seqStart: null, seqEnd: null };
  }
  const headOffset = replayed[0]?.role === 'system' ? 0 : 1;
  let matches = true;
  for (let i = 0; i < replayKeys.length; i += 1) {
    if (surfaceKeys[headOffset + i] !== replayKeys[i]) { matches = false; break; }
  }
  if (!matches) return { sessionId: String(sessionId), seqStart: null, seqEnd: null };
  const first = replayed[0]?.role === 'system' ? 1 : 0;
  const last = first + replayKeys.length - 1;
  if (last >= nodes.length) return { sessionId: String(sessionId), seqStart: null, seqEnd: null };
  return { sessionId: String(sessionId), seqStart: Number(nodes[first]), seqEnd: Number(nodes[last]) };
}

/** All text from a replayed message list, for Stage 0 + chunking. */
function messagesToRegion(messages) {
  return messages.map((message) => {
    const role = typeof message?.role === 'string' ? message.role : 'message';
    const content = message?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content.map((block) => {
        if (block?.type === 'text' || block?.type === 'reasoning') return String(block.text ?? '');
        if (block?.type === 'tool-call') return `${block.name ?? ''} ${block.arguments ?? ''}`;
        return JSON.stringify(block ?? '');
      }).join('\n');
    } else text = JSON.stringify(content ?? '');
    return `[${role}]\n${text}`;
  }).join('\n');
}

/**
 * Compaction-only interceptor installed by the plugin's Host effect.
 */
export class CompactionStreamInterceptor {
  static Config = Config;

  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.rawConfig = config;
    // A malformed pool must not take the host row down: the interceptor would
    // then silently stop improving summaries. Disable ourselves and let the
    // host's own summarizer run.
    try {
      this.config = resolveConfig(config);
      this.enabled = true;
    } catch (error) {
      // A malformed pool must not take the host row down. Keep `enabled: false`
      // and a null config; every entry point checks `enabled` first.
      this.config = undefined;
      this.enabled = false;
      ctx.logger?.error?.(`dsh-quilt-compact: invalid config, interceptor disabled: ${String(error)}`);
    }
    this._storePromise = undefined;
    this._openDomain = undefined;
    this._capacities = new Map();
    this._capacitiesFor = undefined;
    this._inflight = 0;
    ctx.effect(() => () => {
      if (this._openDomain !== undefined) void this._openDomain.close();
    });
    ctx.on('loader/volatile-update', () => this.reloadConfig());
  }

  reloadConfig() {
    try {
      const next = resolveConfig(this.rawConfig);
      // An empty pool is a legal "off" switch, not a config error.
      this.config = next;
      this.enabled = true;
      this._capacitiesFor = undefined;
      this.ctx.logger?.info?.('dsh-quilt-compact: interceptor config reloaded');
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-quilt-compact: interceptor config reload rejected: ${String(error)}`);
    }
  }

  /** Register the one `llm/stream` waterfall listener, owned by this fiber. */
  apply() {
    this.ctx.on('llm/stream', (options, next) => {
      if (!isCompactionRequest(options)) return next();
      // The waterfall contract is "return an async iterable", so the async
      // decision must be awaited INSIDE the generator, not in the listener.
      return this.stream(options, next);
    }, { global: true, prepend: true });
  }

  /** Async-iterable wrapper around {@link decide}. */
  async *stream(options, next) {
    const chosen = await this.decide(options, next);
    yield* chosen;
  }

  /** Decide between our own compressed stream and the untouched host stream. */
  async decide(options, next) {
    // Our OWN chunk/merge calls also carry `purpose === 'compaction'`; they must
    // pass straight through (otherwise the interceptor would recurse). The
    // inflight counter is therefore the authoritative guard, checked BEFORE any
    // attempt to compress. `_inflight === 0` means this is the host's original
    // summary call.
    if (!this.enabled || this.config === undefined) return next();
    if (this._inflight > 0 || this.config.tiers.length === 0) return next();

    this._inflight += 1;
    try {
      const assembled = await this.compress(options);
      if (assembled !== undefined) return assembled;
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-quilt-compact intercept: compression failed, delegating to the original summary: ${String(error)}`);
    } finally {
      this._inflight -= 1;
    }
    // On any failure or an ineligible request, delegate to the original stream.
    // The connect-style adapter and any other llm/stream middleware still run
    // through `next()` unchanged.
    return next();
  }

  async ensureStore() {
    this._storePromise ??= (async () => {
      const facility = this.ctx.get?.('storageDomain');
      if (facility === undefined) return new MemoryCooldownStore();
      try {
        const domain = await facility.open(chainStateSpec);
        this._openDomain = domain;
        return new DomainCooldownStore(domain);
      } catch (error) {
        this.ctx.logger?.warn?.(`dsh-quilt-compact: opening cooldown state domain failed; in-memory only: ${String(error)}`);
        return new MemoryCooldownStore();
      }
    })();
    return this._storePromise;
  }

  async resolveCapacities(signal) {
    if (this._capacitiesFor === this.config) return this._capacities;
    const capacities = new Map();
    const allModels = this.config.tiers.flatMap((tier) => tier.models);
    await Promise.all(allModels.map(async (model) => {
      let contextWindow;
      let maxTokens;
      try {
        const info = await this.ctx.llm.resolveModelInfo(model.provider, model.model, signal);
        contextWindow = info.context?.contextWindow;
        maxTokens = info.defaultMaxTokens;
      } catch {
        // Unknown capacity is treated as the conservative default below.
      }
      capacities.set(model.key, {
        contextWindow: Number.isInteger(contextWindow) && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW,
        maxTokens: Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : 32768,
      });
    }));
    this._capacities = capacities;
    this._capacitiesFor = this.config;
    return capacities;
  }

  sliceJobs(chain, lines, mergeUsableInput, regionTokens, sessionId, span) {
    const jobs = [];
    let cursor = 0;
    let coreStart = 0;
    let index = 0;
    while (cursor < lines.length) {
      const model = chain.pickChunkModel(this._capacities);
      if (model === undefined) break;
      const window = chain.modelWindow(model, this._capacities);
      const budget = computeChunkBudget(window, this.config.chunkRatio);
      const overlap = Math.max(0, Math.floor(budget * this.config.chunkOverlapRatio));
      const { end, next } = sliceNextChunk(lines, cursor, budget, overlap);
      const slice = lines.slice(cursor, end);
      if (slice.length === 0) break;
      const tokens = slice.reduce((sum, line) => sum + lineTokenCost(line), 0);
      const coreTokens = lines.slice(coreStart, end).reduce((sum, line) => sum + lineTokenCost(line), 0);
      const cap = Math.max(1, Math.floor(mergeUsableInput * coreTokens / Math.max(1, regionTokens)));
      index += 1;
      jobs.push(chunkJob(`chunk ${index}`, slice.join('\n'), {
        chunk: index,
        lineStart: cursor,
        lineEnd: end,
        coreStart,
        coreEnd: end,
        tokens,
        coreTokens,
        sessionId,
        seqStart: span.seqStart,
        seqEnd: span.seqEnd,
      }, model.key, cap));
      cursor = next;
      coreStart = end;
    }
    const total = jobs.reduce((sum, job) => sum + (job.capTokens ?? 0), 0);
    if (total > mergeUsableInput) {
      const scale = mergeUsableInput / total;
      for (const job of jobs) job.capTokens = Math.max(1, Math.floor((job.capTokens ?? 0) * scale));
    }
    return jobs;
  }

  /**
   * The agent view `ModelChain` needs. A live session is preferred so the
   * chain's fallback paths see the same object the host engine would.
   */
  agentFor(options) {
    const sessionId = options?.sessionId;
    let session;
    try { session = this.ctx.sessions?.get?.(sessionId); } catch { session = undefined; }
    if (session !== undefined) {
      return { session, options: { provider: options.provider, model: options.model } };
    }
    return {
      session: { id: sessionId, requestHeader: () => undefined, toolHistory: () => [] },
      options: { provider: options.provider, model: options.model },
    };
  }

  async compress(options) {
    const messages = regionMessages(options);
    if (messages.length === 0) return undefined;
    const span = deriveSpan(this.ctx, options);
    const rawRegion = messagesToRegion(messages);
    const stage0Lines = runStage0([{ role: 'user', content: [{ type: 'text', text: rawRegion }] }], this.config.preprocessing);
    if (stage0Lines.length === 0) return undefined;
    const regionTokens = stage0Lines.reduce((sum, line) => sum + lineTokenCost(line), 0);
    if (regionTokens <= 0) return undefined;
    const store = await this.ensureStore();
    const capacities = await this.resolveCapacities(options.signal);
    const mergeWindow = this.config.mergeMaxContextTokens;
    const mergeUsableInput = computeUsableInputTokens(mergeWindow);
    const chain = new ModelChain(this.ctx, this.config, store, {}, capacities);
    const mergeChain = new ModelChain(this.ctx, this.config, store, {}, capacities);
    const jobs = this.sliceJobs(chain, stage0Lines, mergeUsableInput, regionTokens, span.sessionId, span);
    if (jobs.length === 0) return undefined;

    // `ModelChain` only reads `agent.session.id` and `agent.options`; when the
    // compaction request names a live session we hand it that real session so
    // the chain's own fallback paths behave exactly as in the engine.
    const agent = this.agentFor(options);
    const fallbackOptions = {
      fallbackInput: { messages },
      defaultSummarize: (input, owner, abort) => this.ctx.llm.stream({ ...options, messages: input.messages, signal: abort ?? options.signal }),
      capacities,
    };
    const chunkResults = await chain.run(jobs, agent, options.signal, fallbackOptions);
    const digests = chunkResults.filter((result) => result !== undefined).map((result) => result.text);
    if (digests.length === 0 || digests.some((text) => !text || text.trim().length === 0)) return undefined;

    let finalText;
    if (digests.length === 1) {
      finalText = digests[0];
    } else if (mergeChain.canHoldMerge(mergeWindow, capacities)) {
      const mergeResult = await mergeChain.run([mergeJob(digests, { sourceChunks: digests.length })], agent, options.signal, fallbackOptions);
      finalText = mergeResult[0]?.text;
    } else {
      // No pool route can hold the merge: keep the original downstream summary
      // (basic already made one through the routed model).
      return undefined;
    }
    if (!finalText || finalText.trim().length === 0) return undefined;

    const anchor = buildAnchorBlock({
      id: `QC-${requestFingerprint(options)}`,
      sessionId: span.sessionId,
      seqStart: span.seqStart,
      seqEnd: span.seqEnd,
      chunks: jobs.map((job, index) => ({
        i: index + 1,
        lines: [job.meta?.lineStart ?? null, job.meta?.lineEnd ?? null],
        tokens: job.meta?.tokens ?? null,
        anchor: `QC-${requestFingerprint(options)}-${index + 1}`,
      })),
    });
    const text = `${finalText.trim()}\n\n${anchor}\n\n${ANCHOR_PROMPT_INSTRUCTION}`;
    // The host rejects a summary that is not strictly smaller than the span it
    // replaces. Our anchor + recovery instruction add fixed overhead, so a small
    // region must not be "compressed" into something longer: delegate instead.
    const regionChars = rawRegion.length;
    if (text.length >= regionChars) {
      this.ctx.logger?.info?.(`dsh-quilt-compact intercept: ${regionChars} chars of region would not shrink (digest ${text.length} chars); keeping the host summary`);
      return undefined;
    }
    return syntheticChunks(text, options.signal);
  }
}

/** Emit a complete text-only stream from a finished summary string. */
async function* syntheticChunks(text, signal) {
  if (signal?.aborted) return;
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

/** Host-side plugin shape: no exported `compaction` service. */
export const name = 'dsh-quilt-compact-intercept';
export const inject = ['llm', 'tokenMeter', 'sessions'];

/**
 * Install the interceptor. Exported as a plugin `apply` so a Host row can load
 * this same package without ever replacing `ctx.compaction`.
 *
 * @param ctx - context carrying `llm` (and optionally tokenMeter/sessions).
 * @param config - the row's `config` block, passed by the cordis loader.
 */
export function apply(ctx, config = {}) {
  const plugin = new CompactionStreamInterceptor(ctx, config ?? {});
  plugin.apply();
  return plugin;
}

export { Config, CHUNK_PROMPT, MERGE_PROMPT, ANCHOR_PROMPT_INSTRUCTION, chunkInstruction, mergeInstruction, buildAnchorBlock };

/** Test seams: the pure predicates the interceptor dispatches on. */
export const regionMessagesForTest = regionMessages;
export const isCompactionRequestForTest = isCompactionRequest;
export const deriveSpanForTest = deriveSpan;

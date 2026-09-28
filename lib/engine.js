/**
 * CompactionChainEngine: the compaction-chain backend for the DeepSeek
 * Harness.
 *
 * Implements the `CompactionEngine` service seam (design v3):
 *
 * - Stage 0 preprocessing (0a trims, 0b semantic compression) and 0c
 *   overlapping chunking over the replayed region.
 * - ModelChain scheduling (tiers, per-model `maxConcurrent`, cooldown,
 *   degradation, session-model fallback) for every chunk and the merge.
 * - Cooldown state persisted through `ctx.storage.domain` when the
 *   storage-domain form is mounted; in-memory fallback otherwise.
 * - The built-in "summary must be smaller than the shadowed region" check
 *   and the `compaction/summary-error` recovery waterfall are preserved.
 *
 * Automatic pressure / context-overflow triggering uses built-in policy
 * constants (threshold 0.8 of the routed context window, retain 0.16) since
 * the design removed those from the public config.
 *
 * @module dsh-quilt-compact/engine
 */
import { CompactionEngine, ManualCompactionError } from '@deepseek-ai/dsh-compaction';
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import { estimateMessage } from '@deepseek-ai/dsh-token-meter/estimate';
import { Config, resolveConfig } from './config.js';
import { chainStateSpec, routeKey } from './spec.js';
import { DomainCooldownStore, MemoryCooldownStore } from './cooldown.js';
import { ModelChain, chunkJob, mergeJob } from './model-chain.js';
import { runStage0 } from './stage0/pipeline.js';
import { chunkLines, chunkTokens } from './stage0/chunk.js';
import { DEFAULT_MAX_TOKENS, frameSummary } from './summarize.js';
import { createDefaultCompression, readBasicPolicy } from './default-compression.js';
import {
  assertNoActiveCompaction,
  compactSurfaceRegion,
  selectCompactableRange,
} from './region.js';

/**
 * Automatic-pressure policy is NOT pinned here: it is read from
 * `dsh-compaction-basic`'s own resolved defaults via `readBasicPolicy()`, so
 * replacing the `compaction` service never changes WHEN the harness decides to
 * compact. Only the context-window fallback stays local (it is a model-capacity
 * assumption, not a policy).
 */
export const DEFAULT_CONTEXT_WINDOW = 262144;

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(session) {
  const config = session.requestHeader()?.config;
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) return undefined;
  return { provider: config.provider, model: config.model };
}

/**
 * The compaction-chain backend. Load as the `compaction` service in place of
 * `dsh-compaction-basic` (`- id: compaction-basic, disabled: true`).
 */
export class CompactionChainEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions'];
  static Config = Config;

  /**
   * @param ctx - cordis context (llm, tokenMeter, sessions required;
   *   storageDomain optional).
   * @param config - raw plugin config; resolved and validated here.
   * @param internals - optional `{ now, sleep }` test hooks forwarded to the
   *   ModelChain scheduler.
   */
  constructor(ctx, config = {}, internals = {}) {
    super(ctx);
    this.config = resolveConfig(config);
    this.internals = internals;
    this._storePromise = undefined;
    this._openDomain = undefined;
    this._defaultCompression = undefined;
    // Close the lazily-opened domain on unload (idempotent; the consumer owns
    // the handle, so close-on-unmount is the facility's safety net too).
    ctx.effect(() => () => {
      if (this._openDomain !== undefined) void this._openDomain.close();
    });
    this.overflowRetries = new WeakMap();
    this.overflowAgents = new WeakMap();
    this._registerAutomaticCompaction();
  }

  /** Lazily open the cooldown store (domain-backed when possible). */
  ensureStore() {
    this._storePromise ??= (async () => {
      const facility = this.ctx.get('storageDomain');
      if (facility === undefined) {
        this.ctx.logger.warn('compaction-chain: storage-domain form not mounted; cooldown state is in-memory only (not persisted)');
        return new MemoryCooldownStore();
      }
      try {
        const domain = await facility.open(chainStateSpec);
        this._openDomain = domain;
        return new DomainCooldownStore(domain);
      } catch (error) {
        this.ctx.logger.warn(`compaction-chain: opening cooldown state domain failed; cooldown state is in-memory only: ${String(error)}`);
        return new MemoryCooldownStore();
      }
    })();
    return this._storePromise;
  }

  /**
   * The sole summarizer hook: Stage 0 + chunking + ModelChain + merge.
   * @param input - replayed conversation prefix `{ tools?, messages }`.
   * @param agent - agent context (`session`, `options`).
   * @param signal - cancellation forwarded to every pool call.
   * @returns summary blocks, the framed checkpoint, and the final call facts.
   */
  async summarize(input, agent, signal) {
    const store = await this.ensureStore();
    const lines = runStage0(input.messages, this.config.preprocessing);
    if (lines.length === 0) {
      throw new Error('compaction-chain: nothing to condense after Stage 0 preprocessing');
    }
    const contextWindow = await this.resolveChunkWindow(signal);
    const chunkBudget = Math.max(1, Math.floor(contextWindow * this.config.chunkRatio));
    const overlapTokens = Math.max(0, Math.floor(chunkBudget * this.config.chunkOverlapRatio));
    const chunks = chunkLines(lines, chunkBudget, overlapTokens);
    if (chunks.length === 0) {
      throw new Error('compaction-chain: Stage 0 chunking produced no chunks');
    }
    const regionChars = input.messages.reduce(
      (sum, message) => sum + JSON.stringify(message.content ?? message).length,
      0,
    );
    this.ctx.logger.info(`compaction-chain summarize: regionChars=${regionChars} stage0Lines=${lines.length} chunks=${chunks.length} chunkBudget=${chunkBudget} overlapTokens=${overlapTokens} contextWindow=${contextWindow}`);

    const chain = new ModelChain(this.ctx, this.config, store, this.internals);
    const fallbackOptions = {
      // The session-model fallback hands the ORIGINAL region input straight
      // to the default compression plugin (direct call, KV-cache reuse).
      fallbackInput: input,
      defaultSummarize: (regionInput, owner, abort) => this.defaultCompression().summarize(regionInput, owner, abort),
    };
    const jobs = chunks.map((chunk, index) => chunkJob(`chunk ${index + 1}`, chunk.lines.join('\n'), {
      lineStart: chunk.start,
      lineEnd: chunk.end,
      tokens: chunkTokens(chunk),
    }));
    const chunkResults = await chain.run(jobs, agent, signal, fallbackOptions);
    const digests = chunkResults.map((result) => result.text);
    if (digests.some((text) => text === undefined || text.length === 0)) {
      throw new Error('compaction-chain: a chunk digest was empty');
    }

    let finalResult;
    if (digests.length === 1) {
      // Single-chunk regions have no overlaps to deduplicate, so the chunk
      // digest IS the final checkpoint digest (merge call skipped; one pass).
      finalResult = chunkResults[0];
    } else {
      const mergeResults = await chain.run([mergeJob(digests, { sourceChunks: digests.length })], agent, signal, fallbackOptions);
      finalResult = mergeResults[0];
    }
    if (finalResult === undefined || finalResult.text === undefined) {
      throw new Error('compaction-chain: summarization produced no final digest');
    }

    const summary = [{ type: 'text', text: finalResult.text }];
    this.ctx.logger.info(`compaction-chain summarize done: route=${finalResult.provider}/${finalResult.model} fallback=${finalResult.fallback === true} digestChars=${finalResult.text.length} attempts=${finalResult.attempts?.length ?? 0}`);
    return {
      summary,
      rawOutput: summary,
      llmStreamCall: true,
      provider: finalResult.provider,
      model: finalResult.model,
      maxTokens: DEFAULT_MAX_TOKENS,
      usage: finalResult.usage,
      checkpoint: frameSummary(summary),
      fallback: finalResult.fallback === true,
      attempts: finalResult.attempts,
      chainStats: {
        chunkCount: chunks.length,
        overlapTokens,
        contextWindow,
      },
    };
  }

  /**
   * Lazily build the direct facade over the DEFAULT compression plugin
   * (`dsh-compaction-basic`). The session-model fallback calls its
   * `summarize()` directly: default cache-reusing compression over the
   * original region input, one call (one pass when a single chunk suffices).
   */
  defaultCompression() {
    this._defaultCompression ??= createDefaultCompression(this.ctx);
    return this._defaultCompression;
  }

  /** Resolve the chunk budget's context window from the primary pool model. */
  async resolveChunkWindow(signal) {
    const primary = this.config.tiers[0].models[0];
    try {
      const info = await this.ctx.llm.resolveModelInfo(primary.provider, primary.model, signal);
      const window = info.context?.contextWindow;
      if (window !== undefined && Number.isInteger(window) && window > 0) return window;
      this.ctx.logger.warn(`compaction-chain: no context capacity for ${primary.key}; chunking against the ${DEFAULT_CONTEXT_WINDOW}-token fallback`);
    } catch (error) {
      this.ctx.logger.warn(`compaction-chain: resolving context window for ${primary.key} failed (${String(error)}); chunking against the ${DEFAULT_CONTEXT_WINDOW}-token fallback`);
    }
    return DEFAULT_CONTEXT_WINDOW;
  }

  /** Bind the region transaction to this engine's summarizer and recovery. */
  regionDependencies() {
    const deps = {
      summarize: (input, owner, abort) => this.summarize(input, owner, abort),
      recover: (error, agent, sourceEventSeqs, signal) => this.ctx.waterfall('compaction/summary-error', {
        session: agent.session,
        sourceEventSeqs,
        error,
        ...signal === undefined ? {} : { signal },
      }, () => false),
      estimateMessage,
      measureNodes: (session) => session.surface.nodes.map((seq) => ({ seq, price: deps.spanPrice(session, [seq]) })),
      spanPrice: (session, seqs) => seqs.reduce((sum, seq) => {
        const message = session.deriveEventMessage(session.eventAt(seq));
        return message === null ? sum : sum + estimateMessage(message);
      }, 0),
    };
    return deps;
  }

  /** Compact one inclusive positional range from the agent-owned surface. */
  async compactRegion(start, end, agent, signal) {
    return compactSurfaceRegion(this.regionDependencies(), agent.session, start, end, agent, {
      owner: 'current-turn',
      stability: 'whole-surface',
    }, signal);
  }

  /**
   * Consider automatic compaction for step-boundary pressure or one
   * provider-confirmed context overflow, using the same measurement logic as
   * `dsh-compaction-basic` with built-in policy constants.
   */
  async compactIfNeeded(agent, trigger, signal) {
    const target = routedTarget(agent.session);
    if (target === undefined) return null;
    const meter = this.ctx.tokenMeter;
    let measurement = meter.measure(agent.session);
    if (trigger === 'context-overflow') {
      const prune = this.ctx.get('toolResultPruner');
      if (prune !== undefined) {
        prune.pruneSession(agent.session);
        measurement = meter.measure(agent.session);
      }
      const range = selectCompactableRange(agent.session, measurement.nodes, 0);
      if (range === null) return null;
      return this.compactRegion(range.start, range.end, agent, signal);
    }
    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction');
    if (info.context === undefined || info.context.contextWindow === undefined) {
      this.ctx.logger.warn(`compaction-chain: no context capacity for ${target.provider}/${target.model}; skipping automatic pressure compaction`);
      return null;
    }
    const contextWindow = info.context.contextWindow;
    const reservedCompletion = agent.session.requestHeader()?.config.maxTokens ?? info.defaultMaxTokens ?? 0;
    const messageBudgetTokens = contextWindow - reservedCompletion;
    if (messageBudgetTokens <= 0) {
      this.ctx.logger.warn(`compaction-chain: ${target.provider}/${target.model} reserves the whole context window; skipping automatic pressure compaction`);
      return null;
    }
    const { thresholdRatio, retainRatio, headroomTokens, compactionRetries } = readBasicPolicy();
    const pressureBudgetTokens = messageBudgetTokens - headroomTokens;
    if (pressureBudgetTokens <= 0) {
      this.ctx.logger.warn(`compaction-chain: ${target.provider}/${target.model} pressure budget is non-positive; skipping automatic pressure compaction`);
      return null;
    }
    const thresholdTokens = Math.floor(Math.min(contextWindow * thresholdRatio, pressureBudgetTokens));
    const retainTokens = Math.floor(messageBudgetTokens * retainRatio);
    if (measurement.totalTokens < thresholdTokens) return null;
    let result = null;
    for (let attempt = 0; attempt <= compactionRetries; attempt += 1) {
      const range = selectCompactableRange(agent.session, measurement.nodes, retainTokens);
      if (range === null) {
        if (result === null) return null;
        break;
      }
      result = await this.compactRegion(range.start, range.end, agent, signal);
      measurement = meter.measure(agent.session);
      if (measurement.totalTokens < thresholdTokens) return result;
    }
    throw new Error(`compaction still above threshold after ${compactionRetries + 1} compaction attempts (${measurement.totalTokens} estimated tokens >= threshold ${thresholdTokens})`);
  }

  /** Force one useful idle-session compaction below the pressure threshold. */
  compactNow(agent, signal, sourceCommandId) {
    signal.throwIfAborted();
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal]);
        try {
          operationSignal.throwIfAborted();
          const range = selectCompactableRange(agent.session, this.ctx.tokenMeter.measure(agent.session).nodes, 0);
          if (range === null) return null;
          return await compactSurfaceRegion(this.regionDependencies(), agent.session, range.start, range.end, agent, {
            owner: null,
            stability: 'selected-span',
            ...sourceCommandId === undefined ? {} : { sourceCommandId },
            flush: async () => {
              await this.ctx.sessions.flush(agent.session);
            },
          }, operationSignal);
        } catch (error) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError('cancelled', 'manual compaction was cancelled', { cause: error });
          }
          operationSignal.throwIfAborted();
          throw error;
        }
      });
    } catch (error) {
      throw new ManualCompactionError('busy', 'manual compaction requires an idle agent with no waking queued work', { cause: error });
    }
  }

  /** Register automatic between-step pressure and overflow recovery. */
  _registerAutomaticCompaction() {
    const { ctx } = this;
    const logResult = (result, trigger) => {
      ctx.logger.info(`compaction-chain (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes (seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`);
    };
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal);
          if (result !== null) logResult(result, 'step pressure');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.logger.warn(`compaction-chain: step compaction failed: ${message}; continuing the turn`);
        }
      }
      return next();
    });
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent);
    });
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return;
      const agent = this.overflowAgents.get(session);
      if (agent !== undefined) this.overflowRetries.delete(agent);
    });
    ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next();
      this.overflowAgents.set(agent.session, agent);
      const target = routedTarget(agent.session);
      if (target === undefined) return next();
      const retries = this.overflowRetries.get(agent) ?? 0;
      if (retries >= readBasicPolicy().maxOverflowRetries) return next();
      const generation = agent.session.surface.replaceGeneration;
      let result;
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal);
      } catch (recoveryError) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(`compaction-chain: context-overflow compaction failed after durable surface progress: ${message}; retrying from the replacement surface`);
          this.overflowRetries.set(agent, retries + 1);
          return { kind: 'retry' };
        }
        ctx.logger.warn(`compaction-chain: context-overflow compaction failed: ${message}; ${signal.aborted ? 'cancellation prevents retry' : 'preserving the original request error'}`);
        return next();
      }
      if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next();
      if (result !== null) logResult(result, 'context overflow recovery');
      this.overflowRetries.set(agent, retries + 1);
      return { kind: 'retry' };
    });
  }
}

export { routeKey };

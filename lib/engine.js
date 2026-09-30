/**
 * QuiltCompactEngine: the dsh-quilt-compact backend for the DeepSeek
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
import { RunLog, resolveRunLogPath } from './run-log.js';
import { ModelChain, chunkJob, mergeJob, sessionTarget } from './model-chain.js';
import { runStage0 } from './stage0/pipeline.js';
import { extractRegionLines } from './stage0/text.js';
import { lineTokenCost, sliceNextChunk } from './stage0/chunk.js';
import { DEFAULT_MAX_TOKENS, frameSummary } from './summarize.js';
import {
  computeChunkBudget,
  computeUsableInputTokens,
} from './budget.js';
import { createDefaultCompression, readBasicPolicy } from './default-compression.js';
import { validateModelPool } from './model-pool.js';
import { registerQuiltBridge } from './bridge-host.js';
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
 * The dsh-quilt-compact backend. Load as the `compaction` service in place of
 * `dsh-compaction-basic` (`- id: compaction-basic, disabled: true`).
 */
export class QuiltCompactEngine extends CompactionEngine {
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
    // Keep the raw config: `.volatile()` fields are live references that the
    // loader rewrites on a settings edit. `resolveConfig` is re-run from
    // `rawConfig` on every `loader/volatile-update`, so live edits actually
    // reach the running engine (not just the pool re-validation below).
    this.rawConfig = config;
    this.config = resolveConfig(config);
    this.warnDeprecatedPreprocessing(this.config.deprecatedPreprocessing);
    this.warnDeprecatedConfig(this.config.deprecatedConfig);
    this.internals = internals;
    this._storePromise = undefined;
    this._openDomain = undefined;
    this._defaultCompression = undefined;
    this._pendingTrigger = undefined;
    // Pool capabilities (context window + default output cap per route),
    // derived from `resolveModelInfo` and cached per resolved-config snapshot.
    this._capacities = new Map();
    this._capacitiesFor = undefined;
    // JSONL run log (snapshot + result) for evaluating compaction quality.
    // Disabled via `runRecord.enabled`; path can be pinned for tests.
    this.runLog = new RunLog({
      path: this.config.runRecord.path ? resolveRunLogPath(this.config.runRecord.path) : undefined,
      maxEntries: this.config.runRecord.maxEntries,
      snapshotChars: this.config.runRecord.snapshotChars,
      ...internals.now === undefined ? {} : { now: internals.now },
    });
    // Close the lazily-opened domain on unload (idempotent; the consumer owns
    // the handle, so close-on-unmount is the facility's safety net too).
    ctx.effect(() => () => {
      if (this._openDomain !== undefined) void this._openDomain.close();
    });
    this.overflowRetries = new WeakMap();
    this.overflowAgents = new WeakMap();
    this._registerAutomaticCompaction();
    this._validatePool();
    // The settings page edits volatile fields live: the loader commits the new
    // values into the running references and emits `loader/volatile-update`
    // on the owning fiber's ctx. Re-resolve the whole config so the engine
    // actually runs the edited values (chunk ratios, tier pool, preprocessing,
    // run log) instead of a frozen constructor snapshot.
    this.ctx.on('loader/volatile-update', () => {
      this.reloadConfig();
    });
    // Web/desktop profiles mount this engine inside the agent preset's
    // `compaction` group; register the settings bridge from whatever realm the
    // engine lives in (no-op when no webServer — headless/sdk).
    registerQuiltBridge(ctx);
  }

  /**
   * Re-resolve the engine config from the raw (volatile) references. Called on
   * every `loader/volatile-update`; the loader has already committed the edited
   * values into the references, so the new snapshot reflects the settings page.
   *
   * A malformed edit keeps the previous resolved config: the settings page
   * validates through the same `resolveConfig`, so this is a defensive net for
   * direct `fiber.update()` edits, not the page path.
   */
  reloadConfig() {
    let next;
    try {
      next = resolveConfig(this.rawConfig);
    } catch (error) {
      this.ctx.logger.warn(`dsh-quilt-compact: live config edit rejected (keeping the previous resolved config): ${String(error)}`);
      return;
    }
    this.config = next;
    this.warnDeprecatedPreprocessing(next.deprecatedPreprocessing);
    this.warnDeprecatedConfig(next.deprecatedConfig);
    // The run log mirrors runRecord (path, cap, snapshot budget): keep the
    // recorder in step with the edited settings.
    this.runLog.reconfigure({
      path: next.runRecord.path,
      maxEntries: next.runRecord.maxEntries,
      snapshotChars: next.runRecord.snapshotChars,
    });
    // Capacities are keyed to the resolved snapshot: a new snapshot means the
    // pool may have changed, so the cache must refresh on the next summarize.
    this._capacitiesFor = undefined;
    this.ctx.logger.info(`dsh-quilt-compact: live config edit applied (chunkRatio=${next.chunkRatio}, tiers=${next.tiers.reduce((n, t) => n + t.models.length, 0)} route(s), runRecord.enabled=${next.runRecord.enabled})`);
    this._validatePool();
  }

  /**
   * Check the configured pool against the live model registry.
   *
   * A route that does not exist cannot work, so this warns loudly at load and
   * again after each live config edit (`reloadConfig` re-runs it). It
   * deliberately does NOT throw: a provider that is merely slow to register,
   * or one that legitimately publishes no catalog, must not stop the plugin
   * from mounting. The failure stays diagnosable because the warning names
   * every bad route and why.
   */
  _validatePool(config = this.config) {
    void this._runPoolValidation(config);
  }

  /**
   * Warn about preprocessing keys that configs written before a removal still
   * carry. The keys load (never a hard error) and are ignored by the pipeline;
   * the warning exists so an operator notices the config is stale and can drop
   * the field. Each key is warned ONCE per engine lifetime, so a stale config
   * that keeps being re-resolved on volatile edits does not spam the log.
   *
   * @param keys - deprecated keys found by `resolveConfig`.
   */
  warnDeprecatedPreprocessing(keys = []) {
    this._warnedDeprecated ??= new Set();
    for (const key of keys) {
      if (this._warnedDeprecated.has(key)) continue;
      this._warnedDeprecated.add(key);
      this.ctx.logger.warn(`dsh-quilt-compact: preprocessing.${key} is deprecated and ignored (removed from the pipeline; length control belongs to the chunker)`);
    }
  }

  /**
   * Warn about removed TOP-LEVEL config keys that old configs still carry
   * (e.g. `mergeTiers`, the v7 dedicated merge pool). The key loads and is
   * ignored by the pipeline; the warning exists so an operator notices the
   * config is stale and migrates (the merge reuses the main tiers and descends
   * them; size the merge window with `mergeMaxContextTokens`). Warned ONCE per
   * engine lifetime, like the preprocessing deprecations.
   *
   * @param keys - deprecated top-level keys found by `resolveConfig`.
   */
  warnDeprecatedConfig(keys = []) {
    this._warnedConfig ??= new Set();
    for (const key of keys) {
      if (this._warnedConfig.has(key)) continue;
      this._warnedConfig.add(key);
      this.ctx.logger.warn(`dsh-quilt-compact: ${key} is deprecated and ignored (no dedicated merge pool; the merge reuses the main tiers and descends them — size the merge window with mergeMaxContextTokens)`);
    }
  }

  /**
   * Validate the pool against ONE config snapshot. The snapshot is captured at
   * call time: a `loader/volatile-update` arriving while `validateModelPool`
   * is in flight must not retroactively relabel this run's logs with a newer
   * config (and conversely, a validation started for the old config must not
   * silently validate the new one).
   */
  async _runPoolValidation(snapshot) {
    const config = snapshot ?? this.config;
    try {
      const { ok, unknown, unlistable } = await validateModelPool(this.ctx, config);
      if (unlistable.size > 0) {
        this.ctx.logger.info(`dsh-quilt-compact: ${unlistable.size} provider(s) publish no model catalog (${[...unlistable].join(', ')}); their routes are accepted unchecked`);
      }
      if (ok) {
        this.ctx.logger.info(`dsh-quilt-compact: model pool validated (${config.tiers.reduce((n, t) => n + t.models.length, 0)} routes)`);
        return;
      }
      for (const entry of unknown) {
        this.ctx.logger.warn(`dsh-quilt-compact: pool route ${entry.key} (tier "${entry.tier}") is not usable: ${entry.reason}`);
      }
      this.ctx.logger.warn(`dsh-quilt-compact: ${unknown.length} of the configured pool routes are not available; those entries will fail over to the next model when used`);
    } catch (error) {
      this.ctx.logger.warn(`dsh-quilt-compact: model pool validation could not run: ${String(error)}`);
    }
  }

  /** Lazily open the cooldown store (domain-backed when possible). */
  ensureStore() {
    this._storePromise ??= (async () => {
      const facility = this.ctx.get('storageDomain');
      if (facility === undefined) {
        this.ctx.logger.warn('dsh-quilt-compact: storage-domain form not mounted; cooldown state is in-memory only (not persisted)');
        return new MemoryCooldownStore();
      }
      try {
        const domain = await facility.open(chainStateSpec);
        this._openDomain = domain;
        return new DomainCooldownStore(domain);
      } catch (error) {
        this.ctx.logger.warn(`dsh-quilt-compact: opening cooldown state domain failed; cooldown state is in-memory only: ${String(error)}`);
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
   * @param options - optional `{ trigger }`; see {@link takeTrigger}.
   * @returns summary blocks, the framed checkpoint, and the final call facts.
   */
  async summarize(input, agent, signal, options = {}) {
    const store = await this.ensureStore();
    // Stage 0's first step is the same extraction, so this count shares its
    // exact line rule instead of maintaining a second one (the before/after
    // ratio below is only meaningful if both sides use the same line model).
    const inputLines = extractRegionLines(input.messages).length;
    const stage0Before = {
      messages: input.messages.length,
      lines: inputLines,
      chars: input.messages.reduce((sum, message) => sum + JSON.stringify(message.content ?? message).length, 0),
    };
    const lines = this.runStage0(input.messages);
    if (lines.length === 0) {
      throw new Error('dsh-quilt-compact: nothing to condense after Stage 0 preprocessing');
    }
    const capacities = await this.resolvePoolCapacities(signal);
    // v7 single-level merge window: `mergeMaxContextTokens` (归并前最多保留
    // 多少上下文), which ALWAYS resolves — 128k when the config does not set
    // it (there is no pool-derived "unset" branch). All chunk digests are
    // merged in ONE call, so this window must fit some healthy pool model —
    // checked before dispatching the merge (§4). The merge reuses the MAIN
    // tiers and descends tiers to find a route whose window can hold it; there
    // is no dedicated merge pool.
    const mergeWindow = this.config.mergeMaxContextTokens;
    const mergeUsableInput = computeUsableInputTokens(mergeWindow);
    // Region total token T (dsh-token-meter chars/4 heuristic): proportional
    // digest caps `cap_i = U × chunkTokens_i / T` are derived from it.
    const regionTokens = lines.reduce((sum, line) => sum + lineTokenCost(line), 0);
    const regionChars = stage0Before.chars;

    const chain = new ModelChain(this.ctx, this.config, store, this.internals, capacities);
    // v7: the merge runs through its OWN ModelChain instance over the SAME
    // main `tiers` (no dedicated merge pool). "归并允许单独降池": the merge's
    // scheduler descends tiers independently — tier-0 chunk models that cannot
    // hold the merge input are skipped by capacity matching, and the job
    // degrades to the next tier until it finds a route with enough context.
    // `mergeMaxContextTokens` sizes the merge window the descent searches for.
    const mergeChain = new ModelChain(this.ctx, this.config, store, this.internals, capacities);
    const fallbackOptions = {
      // The session-model fallback hands the ORIGINAL region input straight
      // to the default compression plugin (direct call, KV-cache reuse).
      fallbackInput: input,
      defaultSummarize: (regionInput, owner, abort) => this.defaultCompression().summarize(regionInput, owner, abort),
      capacities,
    };

    // v7 model-driven chunk loop: each round PICK a model (round-robin over
    // healthy+free routes), slice the next chunk sized to THAT model's own
    // window, and bind the job to it (preferredKey) with a proportional digest
    // cap. A chunk is thus always as large as its target model can hold — the
    // "model cannot hold the context" problem is eliminated by construction.
    const jobs = [];
    let cursor = 0;
    let chunkIndex = 0;
    let slicedAny = false;
    while (cursor < lines.length) {
      const model = chain.pickChunkModel(capacities);
      if (model === undefined) {
        // No healthy+free route right now: stop slicing and let the chain wait
        // for a cooldown expiry or fall back (the jobs already built still run).
        this.ctx.logger.info(`dsh-quilt-compact summarize: pausing chunk slicing (no healthy+free model); ${lines.length - cursor} line(s) remain`);
        break;
      }
      const modelWindow = chain.modelWindow(model, capacities);
      const chunkBudget = computeChunkBudget(modelWindow, this.config.chunkRatio);
      const overlapTokens = Math.max(0, Math.floor(chunkBudget * this.config.chunkOverlapRatio));
      const { end, next } = sliceNextChunk(lines, cursor, chunkBudget, overlapTokens);
      const chunkLinesSlice = lines.slice(cursor, end);
      if (chunkLinesSlice.length === 0) break;
      const tokens = chunkLinesSlice.reduce((sum, line) => sum + lineTokenCost(line), 0);
      const cap = Math.max(1, Math.floor(mergeUsableInput * tokens / Math.max(1, regionTokens)));
      chunkIndex += 1;
      jobs.push(chunkJob(`chunk ${chunkIndex}`, chunkLinesSlice.join('\n'), {
        lineStart: cursor,
        lineEnd: end,
        tokens,
      }, model.key, cap));
      slicedAny = true;
      cursor = next;
    }
    if (!slicedAny) {
      throw new Error('dsh-quilt-compact: Stage 0 chunking produced no chunks (no usable model at slice time)');
    }
    this.ctx.logger.info(`dsh-quilt-compact summarize: regionChars=${regionChars} stage0 ${stage0Before.lines}->${lines.length} lines (${(lines.length / (stage0Before.lines || 1)).toFixed(3)} kept) chunks=${chunkIndex} mergeWindow=${mergeWindow} mergeUsableInput=${mergeUsableInput} regionTokens=${regionTokens} overlapTokens=${Math.max(0, Math.floor(computeChunkBudget(mergeWindow, this.config.chunkRatio) * this.config.chunkOverlapRatio))}`);

    const chunkResults = await chain.run(jobs, agent, signal, fallbackOptions);
    const digests = chunkResults.filter((result) => result !== undefined).map((result) => result.text);
    if (digests.some((text) => text === undefined || text.length === 0)) {
      throw new Error('dsh-quilt-compact: a chunk digest was empty');
    }

    let finalResult;
    if (digests.length === 1) {
      // Single-chunk regions have no overlaps to deduplicate, so the chunk
      // digest IS the final checkpoint digest (merge call skipped; one pass).
      finalResult = chunkResults.find((result) => result !== undefined);
      finalResult = { ...finalResult, mergeLevels: 0 };
    } else if (mergeChain.canHoldMerge(mergeWindow, capacities)) {
      // v7 single-level merge: ALL digests in one call. The digest caps keep
      // Σ cap_i ≤ usableInput(mergeWindow), so a healthy model with window
      // ≥ mergeWindow can always hold the joined digests.
      const mergeResult = await mergeChain.run([mergeJob(digests, { sourceChunks: digests.length })], agent, signal, fallbackOptions);
      const merged = mergeResult[0];
      if (merged === undefined || merged.text === undefined || merged.text.length === 0) {
        throw new Error('dsh-quilt-compact: the single-level merge produced an empty digest');
      }
      finalResult = { ...merged, mergeLevels: 1 };
    } else {
      // After descending every tier, no healthy pool route can hold the merge
      // window: fall back directly (single-level merge, no hierarchical
      // shrink to attempt).
      const target = sessionTarget(agent);
      if (!this.config.fallbackToSessionModel) {
        throw new Error('dsh-quilt-compact: no pool route can hold the single-level merge (after tier descent) and session-model fallback is disabled');
      }
      if (target === undefined) {
        throw new Error('dsh-quilt-compact: no pool route can hold the single-level merge (after tier descent) and no session-model target is available for fallback');
      }
      const collapsed = await mergeChain.fallbackCall(
        digests.map((text, index) => ({ label: `merge ${index + 1}`, sourceText: text, digests: [text] })),
        target,
        agent,
        signal,
        fallbackOptions,
      );
      finalResult = { ...collapsed, mergeLevels: 0, fallbackReason: 'no-merge-model' };
    }
    if (finalResult === undefined || finalResult.text === undefined) {
      throw new Error('dsh-quilt-compact: summarization produced no final digest');
    }

    const summary = [{ type: 'text', text: finalResult.text }];
    this.ctx.logger.info(`dsh-quilt-compact summarize done: route=${finalResult.provider}/${finalResult.model} fallback=${finalResult.fallback === true} digestChars=${finalResult.text.length} maxTokens=${finalResult.maxTokens ?? DEFAULT_MAX_TOKENS} attempts=${finalResult.attempts?.length ?? 0}`);
    if (this.config.runRecord.enabled) {
      // Fire-and-forget: a failed log write must never break compaction. The
      // RunLog serializes and swallows its own errors.
      void this.runLog.append(input, finalResult, {
        trigger: options.trigger ?? 'auto',
        regionChars,
        stage0Lines: lines.length,
        inputLines: stage0Before.lines,
        chunkCount: chunkIndex,
        mergeLevels: finalResult.mergeLevels ?? 0,
        mergeWindow,
        mergeUsableInput,
        regionTokens,
      }).catch((error) => {
        this.ctx.logger.warn(`dsh-quilt-compact: run log write failed: ${String(error)}`);
      });
    }
    return {
      summary,
      rawOutput: summary,
      llmStreamCall: true,
      provider: finalResult.provider,
      model: finalResult.model,
      maxTokens: finalResult.maxTokens ?? DEFAULT_MAX_TOKENS,
      usage: finalResult.usage,
      checkpoint: frameSummary(summary),
      fallback: finalResult.fallback === true,
      attempts: finalResult.attempts,
      chainStats: {
        chunkCount: chunkIndex,
        mergeLevels: finalResult.mergeLevels ?? 0,
        mergeWindow,
        mergeUsableInput,
        regionTokens,
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

  /**
   * Resolve per-route capacity metadata (`contextWindow` + `maxTokens`) for
   * every pool route, cached per resolved-config snapshot. The scheduler
   * selects models by capacity, and the merge window derives from the pool —
   * both must agree on one capacity source.
   *
   * A route whose capacity cannot be resolved (unknown model, unregistered
   * provider, no catalog) is recorded with the DEFAULTS (v7):
   * `DEFAULT_CONTEXT_WINDOW` / `DEFAULT_MAX_TOKENS` — the scheduler matches it
   * under the default window instead of treating it as unconstrained.
   *
   * @param signal - optional cancellation forwarded to `resolveModelInfo`.
   * @returns `Map<routeKey, { contextWindow, maxTokens }>` (never undefined).
   */
  async resolvePoolCapacities(signal) {
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
      } catch (error) {
        this.ctx.logger.warn(`dsh-quilt-compact: resolving capacity for ${model.key} failed (${String(error)}); using defaults ${DEFAULT_CONTEXT_WINDOW}/${DEFAULT_MAX_TOKENS}`);
      }
      capacities.set(model.key, {
        contextWindow: Number.isInteger(contextWindow) && contextWindow > 0
          ? contextWindow
          : DEFAULT_CONTEXT_WINDOW,
        maxTokens: Number.isInteger(maxTokens) && maxTokens > 0
          ? maxTokens
          : DEFAULT_MAX_TOKENS,
      });
    }));
    // Cache only on success: a transient discovery failure must not pin an
    // empty map against the resolved config forever.
    if (capacities.size > 0 || allModels.length === 0) {
      this._capacities = capacities;
      this._capacitiesFor = this.config;
    }
    return capacities;
  }

  /**
   * Resolve the SINGLE-LEVEL merge window (v7): `mergeMaxContextTokens`
   * (归并前最多保留多少上下文). The config ALWAYS resolves a value — 128k
   * (`DEFAULT_MERGE_MAX_CONTEXT_TOKENS`) when unset — so there is no
   * pool-derived "unset" branch. The merge is one call over ALL chunk digests;
   * proportional per-chunk digest caps (see summarize) keep
   * `Σ cap_i ≤ usableInput(mergeWindow)`, so a pool model whose window reaches
   * `mergeWindow` can always hold the merge.
   *
   * @param capacities - per-route capacity map (unused; the configured value
   *   is authoritative).
   * @returns the merge window in tokens.
   */
  resolveMergeWindow(capacities) {
    return this.config.mergeMaxContextTokens;
  }

  /**
   * Run Stage 0 over one summarization input.
   *
   * A single overridable method rather than a direct import, so a consumer (the
   * faithfulness benchmark's ablation variants) can restore a legacy Stage 0
   * transform for comparison without forking the engine.
   *
   * @param messages - replayed conversation prefix messages.
   * @returns the preprocessed line document.
   */
  runStage0(messages) {
    return runStage0(messages, this.config.preprocessing);
  }

  /**
   * Consume the pending trigger for ONE compaction.
   *
   * A single logical compaction can summarize more than once: the recovery
   * waterfall re-summarizes after `compaction/summary-error`, and the
   * automatic pressure loop can compact several ranges in one call. Every one
   * of those runs must be labelled from the trigger that STARTED it, and the
   * pending field must be cleared as soon as it is read — otherwise it
   * outlives its own compaction and stamps the NEXT unrelated one, so the run
   * log invents a `manual` compaction nobody asked for.
   *
   * @param explicit - trigger supplied by the caller (authoritative).
   * @returns the trigger to label this compaction with.
   */
  takeTrigger(explicit) {
    if (explicit !== undefined) return explicit;
    const pending = this._pendingTrigger;
    this._pendingTrigger = undefined;
    return pending ?? 'auto';
  }

  /** Bind the region transaction to this engine's summarizer and recovery. */
  regionDependencies(trigger) {
    const deps = {
      summarize: (input, owner, abort) => this.summarize(input, owner, abort, {
        trigger: this.takeTrigger(trigger),
      }),
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
  async compactRegion(start, end, agent, signal, trigger) {
    return compactSurfaceRegion(this.regionDependencies(trigger), agent.session, start, end, agent, {
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
    const label = trigger === 'context-overflow' ? 'context-overflow' : 'pressure';
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
      return this.compactRegion(range.start, range.end, agent, signal, label);
    }
    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction');
    if (info.context === undefined || info.context.contextWindow === undefined) {
      this.ctx.logger.warn(`dsh-quilt-compact: no context capacity for ${target.provider}/${target.model}; skipping automatic pressure compaction`);
      return null;
    }
    const contextWindow = info.context.contextWindow;
    const reservedCompletion = agent.session.requestHeader()?.config.maxTokens ?? info.defaultMaxTokens ?? 0;
    const messageBudgetTokens = contextWindow - reservedCompletion;
    if (messageBudgetTokens <= 0) {
      this.ctx.logger.warn(`dsh-quilt-compact: ${target.provider}/${target.model} reserves the whole context window; skipping automatic pressure compaction`);
      return null;
    }
    const { thresholdRatio, retainRatio, headroomTokens, compactionRetries } = readBasicPolicy();
    const pressureBudgetTokens = messageBudgetTokens - headroomTokens;
    if (pressureBudgetTokens <= 0) {
      this.ctx.logger.warn(`dsh-quilt-compact: ${target.provider}/${target.model} pressure budget is non-positive; skipping automatic pressure compaction`);
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
      result = await this.compactRegion(range.start, range.end, agent, signal, label);
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
          this._pendingTrigger = 'manual';
          const range = selectCompactableRange(agent.session, this.ctx.tokenMeter.measure(agent.session).nodes, 0);
          if (range === null) return null;
          return await compactSurfaceRegion(this.regionDependencies('manual'), agent.session, range.start, range.end, agent, {
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
      ctx.logger.info(`dsh-quilt-compact (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes (seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`);
    };
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal);
          if (result !== null) logResult(result, 'step pressure');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.logger.warn(`dsh-quilt-compact: step compaction failed: ${message}; continuing the turn`);
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
          ctx.logger.warn(`dsh-quilt-compact: context-overflow compaction failed after durable surface progress: ${message}; retrying from the replacement surface`);
          this.overflowRetries.set(agent, retries + 1);
          return { kind: 'retry' };
        }
        ctx.logger.warn(`dsh-quilt-compact: context-overflow compaction failed: ${message}; ${signal.aborted ? 'cancellation prevents retry' : 'preserving the original request error'}`);
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

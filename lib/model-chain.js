/**
 * ModelChain: the tiered model-pool scheduler.
 *
 * Semantics (design v3 §3):
 *
 * - Every job (chunk digest, merge) enters one shared dispatch queue; there
 *   is no batching. Per-model concurrency (`maxConcurrent`) is the only cap.
 * - A job picks a model from its current tier whose cooldown is healthy and
 *   whose in-flight count is below `maxConcurrent` (round-robin fairness).
 * - Healthy-but-busy tiers make the job WAIT for a released slot or for a
 *   cooled model's cooldown to expire (§3.2: "直到有模型释放槽位或冷却到期").
 * - A tier with NO healthy model makes the job DEGRADE to the next tier
 *   (per-job progression; a batch whose tier is fully cooled visibly skips
 *   it, matching "整体降级"). Degradation is one-way.
 * - A model call failure is the "DSH retryPolicy exhausted" boundary: the
 *   plugin writes that model's cooldown, releases its slot, and requeues the
 *   job. A single failure never degrades the tier; only a tier with no
 *   healthy model degrades (§3.3).
 * - When every tier has no healthy model, the batch collapses (§3.4): the
 *   session model (fallback, default on) summarizes everything pending in
 *   one call, or the batch throws when fallback is disabled.
 *
 * The scheduler is clock-injectable (`now`) and sleep-injectable (`sleep`)
 * so tests can drive cooldown expiry deterministically.
 *
 * @module dsh-quilt-compact/model-chain
 */
import { createHash } from 'node:crypto';
import { errorChain } from '@deepseek-ai/dsh-llm';
import { computeCooldownUntil } from './cooldown.js';
import {
  BUILTIN_MAX_TOKENS,
  chunkMessages,
  mergeMessages,
  fallbackInstruction,
  streamText,
  blocksToText,
} from './summarize.js';

function defaultNow() {
  return Date.now();
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

/** Character and heuristic-token counts of one input text. */
function textStats(text) {
  const chars = String(text).length;
  return { chars, tokens: Math.ceil(chars / 4) };
}

/** Short stable fingerprint of an input text (never logs the full text). */
function fingerprint(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 12);
}

/** Single-line truncated preview of an input text (privacy: short only). */
function preview(text, max = 80) {
  const single = String(text).replace(/\s+/g, ' ').trim();
  if (single.length <= max) return single;
  return `${single.slice(0, Math.max(0, max - 1))}…`;
}

/** A one-shot wake that can be re-armed for the next dispatch pass. */
function wakeHandle() {
  let resolve = () => {};
  let promise = new Promise((res) => {
    resolve = res;
  });
  return {
    get promise() {
      return promise;
    },
    fire: () => resolve(),
    reset: () => {
      promise = new Promise((res) => {
        resolve = res;
      });
    },
  };
}

/**
 * The tiered pool scheduler. Construct once per engine; one instance may run
 * many batches (each batch is one compaction's chunk+merge jobs).
 */
export class ModelChain {
  /**
   * @param ctx - context providing `llm` and `logger`.
   * @param config - resolved compaction-chain config.
   * @param store - CooldownStore instance.
   * @param internals - optional `{ now, sleep }` test hooks.
   */
  constructor(ctx, config, store, internals = {}) {
    this.ctx = ctx;
    this.config = config;
    this.store = store;
    this.now = internals.now ?? defaultNow;
    this.sleep = internals.sleep ?? defaultSleep;
    this.tiers = config.tiers;
    // route key -> model entry
    this.routes = new Map();
    for (const tier of this.tiers) {
      for (const model of tier.models) this.routes.set(model.key, model);
    }
    // route key -> in-flight call count
    this.inFlight = new Map();
    for (const key of this.routes.keys()) this.inFlight.set(key, 0);
    // round-robin cursor per tier
    this.cursorByTier = this.tiers.map(() => 0);
  }

  /**
   * Run a batch of jobs through the pool.
   * @param jobs - `[{ label, buildMessages(config) -> messages }]`.
   * @param agent - agent context (`session.id` stamps the calls).
   * @param signal - optional cancellation.
   * @param options - fallback wiring:
   *   - `fallbackInput` — the ORIGINAL region input (`{ tools?, messages }`,
   *     conversation prefix unchanged) the session-model fallback hands to
   *     the default compression plugin.
   *   - `defaultSummarize(input, agent, signal)` — direct call into
   *     `dsh-compaction-basic`'s summarizer (replays the prefix + appends the
   *     instruction, reusing the provider KV cache; one call, one pass).
   * @returns per-job results `[{ text, provider, model, usage, attempts }]`.
   */
  async run(jobs, agent, signal, options = {}) {
    if (jobs.length === 0) return [];
    const pending = jobs.map((job, index) => ({
      index,
      label: job.label,
      meta: job.meta,
      buildMessages: job.buildMessages,
      sourceText: job.text,
      digests: job.digests,
      tierIndex: 0,
      running: false,
      done: false,
      aborted: false,
      attempts: [],
      result: undefined,
    }));
    const results = new Array(jobs.length);
    const wake = wakeHandle();
    // Cooldown-expiry wake: each pass arms a fresh wait; a serial token makes
    // stale (superseded) waits' late fires harmless, so cancelling a previous
    // pass's wait can never self-wake the loop into a busy spin.
    let cooldownSerial = 0;

    // Batch observability (see the per-call debug logs below).
    const batchStartedAt = Date.now();
    const callsByRoute = new Map();
    let totalCalls = 0;
    let failureCount = 0;
    let fallbackUsed = false;
    const countRoute = (key) => {
      callsByRoute.set(key, (callsByRoute.get(key) ?? 0) + 1);
      totalCalls += 1;
    };

    const releaseSlot = (key) => {
      this.inFlight.set(key, Math.max(0, (this.inFlight.get(key) ?? 1) - 1));
    };

    const settle = () => {
      wake.fire();
    };

    const armCooldownWake = () => {
      const serial = ++cooldownSerial;
      const now = this.now();
      let earliest = Infinity;
      for (const key of this.routes.keys()) {
        const until = this.store.cooldownUntil(key);
        if (until > now && until < earliest) earliest = until;
      }
      if (earliest === Infinity) return;
      const delay = Math.max(0, earliest - now);
      void this.sleep(delay).then(() => {
        if (serial === cooldownSerial) settle();
      });
    };

    const startCall = (task, model) => {
      task.running = true;
      this.inFlight.set(model.key, (this.inFlight.get(model.key) ?? 0) + 1);
      countRoute(model.key);
      const options = {
        provider: model.provider,
        model: model.model,
        messages: task.buildMessages(this.config),
        maxTokens: BUILTIN_MAX_TOKENS,
        sessionId: agent.session.id,
        purpose: 'compaction',
        ...signal === undefined ? {} : { signal },
      };
      // Input segment identification for the debug log: for a chunk job this
      // is the region line range from Stage 0c; for merge/fallback it is the
      // joined digest material. Only stats + fingerprint + a short preview are
      // logged — never full session content.
      const inputText = task.sourceText ?? (task.digests ?? []).join('\n\n');
      const input = textStats(inputText);
      const requestChars = options.messages.reduce(
        (sum, message) => sum + JSON.stringify(message.content ?? message).length,
        0,
      );
      const lineRange = task.meta?.lineStart !== undefined && task.meta?.lineEnd !== undefined
        ? ` lines=${task.meta.lineStart + 1}..${task.meta.lineEnd}`
        : '';
      const startedAt = Date.now();
      this.ctx.logger?.debug?.(`compaction-chain call: job=${task.label} route=${model.key} inputChars=${input.chars} inputTokens~=${input.tokens}${lineRange} requestChars=${requestChars} sha=${fingerprint(inputText)} preview="${preview(inputText)}"`);
      (async () => {
        try {
          const { summary, usage } = await streamText(this.ctx, options);
          const text = blocksToText(summary);
          this.ctx.logger?.debug?.(`compaction-chain call ok: job=${task.label} route=${model.key} outputChars=${text.length} outputTokens=${usage?.outputTokens ?? '?'} durationMs=${Date.now() - startedAt}`);
          task.result = {
            text,
            provider: model.provider,
            model: model.model,
            usage,
            attempts: task.attempts,
          };
          task.done = true;
        } catch (error) {
          if (signal?.aborted === true) {
            // Cancellation is not a model failure: no cooldown, no requeue.
            task.aborted = true;
            this.ctx.logger?.debug?.(`compaction-chain call aborted: job=${task.label} route=${model.key}`);
          } else {
            // DSH retryPolicy exhausted (direct call, single attempt):
            // cooldown THIS model and requeue the job.
            failureCount += 1;
            const until = computeCooldownUntil(model.cooldown, this.now());
            try {
              await this.store.applyCooldown(model.key, until);
            } catch (storeError) {
              this.ctx.logger?.warn?.(`compaction-chain: cooldown write failed for ${model.key}: ${errorChain(storeError)}`);
            }
            this.ctx.logger?.warn?.(`compaction-chain: route ${model.key} failed (${errorChain(error)}) for job=${task.label} sha=${fingerprint(inputText)}; cooling until ${new Date(until).toISOString()}`);
            task.attempts.push({ model: model.key, error: errorChain(error) });
            task.running = false;
          }
        } finally {
          task.running = false;
          releaseSlot(model.key);
          wake.fire();
        }
      })();
    };

    try {
      for (;;) {
        signal?.throwIfAborted();
        // Fresh wake for THIS pass: every settle during this pass fires it.
        wake.reset();
        armCooldownWake();
        let dispatchedAny = false;
        const blocked = [];
        for (const task of pending) {
          if (task.done || task.running) continue;
          const model = this.pickModel(task);
          if (model !== undefined) {
            startCall(task, model);
            dispatchedAny = true;
          } else {
            blocked.push(task);
          }
        }
        const activeCount = pending.filter((task) => !task.done && !task.running).length;
        const running = pending.some((task) => task.running);
        if (blocked.length === 0 && !running) break; // batch complete
        const fullyDegraded = blocked.length > 0
          && blocked.length === activeCount
          && blocked.every((task) => task.tierIndex >= this.tiers.length);
        if (fullyDegraded && !running) {
          // No healthy model in any tier and nothing else can free a slot.
          const target = sessionTarget(agent);
          if (this.config.fallbackToSessionModel) {
            if (target === undefined) {
              throw new Error('compaction-chain: all tiers have no healthy model and no session-model target is available for fallback');
            }
            fallbackUsed = true;
            const collapsed = await this.fallbackCall(blocked, target, agent, signal, options);
            for (const task of blocked) results[task.index] = collapsed;
            break;
          }
          throw new Error('compaction-chain: all tiers have no healthy model and session-model fallback is disabled');
        }
        // Wait for a settle (slot release, success, failure, cancellation) or
        // a cooldown expiry.
        await wake.promise;
      }
      for (const task of pending) {
        if (task.result !== undefined) results[task.index] = task.result;
      }
      this.ctx.logger?.info?.(`compaction-chain batch: jobs=${jobs.length} calls=${totalCalls} byRoute=${[...callsByRoute.entries()].map(([key, count]) => `${key}:${count}`).join(',')} failures=${failureCount} fallback=${fallbackUsed} durationMs=${Date.now() - batchStartedAt}`);
      return results;
    } finally {
      cooldownSerial += 1; // invalidate any still-pending cooldown wake
    }
  }

  /**
   * Pick a model for one task, degrading its tier while the current tier has
   * no healthy model. Returns `undefined` when every tier is healthy-but-busy
   * (the task waits) or the task has degraded past the last tier.
   */
  pickModel(task) {
    const now = this.now();
    while (task.tierIndex < this.tiers.length) {
      const tier = this.tiers[task.tierIndex];
      const cursor = this.cursorByTier[task.tierIndex];
      let healthyFree = undefined;
      let anyHealthy = false;
      for (let offset = 0; offset < tier.models.length; offset += 1) {
        const model = tier.models[(cursor + offset) % tier.models.length];
        const healthy = this.store.isHealthy(model.key, now);
        if (healthy) anyHealthy = true;
        const free = (this.inFlight.get(model.key) ?? 0) < model.maxConcurrent;
        if (healthy && free && healthyFree === undefined) healthyFree = model;
      }
      this.cursorByTier[task.tierIndex] = (cursor + 1) % Math.max(1, tier.models.length);
      if (healthyFree !== undefined) return healthyFree;
      if (!anyHealthy) {
        // Current tier has no healthy model: degrade to the next tier.
        task.tierIndex += 1;
        continue;
      }
      // Tier has healthy models but all at capacity: wait for a released slot.
      return undefined;
    }
    return undefined;
  }

  /**
   * One fallback call over all still-pending jobs (session model).
   *
   * Preferred path: DIRECT call to the default compression plugin
   * (`options.defaultSummarize` = `dsh-compaction-basic`'s summarizer over
   * `options.fallbackInput`). It replays the original conversation prefix
   * (system + region messages, unchanged) and appends its compaction
   * instruction as the FINAL user message — the default cache-reusing
   * compression (provider KV cache preserved) — and produces the whole-region
   * checkpoint in ONE call: when a single chunk would have sufficed, that
   * call IS the one-pass completion.
   *
   * Last resort (no `defaultSummarize` injected, e.g. standalone chain use):
   * join the pending job material into one request.
   */
  async fallbackCall(tasks, target, agent, signal, options) {
    const startedAt = Date.now();
    const routeKeyText = `${target.provider}/${target.model}`;
    const summarize = options?.defaultSummarize;
    if (summarize !== undefined && options.fallbackInput !== undefined) {
      const result = await summarize(options.fallbackInput, agent, signal);
      const text = blocksToText(result.summary);
      this.ctx.logger?.debug?.(`compaction-chain call: job=fallback route=${routeKeyText} defaultPlugin=true inputChars=${result.usage?.inputTokens ?? '?'} outputChars=${text.length} outputTokens=${result.usage?.outputTokens ?? '?'} durationMs=${Date.now() - startedAt}`);
      return {
        text,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        attempts: tasks.flatMap((task) => task.attempts),
        fallback: true,
      };
    }
    const texts = [];
    for (const task of tasks) {
      if (task.label === 'merge') {
        texts.push(`--- digest ---\n${(task.digests ?? []).join('\n\n')}`);
      } else {
        texts.push(task.sourceText);
      }
    }
    const joined = texts.join('\n\n');
    const input = textStats(joined);
    const callOptions = {
      provider: target.provider,
      model: target.model,
      messages: [
        { role: 'user', content: [{ type: 'text', text: joined }] },
        { role: 'user', content: [{ type: 'text', text: fallbackInstruction(this.config) }] },
      ],
      maxTokens: BUILTIN_MAX_TOKENS,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...signal === undefined ? {} : { signal },
    };
    this.ctx.logger?.debug?.(`compaction-chain call: job=fallback route=${routeKeyText} defaultPlugin=false inputChars=${input.chars} inputTokens~=${input.tokens} requestChars=${callOptions.messages.reduce((sum, message) => sum + JSON.stringify(message.content ?? message).length, 0)} sha=${fingerprint(joined)} preview="${preview(joined)}"`);
    const { summary, usage } = await streamText(this.ctx, callOptions);
    const text = blocksToText(summary);
    this.ctx.logger?.debug?.(`compaction-chain call ok: job=fallback route=${routeKeyText} outputChars=${text.length} outputTokens=${usage?.outputTokens ?? '?'} durationMs=${Date.now() - startedAt}`);
    return {
      text,
      provider: target.provider,
      model: target.model,
      usage,
      attempts: tasks.flatMap((task) => task.attempts),
      fallback: true,
    };
  }
}

/**
 * Resolve the session-model target: the durably routed request header's
 * config, else the agent's own options (design §3.4: `requestHeader().config
 * ?? agent.options`).
 */
export function sessionTarget(agent) {
  const header = agent.session.requestHeader?.();
  if (header?.config !== undefined
    && typeof header.config.provider === 'string' && header.config.provider.length > 0
    && typeof header.config.model === 'string' && header.config.model.length > 0) {
    return { provider: header.config.provider, model: header.config.model };
  }
  if (agent.options?.provider !== undefined && agent.options?.provider.length > 0
    && agent.options?.model !== undefined && agent.options?.model.length > 0) {
    return { provider: agent.options.provider, model: agent.options.model };
  }
  return undefined;
}

/** Build a chunk job for the chain. `meta` carries Stage 0c segment facts. */
export function chunkJob(label, text, meta) {
  return {
    label,
    text,
    meta,
    buildMessages: (config) => chunkMessages(text, config),
  };
}

/** Build the merge job for the chain. */
export function mergeJob(digests, meta) {
  return {
    label: 'merge',
    digests,
    meta,
    buildMessages: (config) => mergeMessages(digests, config),
  };
}

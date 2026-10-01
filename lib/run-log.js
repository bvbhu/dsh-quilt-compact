/**
 * Append-only JSONL run log for compaction evaluation.
 *
 * Every compaction (manual `/compact`, automatic pressure, or context
 * overflow) writes one JSON line per run: the input snapshot (capped),
 * the output digest, the route that served it, and the pipeline stats.
 * The file is a plain JSONL under the DSH storage root, so it can be
 * tailed, diffed, and analyzed with any JSON tooling.
 *
 * The file is capped at `maxEntries`: when appends exceed the cap the log
 * is rewritten keeping only the most recent entries (cheap at this volume;
 * compactions are rare).
 *
 * Writes are serialized through a promise chain so concurrent compactions
 * cannot interleave lines; a failed write is logged but never throws into
 * the compaction path.
 *
 * @module dsh-quilt-compact/run-log
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Default file name under the DSH storage root. */
export const DEFAULT_RUN_LOG_FILE = 'dsh_quilt_compact_runs.jsonl';

/**
 * The DeepSeek Harness home, resolved by the same precedence the harness
 * itself uses (`@deepseek-ai/dsh-home-paths` `resolveDshHome()`): a
 * non-empty `$DSH_HOME` wins, otherwise the default `~/.dsh`. The run log
 * lives under the harness's `storages` root so a custom `DSH_HOME` (or a
 * profile-level home override) keeps it inside the harness data root instead
 * of silently landing next to it.
 */
export function resolveDshHome() {
  const env = process.env.DSH_HOME;
  if (env !== undefined && env.trim().length > 0) return env;
  return join(homedir(), '.dsh');
}

/** Defaults applied when config omits a field. */
export const DEFAULT_RUN_LOG = Object.freeze({
  enabled: false,
  maxEntries: 200,
  // 0 = store NO conversation text. The run log is an attribution/diagnostics
  // record, not a copy of the session; `ref` points back to the session's own
  // event log. Set a positive budget only to opt into embedding a capped copy.
  snapshotChars: 0,
  path: undefined,
});

/**
 * Resolve the run-log file path: explicit config path wins; otherwise the
 * DSH storage root (`$DSH_HOME/storages`, `~/.dsh/storages` by default).
 *
 * @param path - explicitly configured path, or undefined.
 * @returns the absolute run-log file path.
 */
export function resolveRunLogPath(path) {
  if (typeof path === 'string' && path.length > 0) return path;
  return join(resolveDshHome(), 'storages', DEFAULT_RUN_LOG_FILE);
}

/**
 * Flatten an error (with its `cause` chain) into one bounded single-line
 * reason. Redundant wrappers are dropped (a message already contained in the
 * chain, or containing it, adds nothing), so the result is the shortest
 * faithful chain "top: cause: root-cause". This is THE reason string used by
 * every failure surface: run-log failure records, the engine's error-level
 * log line, and the enriched `ManualCompactionError` messages.
 *
 * @param error - the thrown value (any shape; non-Errors stringify).
 * @param limit - maximum characters of the returned reason.
 * @returns the single-line reason (never empty when `error` carries text).
 */
export function describeError(error, limit = 600) {
  const parts = [];
  for (let current = error, depth = 0; current !== undefined && depth < 4; current = current?.cause, depth += 1) {
    const message = current instanceof Error && typeof current.message === 'string'
      ? current.message
      : (typeof current === 'string' && current.length > 0 ? current : undefined);
    if (message === undefined) continue;
    if (parts.some((part) => part.includes(message) || message.includes(part))) continue;
    parts.push(message);
  }
  let reason = parts.join(': ').replace(/\s+/g, ' ').trim();
  if (reason.length > limit) reason = `${reason.slice(0, limit - 1)}…`;
  return reason;
}

/**
 * Non-enumerable marker that an error's diagnostics were already emitted
 * (error-level log line, and a failed run record when the run log is enabled).
 * The summarize stage and the region/transaction layer share one failure
 * chain: an error thrown by `_summarize` is logged by the engine's summarize
 * failure recorder, then rethrown and possibly wrapped into a
 * `ManualCompactionError` by the transaction — without the marker, the
 * transaction boundary would log the SAME failure a second time. The marker is
 * walked through the `cause` chain (up to 4 deep, like {@link describeError}),
 * so a wrapper still counts as already-recorded.
 */
const FAILURE_RECORDED = Symbol('dsh-quilt-compact.failure-recorded');

/** Mark an error (and its cause chain) as already recorded for diagnostics. */
export function markFailureRecorded(error) {
  for (let current = error, depth = 0; current !== undefined && depth < 4; current = current?.cause, depth += 1) {
    if (typeof current === 'object' && current !== null) {
      try {
        current[FAILURE_RECORDED] = true;
      } catch {
        // A frozen error object cannot take the marker; it just logs again.
      }
    }
  }
}

/** Whether an error (or its cause chain) already had diagnostics recorded. */
export function wasFailureRecorded(error) {
  for (let current = error, depth = 0; current !== undefined && depth < 4; current = current?.cause, depth += 1) {
    if (typeof current === 'object' && current !== null && current[FAILURE_RECORDED] === true) return true;
  }
  return false;
}

/** Character budget split for the snapshot: head keeps this fraction. */
const SNAPSHOT_HEAD_RATIO = 0.8;

/**
 * Cap a snapshot string to `chars` characters: keep the head (80%) and the
 * tail (20%) with an elision marker, mirroring the Stage-0 headMiddleTail
 * philosophy so a reviewer still sees both the start and the end.
 *
 * @param text - the raw snapshot text.
 * @param chars - character budget; `<= 0` keeps everything.
 * @returns the capped snapshot.
 */
export function capSnapshot(text, chars) {
  if (chars <= 0 || text.length <= chars) return text;
  const headChars = Math.floor(chars * SNAPSHOT_HEAD_RATIO);
  const tailChars = chars - headChars;
  return `${text.slice(0, headChars)}\n…[elided ${text.length - chars} chars]…\n${text.slice(-tailChars)}`;
}

/**
 * Append-only JSONL run log.
 */
export class RunLog {
  /**
   * @param options
   * @param options.path - run-log file path (defaults to the DSH storage root).
   * @param options.maxEntries - entries kept before the file is trimmed.
   * @param options.snapshotChars - snapshot character budget per run.
   * @param options.now - clock for `at` timestamps (test hook).
   */
  constructor(options = {}) {
    this.path = resolveRunLogPath(options.path);
    this.maxEntries = options.maxEntries ?? DEFAULT_RUN_LOG.maxEntries;
    this.snapshotChars = options.snapshotChars ?? DEFAULT_RUN_LOG.snapshotChars;
    this.now = options.now ?? Date.now;
    /** Serialized write chain: every append waits on the previous one. */
    this.chain = Promise.resolve();
    this._pending = 0;
  }

  /** Apply a live runRecord edit: path, cap, and snapshot budget. */
  reconfigure(options = {}) {
    if (options.path !== undefined) this.path = resolveRunLogPath(options.path);
    if (options.maxEntries !== undefined) this.maxEntries = options.maxEntries;
    if (options.snapshotChars !== undefined) this.snapshotChars = options.snapshotChars;
  }

  /**
   * Serialize one run record to a single JSON line.
   *
   * **The record stores NO conversation text by default.** The original lives
   * in the session's own event log; `extra.ref` records how to locate it
   * (`sessionId` + the shadowed `seqs` + `compactionId`), so a reviewer reads
   * the source from the session instead of copying it here. `snapshotChars`
   * is the opt-in escape hatch: set it > 0 to embed a capped plaintext copy.
   *
   * @param input - the replayed conversation input (`{ messages }`), used ONLY
   *   when `snapshotChars > 0`.
   * @param result - the summarizer result (route/final digest/stats), or
   *   `undefined` for a FAILED run (see {@link appendFailure}).
   * @param extra - metadata (trigger, region stats, `ref`, `chunks`,
   *   `cooldowns`); for a failed run also `failed: true`, `error`, and
   *   `attempts`.
   * @returns the JSONL line (no trailing newline) and the snapshot text.
   */
  format(input, result, extra) {
    // Privacy default: no snapshot unless the operator opted in with a
    // positive character budget.
    const snapshot = this.snapshotChars > 0
      ? capSnapshot(
        (input?.messages ?? []).map((message) => {
          const text = message?.content;
          if (typeof text === 'string') return `${message.role ?? 'message'}: ${text}`;
          if (Array.isArray(text)) {
            return `${message.role ?? 'message'}: ${text.map((part) => (typeof part?.text === 'string' ? part.text : JSON.stringify(part))).join(' ')}`;
          }
          return `${message.role ?? 'message'}: ${JSON.stringify(text ?? '')}`;
        }).join('\n'),
        this.snapshotChars,
      )
      : '';
    const failed = extra?.failed === true;
    const record = {
      at: this.now(),
      trigger: extra?.trigger ?? 'unknown',
      regionChars: extra?.regionChars ?? 0,
      stage0Lines: extra?.stage0Lines ?? 0,
      chunkCount: extra?.chunkCount ?? 0,
      mergeLevels: extra?.mergeLevels ?? 0,
      mergeWindow: extra?.mergeWindow ?? 0,
      mergeUsableInput: extra?.mergeUsableInput ?? 0,
      regionTokens: extra?.regionTokens ?? 0,
      // A failed run has no route: the literal 'error' keeps the route field
      // total (JSONL consumers can branch on `route === 'error'`).
      route: failed ? 'error' : (result?.provider && result?.model ? `${result.provider}/${result.model}` : 'fallback'),
      fallback: result?.fallback === true,
      // WHY the fallback ran: 'no-merge-model' (no pool model can hold the
      // single-level merge), model failure/capacity (pool exhausted), or absent
      // (normal non-fallback path). Lets a user reading `fallback: true`
      // distinguish a broken model from a merge-window problem.
      fallbackReason: result?.fallbackReason ?? null,
      digestChars: result?.text?.length ?? 0,
      attempts: failed ? (extra?.attempts?.length ?? 0) : (result?.attempts?.length ?? 0),
      ...(failed ? {
        failed: true,
        // The flattened error chain — the answer to "why did compaction fail".
        error: extra?.error ?? null,
      } : {}),
      // --- attribution (v8) -------------------------------------------------
      // Which model handled which part of the region. Line ranges are Stage-0c
      // positions into the preprocessed line document — enough to answer
      // "who processed this span" without storing any of the text.
      ...(Array.isArray(extra?.chunks) && extra.chunks.length > 0
        ? { chunks: extra.chunks }
        : {}),
      // Every cooldown WRITE, in order: which route, on which job, with what
      // error, until when. This is the "which route went into cooldown and
      // why" trail — an aggregate count cannot tell a real provider error from
      // a mis-attributed one.
      ...(Array.isArray(extra?.cooldowns) && extra.cooldowns.length > 0
        ? { cooldowns: extra.cooldowns }
        : {}),
      // --- reference to the original conversation (v8: replaces the snapshot)
      // The run log stores NO conversation text by default. `ref` locates the
      // exact shadowed span in the session's own event log, so the original is
      // read back from the session (the only place it legitimately lives).
      ref: extra?.ref ?? null,
      snapshotChars: snapshot.length,
      ...(snapshot.length > 0 ? { snapshot } : {}),
      result: result?.text ?? '',
    };
    return { record, snapshot };
  }

  /** Append one run record durably (serialized; never throws to the caller). */
  append(input, result, extra) {
    this._pending += 1;
    const { record } = this.format(input, result, extra);
    const job = this.chain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, `${JSON.stringify(record)}\n`, { flag: 'a' });
      await this._trimIfNeeded();
    });
    // Decrement only when THIS write settles — success or failure. Counting on
    // the success path alone made `pending()` leak on I/O errors, so a caller
    // polling for "all queued writes done" waited forever.
    this.chain = job.then(() => undefined, () => undefined);
    void job.then(() => {
      this._pending -= 1;
    }, () => {
      this._pending -= 1;
    });
    return job;
  }

  /**
   * Record a FAILED run: same shape as a success record plus `failed: true`,
   * `route: 'error'`, and the flattened error reason in `error`. Failed runs
   * previously never reached the run log at all (only successes were appended
   * at the end of `summarize`), so the JSONL said nothing about why compaction
   * broke.
   *
   * @param input - the replayed conversation input (`{ messages }`).
   * @param error - the thrown value; flattened via {@link describeError}.
   * @param extra - metadata (trigger, region stats, `attempts` array).
   * @returns the same settled promise as {@link append}.
   */
  appendFailure(input, error, extra = {}) {
    return this.append(input, undefined, {
      ...extra,
      failed: true,
      error: describeError(error),
    });
  }

  /** Rewrite the file keeping only the most recent `maxEntries` lines. */
  async _trimIfNeeded() {
    const text = await readFile(this.path, 'utf8').catch(() => '');
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    if (lines.length <= this.maxEntries) return;
    const kept = lines.slice(-this.maxEntries);
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, `${kept.join('\n')}\n`);
    await rename(tmp, this.path);
  }

  /**
   * Read the most recent entries (newest first), for diagnostics and tests.
   * @param limit - maximum entries to return.
   * @returns the parsed records, newest first.
   */
  async recent(limit = 10) {
    const text = await readFile(this.path, 'utf8').catch(() => '');
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    const entries = lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter((entry) => entry !== null);
    return entries.slice(-limit).reverse();
  }

  /** Resolve after all queued writes settle (test/diagnostic helper). */
  async flush() {
    await this.chain;
  }

  /** Number of writes still queued (test/diagnostic helper). */
  pending() {
    return this._pending;
  }
}

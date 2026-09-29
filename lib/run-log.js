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

/** Defaults applied when config omits a field. */
export const DEFAULT_RUN_LOG = Object.freeze({
  enabled: false,
  maxEntries: 200,
  snapshotChars: 20000,
  path: undefined,
});

/**
 * Resolve the run-log file path: explicit config path wins; otherwise the
 * DSH storage root (`~/.dsh/storages` by default).
 *
 * @param path - explicitly configured path, or undefined.
 * @returns the absolute run-log file path.
 */
export function resolveRunLogPath(path) {
  if (typeof path === 'string' && path.length > 0) return path;
  return join(homedir(), '.dsh', 'storages', DEFAULT_RUN_LOG_FILE);
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
   * @param input - the replayed conversation input (`{ messages }`).
   * @param result - the summarizer result (route/final digest/stats).
   * @param extra - metadata (trigger, region stats).
   * @returns the JSONL line (no trailing newline) and the snapshot text.
   */
  format(input, result, extra) {
    const snapshot = capSnapshot(
      (input?.messages ?? []).map((message) => {
        const text = message?.content;
        if (typeof text === 'string') return `${message.role ?? 'message'}: ${text}`;
        if (Array.isArray(text)) {
          return `${message.role ?? 'message'}: ${text.map((part) => (typeof part?.text === 'string' ? part.text : JSON.stringify(part))).join(' ')}`;
        }
        return `${message.role ?? 'message'}: ${JSON.stringify(text ?? '')}`;
      }).join('\n'),
      this.snapshotChars,
    );
    const record = {
      at: this.now(),
      trigger: extra?.trigger ?? 'unknown',
      regionChars: extra?.regionChars ?? 0,
      stage0Lines: extra?.stage0Lines ?? 0,
      chunkCount: extra?.chunkCount ?? 0,
      chunkBudget: extra?.chunkBudget ?? 0,
      overlapTokens: extra?.overlapTokens ?? 0,
      contextWindow: extra?.contextWindow ?? 0,
      outputBudget: extra?.outputBudget ?? 0,
      usableInput: extra?.usableInput ?? 0,
      route: result?.provider && result?.model ? `${result.provider}/${result.model}` : 'fallback',
      fallback: result?.fallback === true,
      digestChars: result?.text?.length ?? 0,
      attempts: result?.attempts?.length ?? 0,
      snapshotChars: snapshot.length,
      snapshot,
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
    this.chain = job.then(() => undefined, () => undefined);
    return job;
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

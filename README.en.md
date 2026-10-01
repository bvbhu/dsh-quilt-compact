# dsh-quilt-compact

A context-compaction plugin for the DeepSeek Harness.

It replaces the default `compaction-basic`: **compress conversation content with
cheap/free small models to save cost**. Some models have short context windows
that cannot hold a whole conversation, so it uses chunking with a single merge:
chunks are summarized one by one by small models, then all digests are merged
**in one call** into the final result.

- Configurable multi-tier models (different specs per tier), auto-selected and
  auto-degraded by capacity.
- A failed model call is cooled for a while; when the pool cannot finish the
  current job, the session model takes over.
- Chunking, summarizing, and merging run automatically, producing one small but
  complete checkpoint.

## How it works

One compaction run follows this pipeline:

```
Stage 0 → (pick model → slice → summarize) × N → single merge → Checkpoint
```

1. **Stage 0** — preprocess the region to be compacted: flatten into line
   documents, merge adjacent duplicate lines, collapse runs of blank lines,
   strip terminal noise (ANSI escapes, cursor markers, long separators), keep
   file/image attachment names instead of anonymizing them to bare markers;
   optionally skeletonize code (keep structural lines by indentation depth) and
   condense logs.
2. **Pick model → slice** — each round picks one available model and **slices a
   chunk sized to that model's contextWindow**. Each chunk also carries a digest
   size cap `cap_i` (allocated proportionally to its share of the region's total
   length), so the final merge never exceeds the context limit.
3. **Summarize** — each chunk is summarized into a small digest by one model call
   through the pool (at most `cap_i`).
4. **Single merge** — all digests are consolidated into the final checkpoint in
   **one call**. The merge window is controlled by `mergeMaxContextTokens` (how
   much context to keep at most before merging, default 128k).
5. **Checkpoint** — the final digest replaces the region in the session.

## Supported version

**Only verified on DSH `0.1.7-rc.1`**, peer dependency declared `>=0.1.7-alpha.2`.

## Install

Install directly from the GitHub repository:

```sh
dsh plugin --profile <name> add github:bvbhu/dsh-quilt-compact
```

The package declares `dsh.bundle`, so the install command activates the shipped
layer and **disables `compaction-basic`** (this plugin becomes `ctx.compaction`).
Pin a commit with a `#<sha>` suffix rather than following the default branch:

```sh
dsh plugin --profile <name> add github:bvbhu/dsh-quilt-compact#<sha>
```

## Update

```sh
dsh plugin --profile <name> update dsh-quilt-compact
```

## Uninstall

```sh
dsh plugin --profile <name> remove dsh-quilt-compact
```

Then re-enable `compaction-basic` in the profile layer to restore the default
backend.

## Configuration

Two equivalent ways: the Web UI **settings page** (writes to the same profile
patch), or editing the profile's `cordis.patch.yml` directly (later layers win
row by row).

### Model pool

```yaml
- id: dsh-quilt-compact
  config:
    tiers:
      - name: primary
        models:
          - provider: openrouter
            model: openrouter/free
            maxConcurrent: 1
            cooldownHours: 1
```

`cooldownHours` is the number of hours a route stays cooled after a failure
(positive, decimals allowed, e.g. `0.5` = 30 minutes), measured from the
failure moment. Default 1 hour. `maxConcurrent` defaults to 1.

### Merge window (optional)

How much context to keep at most before merging is controlled by
`mergeMaxContextTokens` (token count, default 128k); at merge time it **descends
tiers** in the pool to find a model with enough context.

```yaml
    mergeMaxContextTokens: 64000   # max context to keep before merging (merge window), default 128000
```

**Note**: the 128k default means that if the main pool has no model ≥ 128k, the
merge may fail with no model available.

### Chunking

```yaml
    chunkRatio: 0.8        # fraction of a model's usable input one chunk may use
    chunkOverlapRatio: 0.1 # adjacent-chunk overlap as a fraction of the chunk budget
```

### Stage 0

```yaml
    preprocessing:
      dedup: true                              # merge adjacent duplicate lines
      purgeErrors: true                        # strip terminal noise (ANSI, cursor markers, long separators)
      astSkeleton: { enabled: false, maxDepth: 2 }  # skeletonize code by indentation depth; opt-in, off by default
      logCondense: { mode: balanced, maxLines: 200 }  # condense long logs
```

### Run log

Optional quality-review / diagnostics logging, **off by default**:

```yaml
    runRecord:
      enabled: false      # no run records are produced while off
      maxEntries: 200     # max lines kept (file is trimmed to the newest N)
      snapshotChars: 0    # >0 embeds a capped copy of the region (default 0 = no conversation text)
      path: ''            # fixed file location; empty uses the DSH storage root
```

When enabled, each compaction appends one JSON line to
`<DSH home>/storages/dsh_quilt_compact_runs.jsonl` (a non-empty `$DSH_HOME`
wins, otherwise `~/.dsh`; `path` overrides). Each line carries stats
(`trigger`, `regionChars`, `chunkCount`, `mergeLevels`, etc.) and `result` (the
final digest text).

**No conversation text is stored by default** — the record references it instead
of copying it:

- `ref` — `{ sessionId, seqs }`: points to where the compacted span lives in the
  session's own event log; read the original back from the session by seq (the
  session is the only legitimate place the original lives).
- `chunks` — per-chunk model attribution `{ chunk, model, lineStart, lineEnd,
  tokens }`, answering "which model handled which span" without any text.
- `cooldowns` — **every cooldown write with its error** `{ model, job, error,
  until, hours }`: which route, on which job, with what error, cooled until when
  — the first-hand evidence for "why did this route fail" (an aggregate attempt
  count cannot distinguish a real provider error from a mis-attributed one).
- `snapshotChars` > 0 opts into embedding a capped copy of the original (privacy
  opt-in).

### Failure diagnostics

A failed compaction no longer leaves only a fixed one-liner:

- **Error-level log** — when summarize fails, one line
  `dsh-quilt-compact summarize failed (trigger=…): <reason>` is emitted, where
  the reason is the flattened error chain (top: middle: root), including the
  per-route attempt summary of a collapsed batch
  (`attempts: p1/m1 x1 (last: …); …`).
- **Transaction-layer failures are logged too** — the shrink check, commit,
  persistence, and other failures that happen after `summarize()` returns now
  emit `dsh-quilt-compact compaction failed (trigger=…, stage=…): <reason>`; a
  failure that crosses layers is still logged exactly once.
- **Failures land in the run log too** — with runRecord enabled, a failure writes
  `failed: true`, `route: 'error'`, `error` (flattened reason), shaped like a
  success record; success ratios and failure causes can be aggregated straight
  over the JSONL.
- **Actionable fallback errors** — the "no pool route can hold the merge" error
  lists `mergeWindow`, every route's window and cooldown state, and the two ways
  out (lower `mergeMaxContextTokens`, or add a larger-window model).
- **Manual `/compact`** — the `ManualCompactionError` message carries the
  underlying reason (shown by the `compaction/end` session event and this
  plugin's logs); automatic compaction failures (step pressure, context
  overflow) carry the flattened reason in their warn lines too.

The host's `/compact` command prints one fixed sentence per error code and
discards `error.message`; the real reason is always findable in this plugin's
error-level log (and the JSONL when runRecord is enabled) — no need to modify
the host package.

## Scheduling & fallback

- **Model-driven slicing** — each round picks a model (round-robin fairness
  within the tier) and slices a chunk sized to that model's own contextWindow
  before dispatching — a chunk is always as large as the model handling it can
  hold, so a "model cannot hold the context" path does not exist in the normal
  flow.
- **Default capacity** — when a model's capacity (contextWindow/maxTokens) cannot
  be resolved, the defaults 256k / 32k are used for capacity matching instead of
  treating the route as unbounded.
- **Cooldown** — a failed model call is cooled for the configured hours (default
  1 hour, measured from the failure) and is not selected during it.
- **Whole-pool recovery** — if EVERY route is cooled (a network blip that failed
  every provider at once), the slicing stage **clears all cooldowns and retries
  once** instead of parking until the earliest route expires. A cooldown is a
  heuristic for "stop hammering a failing provider", not a contract: when nothing
  in the pool can work it has outlived its purpose. A route that fails again is
  re-cooled normally.
- **Failure retry** — after a failure, the model is cooled; on requeue the
  scheduler **prefers a same-tier healthy model with a larger contextWindow**
  (enough context first); only when no same-tier model fits is the chunk re-split
  smaller, then the job degrades to the next tier.
- **Degradation** — when the current tier has no usable model, the job degrades
  to the next tier.
- **Session fallback** — when the model pool cannot complete the job (e.g. all
  tiers cooled, or no model in the pool can hold all digests at merge time), the
  session model compresses the whole region directly (calls `dsh-compaction-basic`,
  disable with `fallbackToSessionModel: false`). When the fallback fires because
  the pool has no healthy model with a large enough window for the merge, the
  record carries `fallbackReason: no-merge-model` to distinguish it from model
  failure.
- **Fallback all the way down** — when not even one chunk can be sliced (the
  whole pool is cooled and the reset retry did not help), the region is handed to
  the default compression plugin instead of throwing — the compaction still
  completes rather than leaving only the host's fixed sentence. The log marks this
  path with `model pool cannot serve this compaction (…)`.

## Privacy

**Nothing is recorded by default**: the default persisted state exists only to
track route cooldown times — no session messages, prompts, or digests.

**When runRecord is enabled**: each compaction (successful or failed) writes one
JSONL run record — **still no conversation text by default**: it stores `ref`
(session + seq reference), per-chunk model attribution, and cooldown errors; read
the original back from the session via the reference when needed. Only setting
`snapshotChars` to a positive number embeds a capped copy of the conversation —
**that opt-in is the deliberate privacy boundary**.

## Known limitations

- Only DSH `0.1.7-rc.1` has been verified; compatibility with other versions has
  not been tested.
- On web/desktop profiles the model pool is the copy inside `preset-standard`:
  edits through the Web UI settings page are written uniformly by the plugin
  bridge, so nothing extra is needed there; only when editing `cordis.patch.yml`
  or the preset restate by hand must the two copies stay consistent (or re-run the
  generator), or they drift apart.
- Benchmark episodes/probes carry author-provided ground truth, **not** real user
  session data; real-agent task-success after compaction is not yet covered by the
  benchmark.
- The real-model validation lane is noisy and rate-limited, so it only reports
  results and does not gate CI.

## Benchmark / validation

`test/bench/` provides two lanes:

- **Deterministic lane (CI)** — `npm test`: scripted summarizer personas
  (`perfect` / `leak` / `forgetful`), stable across machines; regression
  thresholds reference `test/bench/baseline.json` with tolerance, and every
  dispatched request is asserted to satisfy `input + maxTokens <= contextWindow`.
- **Real-model lane (periodic / release)** — `npm run bench -- --real`: runs the
  same pipeline against a live `ctx.llm`; results are **reported only, no
  threshold**.

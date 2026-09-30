# dsh-quilt-compact

A context-compaction plugin for the DeepSeek Harness.

It replaces the default `compaction` backend: **compressing conversation
content with cheap/free models to save cost**. Because some models have short
context windows that cannot hold a long conversation, it uses chunking with a
single merge: **each round picks a model and slices a chunk sized to that
model's own window**, each chunk is summarized by an inexpensive small model,
and all digests are merged in **one final call** into a checkpoint (`N → 1`).
Chunking and merging are a way to work around short context windows, not a
goal in itself.

- Configurable model tiers (different sizes per tier), auto-selected and
  degraded by capacity.
- A model that fails is cooled for a while; when the model pool cannot
  complete the current job, the session model takes over.
- Chunking, summarizing, and merging run automatically, producing one small
  but complete checkpoint.

## How it works

One compaction run follows this pipeline:

```
Stage 0 → (pick model → slice → summarize) × N → single merge → Checkpoint
```

1. **Stage 0** — preprocess the region: flatten into line documents, merge
   adjacent duplicate lines, collapse runs of blank lines, strip terminal
   noise (ANSI escapes, cursor markers, long separators), keep file/image
   attachment names instead of anonymizing them to bare markers; optionally
   skeletonize code blocks (keep structural lines by indentation depth) and
   condense overly long logs.
2. **Pick model → slice** — each round picks a healthy, idle model and slices
   a chunk **sized to that model's own contextWindow** (overlapping, cuts
   aligned to whole lines), so a "model cannot hold the context" problem is
   eliminated by construction. Each chunk also carries a digest size cap
   `cap_i` (allocated proportionally to its share of the region), so all
   digests together fit the single merge call.
3. **Summarize** — each chunk is summarized into a small digest by one model
   call through the pool (at most `cap_i`).
4. **Single merge** — all digests are consolidated in **one call** (`N → 1`),
   no multi-level merge. The merge window is controlled by the config option
   `mergeMaxContextTokens` (how much context to keep at most before merging);
   when unset it defaults to `max(128k, smallest known window in the pool)`.
   There is NO dedicated merge pool: the merge reuses the main `tiers` and
   **descends tiers** to find a route with enough context; if none can hold it
   after the descent, the session model takes over directly.
5. **Checkpoint** — the final digest replaces the region in the session.

## Supported DSH version

The peer dependencies declare only a **known-incompatible lower bound**:
`>=0.1.7-alpha.2`. The bound comes from the code's actual deep import
`@deepseek-ai/dsh-token-meter/estimate` — the `estimate` subpath exists only
from `0.1.7-alpha.2` onward, so earlier versions fail at module load. There
is **no upper bound**: `0.2.x` and later are unverified, and whether they
work is for the user to test.

**Only DSH `0.1.7-rc.1` has actually been tested** (the dev dependencies are
pinned to it); other versions above the bound are allowed on a compatibility
assumption, not verified per version.

## Install

Install directly from the GitHub repository (no npm publish needed):

```sh
dsh plugin --profile <name> add github:bvbhu/dsh-quilt-compact
```

The package declares `dsh.bundle`, so the command activates the shipped layer
and **disables `compaction-basic`** (this plugin becomes `ctx.compaction`).
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
patch) or editing the profile's `cordis.patch.yml` directly (later layers win
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
            cooldown: { mode: dailyReset, hour: 0 }
```

`cooldown` is one of: `duration` (positive hours, decimals allowed) or
`dailyReset` (integer UTC hour 0–23). `maxConcurrent` defaults to 1.

### Merge window (optional)

There is **no dedicated merge pool** (no `mergeTiers`): the single-level merge
reuses the main `tiers` and **descends tiers** to find a route with enough
context — chunking stays on cheap small models, and the merge automatically
lands on a large-window route that can hold all digests. How much context to
keep at most before merging is controlled by `mergeMaxContextTokens` (tokens):

```yaml
    mergeMaxContextTokens: 64000   # max context tokens retained before the merge
```

When set, the merge window is **exactly that value** (no 128k floor, no
pool-derived min); when unset it defaults to `max(128k, smallest known window
in the pool)`. **Note**: the default has a 128k floor — if no pool model
reaches 128k (e.g. the whole pool is 8k models), every multi-chunk compaction
falls straight back to the session model; set `mergeMaxContextTokens` to a size
the pool models can hold (e.g. 8000) and the single-level merge actually runs.

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
      astSkeleton: { enabled: true, maxDepth: 2 }  # skeletonize code: keep structural lines by indentation depth
      logCondense: { mode: balanced, maxLines: 200 }  # condense long logs
```

### Run log

Optional quality-review logging, **off by default**:

```yaml
    runRecord:
      enabled: false       # no run records are produced while off
      maxEntries: 200      # max lines kept (file is trimmed to the newest N)
      snapshotChars: 20000 # per-run character budget for the replayed prefix (0 = all)
      path: ''             # fixed file location; empty uses the DSH storage root
```

When enabled, each compaction appends one JSON line to
`<DSH home>/storages/dsh_quilt_compact_runs.jsonl` (a non-empty `$DSH_HOME`
wins, otherwise `~/.dsh`; `path` overrides). Each line carries stats
(`trigger`, `regionChars`, `chunkCount`, `mergeLevels`, …), `snapshot` (the
replayed session prefix, capped to `snapshotChars`) and `result` (the final
digest text).

## Scheduling & fallback

- **Model-driven slicing** — each round picks a model (round-robin fairness
  within the tier) and slices a chunk sized to that model's own contextWindow
  before dispatching — a chunk is always as large as the model handling it
  can hold, so a "model cannot hold the context" path does not exist in the
  normal flow.
- **Default capacity** — when a model's capacity (contextWindow/maxTokens)
  cannot be resolved, the defaults 256k / 32k are used for capacity matching
  instead of treating the route as unbounded.
- **Cooldown** — a model that fails is cooled for the configured time and is
  not selected during it.
- **Failure retry** — after a failure, the model is cooled; on requeue the
  scheduler **prefers a same-tier healthy model with a larger contextWindow**
  (enough context first); only when no same-tier model fits is the chunk
  re-split smaller, then the job degrades to the next tier.
- **Degradation** — when the current tier has no usable model, the job
  degrades to the next tier.
- **Session fallback** — when the model pool cannot complete the job (all
  tiers cooled, or no pool model can hold all digests at merge time), the
  session model compresses the whole region directly (disable with
  `fallbackToSessionModel: false`). When the fallback fires because no pool
  model has a large enough window for the merge, the record carries
  `fallbackReason: no-merge-model` to distinguish it from model failure.

## Privacy

**Nothing is recorded by default**: the default persisted state exists only
to track route cooldown times — no session messages, prompts, or digests.

**When runRecord is enabled**: each compaction writes `snapshot` (the replayed
session prefix) and `result` (the final digest) into the JSONL run log — this
**does save conversation content**. That is the deliberate privacy boundary:
because the log contains content, it is off by default; enable it only when
you genuinely need to review later what was compacted and what came out.

## Known limitations

- Only DSH `0.1.7-rc.1` has actually been verified; the peer range declares
  only the lower bound `>=0.1.7-alpha.2`, other versions above it are not
  tested per version, and whether `0.2.x` or later works is left to the user
  to test.
- On web/desktop profiles the model pool is the copy inside
  `preset-standard`: edits through the Web UI settings page are written
  uniformly by the plugin bridge, so nothing extra is needed there; only when
  editing `cordis.patch.yml` or the preset restate by hand must the two copies
  stay consistent (or re-run the generator), or they drift apart.
- Benchmark episodes/probes carry author-provided ground truth, **not** real
  user session data; real-agent task-success after compaction is not yet
  covered by the benchmark.
- The real-model validation lane reports results only and is not a CI gate,
  because real models are noisy and rate-limited.

## Benchmark / validation

`test/bench/` provides two lanes:

- **Deterministic lane (CI)** — `npm test`: scripted summarizer personas
  (`perfect` / `leak` / `forgetful`), stable across machines; regression
  thresholds reference `test/bench/baseline.json` with tolerance, and every
  dispatched request is asserted to satisfy `input + maxTokens <= contextWindow`.
- **Real-model lane (periodic / release)** — `npm run bench -- --real`: runs
  the same pipeline against a live `ctx.llm`; results are **reported, not
  gated**.

Plus e2e tests (real session transaction paths), smoke tests (patch
composition / container mount / config delivery / pool validation / web
render) and the benchmark quality-regression suite.
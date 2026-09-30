# dsh-quilt-compact

A context-compaction plugin for the DeepSeek Harness.

It replaces the default `compaction` backend: **compresses long context with
cheap, small models, chunk by chunk** — the conversation is split into small
chunks, each is summarized by an inexpensive small model, and the digests are
merged back into one checkpoint, instead of feeding the entire context to an
expensive large model in a single call.

- Configurable model tiers (different sizes per tier), auto-selected and
  degraded by capacity.
- A model that fails is cooled for a while; when the model pool cannot
  complete the current job, the session model takes over.
- Chunking, summarizing, and merging run automatically, producing one small
  but complete checkpoint.

## How it works

One compaction run follows this pipeline:

```
Stage 0 → Chunk → Summarize → Hierarchical Merge → Checkpoint
```

1. **Stage 0** — preprocess the region: flatten into line documents, merge
   adjacent duplicate lines, strip terminal noise (ANSI escapes etc.), keep
   file/image attachment names instead of anonymizing them to bare markers;
   AST-skeletonize overly deep code blocks and condense overly long logs.
2. **Chunk** — split the region into overlapping chunks that fit a model's
   usable input budget (cuts aligned to whole lines).
3. **Summarize** — each chunk is summarized into a small digest by one model
   call through the pool.
4. **Hierarchical Merge** — digests are grouped by capacity budget and merged
   level by level until one final digest remains (`N → N/k → … → 1`), instead
   of pasting every digest into one oversized request.
5. **Checkpoint** — the final digest replaces the region in the session.

## Supported DSH version

The peer dependencies accept the whole DSH `0.1.x` series
(`>=0.1.7-rc.1 <0.2.0-0`) — the DSH main package and every `dsh-*` subpackage
release in lockstep (`0.1.0-rc` → `0.1.1-rc` → … → `0.1.7-rc` → `0.2.0-rc`),
so rc patch releases within the same series are treated as compatible. The
upper bound `<0.2.0-0` excludes `0.2.0` and all of its rc prereleases.

**But only DSH `0.1.7-rc.1` has actually been tested** (the dev dependencies
are pinned to it); other `0.1.x` versions are allowed by the range on a
compatibility assumption, not verified per version. `0.2.0` is not allowed:
a minor upgrade may carry breaking changes and needs the compatibility checks
re-run before it is opened up.

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

### Chunking

```yaml
    chunkRatio: 0.8        # fraction of a model's usable input one chunk may use
    chunkOverlapRatio: 0.1 # adjacent-chunk overlap as a fraction of the chunk budget
```

### Stage 0

```yaml
    preprocessing:
      dedup: true                              # merge adjacent duplicate lines
      purgeErrors: true                        # strip terminal noise / error output
      astSkeleton: { enabled: true, maxDepth: 2 }  # skeletonize deep code blocks
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

- **Capacity selection** — the scheduler picks models by known `contextWindow`;
  a model that cannot hold the current job is skipped (a scheduling
  constraint, not a failure: no cooldown, no failure count).
- **Cooldown** — a model that fails is cooled for the configured time and is
  not selected during it.
- **Degradation** — when the current tier has no usable model, the job
  degrades to the next tier.
- **Session fallback** — when the model pool cannot complete the job (all
  tiers cooled, or no model can hold the real request), the session model
  compresses the whole region directly (disable with
  `fallbackToSessionModel: false`). When the fallback fires because a digest
  level cannot legally shrink, the record carries
  `fallbackReason: unmergeable-merge-level` to distinguish it from model
  failure.

## Privacy

**Nothing is recorded by default**: the state file holds only route cooldown
timestamps — no session messages, prompts, or digests.

**When runRecord is enabled**: each compaction writes `snapshot` (the replayed
session prefix) and `result` (the final digest) into the JSONL run log — this
**does save conversation content**. That is the deliberate privacy boundary:
because the log contains content, it is off by default; enable it only when
you genuinely need to review later what was compacted and what came out.

## Known limitations

- Only DSH `0.1.7-rc.1` has actually been verified; the peer range allows the
  whole `0.1.x` series on a compatibility assumption, other versions are not
  tested per version, and `0.2.0` or later needs the compatibility checks
  re-run before it is opened up.
- On web/desktop profiles the model pool is the copy inside
  `preset-standard`: editing the pool requires updating both the host row and
  the preset restate (or re-running the generator), or the two drift apart.
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
# compaction-chain (dsh-quilt-compact)

Tiered model-pool summarization backend for the DeepSeek Harness — the
`compaction` service replacement for `dsh-compaction-basic` described in
[design v3](docs/design-v3.md).

The plugin summarizes a compaction region by running Stage 0 preprocessing,
splitting it into overlapping chunks, summarizing every chunk through a
configured pool of models (tiers, per-model concurrency and cooldown), and
merging the digests back into one checkpoint. Model failures cool that model
for a configured duration / daily-reset window; a tier whose models are all
cooled degrades to the next tier; when every tier is cooled, the session model
takes over (configurable) or the compaction fails into the built-in
`compaction/summary-error` recovery.

> This package is developed standalone and has **not** been installed into any
> DSH profile. Activate it only when you are ready (see [Activation](#activation)).

## Table of contents

- [Design mapping and deviations](#design-mapping-and-deviations)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Persistence](#persistence)
- [Privacy](#privacy)
- [Package layout](#package-layout)
- [Development / tests](#development--tests)
- [Activation](#activation)

## Design mapping and deviations

The implementation follows `docs/design-v3.md`; deliberate deviations (all
forced by the harness contracts) are marked `*DEVIATION*`:

| Design v3 | Implementation |
|---|---|
| No proactive rate-limit judgment; DSH retryPolicy failure → cooldown | Direct `ctx.llm.stream()` calls are single-attempt (DSH's `retryPolicy` executor acts only on agent-loop request failures — `dsh-llm-retry`). A chunk-call failure **is** the exhaustion boundary: it writes the model's cooldown and requeues the chunk on another model. `*DEVIATION*`: nothing to configure; the plugin adds no retry parameters. |
| Persistence via `ctx.storage.domain` | `compaction_chain_state` domain (`routes` table) via the `json` backend. `*DEVIATION*`: `UNIT_NAME_RE` forbids hyphens, so the domain is `compaction_chain_state` (not `compaction-chain-state`). |
| Global `{ schemaVersion: 1 }` nullable | `*DEVIATION*`: `defineDomain` rejects global schemas that accept `null` (null is the "never written" sentinel), so the global is `{ schema: { schemaVersion: 1 }, initial: { schemaVersion: 1 } }`. It materializes on first write; until then the medium stores the null sentinel and reads serve `initial`. |
| `tables.routes = z.record(z.string(), …)` | `*DEVIATION*`: tables are declared per record with `domainTable(z.object({ cooldownUntil }))`; keys are plain strings on the medium. |
| Chunk cap / maxTokens removed from config | Per-call generation cap is a built-in constant `BUILTIN_MAX_TOKENS = 4096` (not configurable), so the framed checkpoint cannot silently balloon past the shrink check. |
| All chunks dispatched at once; `maxConcurrent` is per-model | Implemented in `ModelChain`; healthy-but-busy tiers make a chunk wait for a released slot or a cooldown expiry; a tier with no healthy model degrades the chunk to the next tier (per-job progression; a batch whose tier is fully cooled observably skips it, matching "整体降级"). |
| Merge runs through the ModelChain | Implemented. `*DEVIATION*`: single-chunk regions skip the merge call (no overlaps to deduplicate) and use the chunk digest directly, so a single-chunk compaction completes in one call ("一次完成"). |
| 会话模型兜底 (fallback) | **Directly calls the default compression plugin** (`dsh-compaction-basic`'s `summarize`, added as a peer dependency): it replays the ORIGINAL region input (system + region messages, unchanged) and appends its compaction instruction as the final user message — the default KV-cache-reusing compression. One call covers the whole region; when a single chunk would have sufficed, that call IS the one-pass completion. The fallback bypasses Stage 0/chunking (the prefix must stay unchanged for cache identity). The default plugin is instantiated on a throwaway context (`auto: false`) and redirected to the live `llm`, so its `compaction` service registration can never shadow ours (`lib/default-compression.js`). |
| Automatic pressure policy | Design removed thresholds from config; the engine keeps the compaction-basic behavior with built-in constants (threshold 0.8 of the routed context window, retain 0.16, headroom 65536, 1 retry / 1 overflow retry). Tune by editing `engine.js` constants until config is re-added. |
| Stage 0 algorithms embedded (no dsh-dcp/dshx/dsh-context-lens) | All in `lib/stage0/*`, pure line transforms, unit-tested. |
| 冷却两种模式 | `duration` (hours, decimals OK) and `dailyReset` (fixed UTC hour) — exact math in `lib/cooldown.js`. |

## How it works

One compaction run (whatever the trigger: step pressure, context overflow,
manual `compactNow`, or `compactRegion`) produces a durable transaction:

```
compaction/start → summarize → compaction/summary → user/message (replace) → compaction/end
```

The summarizer itself:

1. **0a** — flatten the region messages to a line document, dedup consecutive
   lines, purge terminal noise (ANSI escapes, cursor markers, long separator
   runs), head-middle-tail trim, skip blank blocks.
2. **0b** — AST-skeletonize fenced code blocks beyond `maxDepth: 2`, and
   condense log runs longer than `maxLines` with a `[condensed: N lines removed]`
   marker.
3. **0c** — overlapping chunks: core budget `contextWindow × chunkRatio`
   (window resolved from the pool's primary model, 32768 fallback), overlap
   `core × chunkOverlapRatio`, cuts aligned to whole lines (preferring
   sentence-ending lines). Chunking is pure computation.
4. **ModelChain** — all chunk jobs enter one dispatch queue; each job picks a
   healthy model with a free slot in its current tier (round-robin), degrades
   through tiers while a tier has no healthy model, and on failure cools the
   model and requeues. When every tier is cooled, the batch collapses to the
   session-model fallback: a **direct call to the default compression plugin**
   (`dsh-compaction-basic`'s `summarize`), which replays the original
   conversation prefix and appends its compaction instruction as the final
   user message — the default cache-reusing compression, one call over the
   whole region (one pass when a single chunk suffices). With the fallback
   disabled the batch throws, surfacing through the region's
   `compaction/summary-error` recovery waterfall.
5. **Merge** — chunk digests go through the ModelChain again with the merge
   instruction, producing the final checkpoint, which is framed
   (`<compacted-summary>` tags, same preamble as `dsh-compaction-basic`) and
   must pass the built-in check *summary < shadowed region* before commit.

Cancellation is not a model failure: an aborted signal propagates immediately
and never writes cooldowns.

## Configuration

```yaml
- id: compaction-basic
  disabled: true
- insert:
    - id: compaction-chain
      name: 'dsh-quilt-compact'   # must match the installed package name
      config:
        chunkRatio: 0.8              # chunkTokens = context window × chunkRatio
        chunkOverlapRatio: 0.1       # overlap between adjacent chunks
        fallbackToSessionModel: true # session-model fallback (requestHeader().config ?? agent.options)
        chunkPromptSuffix: ''        # optional, appended to the chunk prompt
        mergePromptSuffix: ''        # optional, appended to the merge prompt

        tiers:
          - name: primary
            models:
              - provider: openrouter
                model: openrouter/free
                maxConcurrent: 1
                cooldown: { mode: dailyReset, hour: 0 }
              - provider: sensenova-1
                model: sensenova-6.8-flash-lite
                maxConcurrent: 1
                cooldown: { mode: duration, hours: 5 }
              - provider: sensenova-1
                model: deepseek-v4-flash
                maxConcurrent: 1
                cooldown: { mode: duration, hours: 5 }
              - provider: trae
                model: deepseek-v4.1-flash
                maxConcurrent: 1
                cooldown: { mode: duration, hours: 5 }
          - name: fallback
            models:
              - provider: workbuddy
                model: glm-5.3-flash
                maxConcurrent: 1
                cooldown: { mode: dailyReset, hour: 8 }
              - provider: workbuddy
                model: hy3
                maxConcurrent: 1
                cooldown: { mode: dailyReset, hour: 8 }

        # Request retries are entirely DSH's retryPolicy; nothing to configure here.

        preprocessing:
          dedup: true
          purgeErrors: true
          headMiddleTail: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
          astSkeleton: { enabled: true, maxDepth: 2 }
          logCondense: { mode: balanced, maxLines: 200 }
```

`maxConcurrent` defaults to 1. `cooldown` is required and exactly one mode:
`duration` (positive `hours`, decimals supported) or `dailyReset` (integer
`hour` 0–23 UTC). Route keys are `${provider}/${model}` and must be unique
across the whole pool. Unknown keys, duplicate routes, and invalid cooldowns
fail loud at plugin load.

## Persistence

Cooldown state lives in the `compaction_chain_state` domain routed to the
`json` backend. The harness must mount `storage-domain` + `storage-json` with
the root under the DSH home (e.g. `root: ~/.dsh/storage`), e.g.:

```yaml
- name: '@deepseek-ai/dsh-storage-json'
  config:
    root: '~/.dsh/storage'
- name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
```

State file: `<root>/compaction_chain_state.json` (single layout) — one
`routes` table of `{ "provider/model": { "cooldownUntil": <epoch ms> } }`
plus the optional global. Writes are zod-validated and atomically published;
only cooldown *transitions* hit the disk (write throttling); expiry is lazily
cleaned on read (never written back). If the storage-domain form is missing or
its open fails, the engine degrades to an in-memory store with a logged
warning (no persistence across restarts).

## Privacy

The state file contains **only** route cooldown timestamps. No session
messages, prompts, or digests ever cross the domain.

## Observability (logs)

Every model call is traceable end to end; log lines are structured key=value
strings so they stay greppable:

- `debug compaction-chain call: …` — per call, before dispatch:
  - `job=chunk N | merge | fallback` and `route=provider/model`
  - `defaultPlugin=true` on the fallback line marks the DIRECT call to
    `dsh-compaction-basic` (the default compression plugin); the fallback then
    records `outputChars`/`outputTokens`/`durationMs` on that same line.
  - input segment identification: `inputChars`, `inputTokens~` (heuristic),
    `lines=A..B` (the Stage 0c line range for chunk jobs),
    `requestChars` (full request envelope incl. instruction), `sha=…`
    (first 12 hex of the input's SHA-256), and `preview="…"` (first 80 chars,
    single line).
- `debug compaction-chain call ok: …` — per successful call:
  `outputChars`, `outputTokens` (provider usage when reported), `durationMs`.
- `warn compaction-chain: route … failed … job=… sha=…; cooling until …` —
  cooldown write events (design §2.4: logged, never the state file).
- `info compaction-chain summarize: …` — region stats before chunking:
  `regionChars`, `stage0Lines`, `chunks`, `chunkBudget`, `overlapTokens`,
  `contextWindow`.
- `info compaction-chain summarize done: …` — final route, `fallback`,
  `digestChars`, `attempts`.
- `info compaction-chain batch: …` — per pool batch: `jobs`, `calls`,
  `byRoute=p1/m1:N,…`, `failures`, `fallback`, `durationMs`.

Privacy boundary: logs carry **stats, fingerprints, and ≤80-char previews
only** — never full session messages, prompts, or digests.

## Package layout

```
lib/
  index.js            exports: default CompactionChainEngine, Config, spec, helpers
  engine.js           CompactionChainEngine: summarize, compactIfNeeded/Now/Region,
                      automatic wiring, store bootstrap, fallback delegate wiring
  default-compression.js  direct facade over dsh-compaction-basic's summarize
  config.js           schemastery Config + resolveConfig (validation/defaults)
  spec.js             compaction_chain_state domain spec, routeKey
  cooldown.js         computeCooldownUntil, Domain/Memory stores
  model-chain.js      tier scheduler: slots, cooldown, degradation, fallback
  summarize.js        built-in prompts, one-shot stream call, checkpoint framing
  region.js           durable compaction transaction + shrink check + recovery
  stage0/             text extraction, trims, semantic compression, chunking
test/
  unit/               cooldown, config, stage0, model-chain
  e2e/                full transaction on real sessions; real json persistence
```

## Development / tests

```sh
npm install --cache ./.npm-cache   # test deps (never touches any DSH profile)
node test/unit/cooldown.test.js    # run any file directly; node:test runs in-process
```

`node --test test/` needs child-process spawning, which the sandbox used for
this project denies; run files individually (or outside the sandbox) instead.
The fake-LLM end-to-end suite simulates retryPolicy-exhausted failures →
cooldown writes → tier degradation → session-model fallback (design checklist
item 8), and the persistence suite exercises the real json backend + reopen.

## Activation

The package is **not** installed into any DSH profile. To activate later:

1. Install the package into the profile (`dsh plugin add` or a pnpm profile
   add), or copy `lib/` into a loadable plugin directory.
2. Mount `storage-json` + `storage-domain` (see [Persistence](#persistence)).
3. Add the `insert:` entry above (with the real installed package name) and
   disable `compaction-basic` as a *service entry* — the package itself must
   stay installed, because the fallback imports its `summarize` directly
   (peer dependency `@deepseek-ai/dsh-compaction-basic`; it ships with DSH by
   default).

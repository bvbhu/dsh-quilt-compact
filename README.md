# dsh-quilt-compact

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

This package ships as a DSH **bundle**: its `package.json` declares
`dsh.bundle.patch`, so `dsh plugin add` activates the shipped
[`cordis.patch.yml`](cordis.patch.yml) layer automatically.

## Table of contents

- [Design mapping and deviations](#design-mapping-and-deviations)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Persistence](#persistence)
- [Privacy](#privacy)
- [Package layout](#package-layout)
- [Development / tests](#development--tests)
- [Activation](#activation)
- [Uninstalling](#uninstalling)
- [Compatibility checks](#compatibility-checks)
- [Review against the official plugin guide](#review-against-the-official-plugin-guide)

## Design mapping and deviations

The implementation follows `docs/design-v3.md`; deliberate deviations (all
forced by the harness contracts) are marked `*DEVIATION*`:

| Design v3 | Implementation |
|---|---|
| No proactive rate-limit judgment; DSH retryPolicy failure → cooldown | Direct `ctx.llm.stream()` calls are single-attempt (DSH's `retryPolicy` executor acts only on agent-loop request failures — `dsh-llm-retry`). A chunk-call failure **is** the exhaustion boundary: it writes the model's cooldown and requeues the chunk on another model. `*DEVIATION*`: nothing to configure; the plugin adds no retry parameters. |
| Persistence via `ctx.storage.domain` | `dsh_quilt_compact_state` domain (`routes` table) via the `json` backend. `*DEVIATION*`: `UNIT_NAME_RE` (`/^[a-z][a-z0-9_]*$/`) forbids hyphens, so the package name is underscored as `dsh_quilt_compact_state` (not `dsh-quilt-compact-state`). |
| Global `{ schemaVersion: 1 }` nullable | `*DEVIATION*`: `defineDomain` rejects global schemas that accept `null` (null is the "never written" sentinel), so the global is `{ schema: { schemaVersion: 1 }, initial: { schemaVersion: 1 } }`. It materializes on first write; until then the medium stores the null sentinel and reads serve `initial`. |
| `tables.routes = z.record(z.string(), …)` | `*DEVIATION*`: tables are declared per record with `domainTable(z.object({ cooldownUntil }))`; keys are plain strings on the medium. |
| Chunk cap / maxTokens removed from config | Per-call generation cap is the constant `DEFAULT_MAX_TOKENS = 32768` — `dsh-llm`'s unconfigured-model output assumption (32k) — so the framed checkpoint cannot silently balloon past the shrink check while a dense region digest is not truncated. |
| All chunks dispatched at once; `maxConcurrent` is per-model | Implemented in `ModelChain`; healthy-but-busy tiers make a chunk wait for a released slot or a cooldown expiry; a tier with no healthy model degrades the chunk to the next tier (per-job progression; a batch whose tier is fully cooled observably skips it, matching "整体降级"). |
| Merge runs through the ModelChain | Implemented. `*DEVIATION*`: single-chunk regions skip the merge call (no overlaps to deduplicate) and use the chunk digest directly, so a single-chunk compaction completes in one call ("一次完成"). |
| 会话模型兜底 (fallback) | **Directly calls the default compression plugin** (`dsh-compaction-basic`'s `summarize`, added as a peer dependency): it replays the ORIGINAL region input (system + region messages, unchanged) and appends its compaction instruction as the final user message — the default KV-cache-reusing compression. One call covers the whole region; when a single chunk would have sufficed, that call IS the one-pass completion. The fallback bypasses Stage 0/chunking (the prefix must stay unchanged for cache identity). The default plugin is instantiated on a throwaway context (`auto: false`) and redirected to the live `llm`, so its `compaction` service registration can never shadow ours (`lib/default-compression.js`). |
| Automatic pressure policy | Design removed thresholds from config; the engine **reads `dsh-compaction-basic`'s resolved defaults at runtime** (`readBasicPolicy()` in `lib/default-compression.js`) instead of pinning its own copy — threshold, retain, headroom, compaction retries, and overflow retries all follow the default plugin. `test/unit/policy.test.js` asserts that parity so the two cannot drift silently. |
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
   (window resolved from the pool's primary model, 262144 / 256k fallback), overlap
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

There are two ways to configure this plugin: a **settings page** in the Web UI
(for the model pool and the tuning knobs), and the **profile patch layer**
described below. The settings page writes into the same profile patch, so the
two are interchangeable — edit whichever is convenient.

### Settings page

With the Web app running, open the Plugins page and choose **dsh-quilt-compact**.
The page edits:

- the **model pool** — add or remove tiers, and add or remove model rows per
  tier. Provider and model are chosen from the models actually configured in
  this installation, never typed by hand; a saved route that is no longer in
  the catalog stays visible, marked unavailable, so you can see and remove it.
- **chunkRatio**, **chunkOverlapRatio**, **fallbackToSessionModel**, and the two
  prompt suffixes.
- the **Stage 0 preprocessing** switches.

Writes land in the profile's `cordis.patch.yml` under the `dsh-quilt-compact`
row, and take effect without a restart: the plugin reads its config through
volatile references.

### Profile patch layer

The bundle ships this layer verbatim in [`cordis.patch.yml`](cordis.patch.yml);
override individual rows in your profile's own `cordis.patch.yml` (later layers
win per row, and a patch replaces a row's whole `config` value rather than
deep-merging keys — restate every key the row needs):

```yaml
# Service entry only: the package must stay installed, because the chain's
# session-model fallback imports its summarize() directly.
- id: compaction-basic
  disabled: true

- insert:
    - id: dsh-quilt-compact
      name: 'dsh-quilt-compact'   # installed package name
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

### Model pool validation

A route that does not exist cannot work, and nothing in the schema can tell a
real route from a typo — `provider: trae` and `provider: traa` are both just
strings. So the engine checks every pool route against the **live** model
registry at load, and re-checks after every settings-page edit:

- `provider` not registered → *"provider is not registered"*
- provider known, model absent from its catalog → *"model is not in the provider catalog"*
- provider registered but publishes no catalog → *"provider does not publish a model catalog"*
  (accepted unchecked — a provider may legitimately route without advertising)

The authoritative source is `ctx.llm.listProviders()` + `listModels()`, **not**
the profile document: providers are registered at runtime by whichever plugin
owns them (`dsh-llm-pi-ai` from its settings section, `dsh-connect-*` from
`registerAdapter()`), so only the registry knows the real set. This matters in
practice — a static reading of the profile would wrongly report every
`trae/*` and `workbuddy/*` route as missing.

Validation **warns and continues**; it never blocks mounting. A provider that is
merely slow to register, or a registry that is temporarily unavailable, must not
stop compaction from working. The failure stays diagnosable because each warning
names the route and the reason.

## Persistence

Cooldown state lives in the `dsh_quilt_compact_state` domain routed to the
`json` backend. `dsh-base` already mounts the whole stack (`storage`,
`storage-json` with `root: dshHomePath('storages')`, and `storage-domain` with
`backend: json`), so a normal profile needs no extra wiring. A custom base must
mount them itself:

```yaml
- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-json'
  config:
    root: '~/.dsh/storage'
- name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
```

State file: `<root>/dsh_quilt_compact_state.json` (single layout) — one
`routes` table of `{ "provider/model": { "cooldownUntil": <epoch ms> } }`
plus the optional global. Writes are zod-validated and atomically published;
only cooldown *transitions* hit the disk (write throttling); expiry is lazily
cleaned on read (never written back).

If the storage-domain form is missing or its open fails, the engine degrades to
an in-memory store with a logged warning and keeps working. Losing cooldown
state is acceptable: a route with no record is simply healthy, so the next
request re-discovers its current status. Cooldown state is *not* plugin
configuration — plugin config comes from the cordis patch layer and is
validated at load.

> Cooldown state cannot be stored in browser storage (localStorage /
> IndexedDB): this plugin runs on the Node host plane alongside `ctx.llm` and
> `ctx.sessions`, and DSH ships only the filesystem `json` backend. The storage
> hub's `backend.register()` seam would accept a custom backend, but none is
> provided.

## Privacy

The state file contains **only** route cooldown timestamps. No session
messages, prompts, or digests ever cross the domain.

## Observability (logs)

Every model call is traceable end to end; log lines are structured key=value
strings so they stay greppable:

- `debug dsh-quilt-compact call: …` — per call, before dispatch:
  - `job=chunk N | merge | fallback` and `route=provider/model`
  - `defaultPlugin=true` on the fallback line marks the DIRECT call to
    `dsh-compaction-basic` (the default compression plugin); the fallback then
    records `outputChars`/`outputTokens`/`durationMs` on that same line.
  - input segment identification: `inputChars`, `inputTokens~` (heuristic),
    `lines=A..B` (the Stage 0c line range for chunk jobs),
    `requestChars` (full request envelope incl. instruction), `sha=…`
    (first 12 hex of the input's SHA-256), and `preview="…"` (first 80 chars,
    single line).
- `debug dsh-quilt-compact call ok: …` — per successful call:
  `outputChars`, `outputTokens` (provider usage when reported), `durationMs`.
- `warn dsh-quilt-compact: route … failed … job=… sha=…; cooling until …` —
  cooldown write events (design §2.4: logged, never the state file).
- `info dsh-quilt-compact summarize: …` — region stats before chunking:
  `regionChars`, `stage0Lines`, `chunks`, `chunkBudget`, `overlapTokens`,
  `contextWindow`.
- `info dsh-quilt-compact summarize done: …` — final route, `fallback`,
  `digestChars`, `attempts`.
- `info dsh-quilt-compact batch: …` — per pool batch: `jobs`, `calls`,
  `byRoute=p1/m1:N,…`, `failures`, `fallback`, `durationMs`.

Privacy boundary: logs carry **stats, fingerprints, and ≤80-char previews
only** — never full session messages, prompts, or digests.

## Package layout

```
lib/
  index.js            exports: default QuiltCompactEngine, Config, spec, helpers
  engine.js           QuiltCompactEngine: summarize, compactIfNeeded/Now/Region,
                      automatic wiring, store bootstrap, fallback delegate wiring
  default-compression.js  direct facade over dsh-compaction-basic's summarize
  config.js           schemastery Config + resolveConfig (validation/defaults)
  model-pool.js       runtime validation of the pool against the live registry
  spec.js             dsh_quilt_compact_state domain spec, routeKey
  cooldown.js         computeCooldownUntil, Domain/Memory stores
  model-chain.js      tier scheduler: slots, cooldown, degradation, fallback
  summarize.js        built-in prompts, one-shot stream call, checkpoint framing
  region.js           durable compaction transaction + shrink check + recovery
  stage0/             text extraction, trims, semantic compression, chunking
client/
  client.js           browser half: the settings page (plugins.item slot)
cordis.patch.yml      shipped bundle layer (dsh.bundle.patch)
test/
  unit/               cooldown, config, stage0, model-chain, policy, model-pool
  e2e/                full transaction on real sessions; real json persistence
  smoke/              real dsh code: patch composer, container mount, volatile
                      config, pool validation, service-registration safety
```

## Development / tests

```sh
npm install --cache ./.npm-cache      # test deps (never touches any DSH profile)
node test/unit/cooldown.test.js       # run any file directly; node:test runs in-process
npm run smoke                         # all five smoke scripts
```

`node --test test/` needs child-process spawning, which the sandbox used for
this project denies; run files individually (or outside the sandbox) instead.
The fake-LLM end-to-end suite simulates retryPolicy-exhausted failures →
cooldown writes → tier degradation → session-model fallback (design checklist
item 8), and the persistence suite exercises the real json backend + reopen.

The smoke scripts go beyond the unit/e2e suite by exercising **real DSH code**
rather than fakes:

| Script | What it proves |
|---|---|
| `smoke:patch` | the real `dsh-base` layer + this bundle's layer, composed through **dsh's own `composeEntries` / `loadOverlayPatches`** (the functions `dsh --dump-config` uses): `compaction-basic` disabled, `dsh-quilt-compact` enabled, no other row disturbed |
| `smoke:mount` | a real cordis `Context` with the real `dsh-storage` / `storage-json` / `storage-domain` stack; the plugin mounts as `ctx.compaction`, cooldown state really reaches the filesystem, unload is clean |
| `smoke:volatile` | a `.volatile()` Config delivers **references**, not values — the engine unwraps them and defaults still apply |
| `smoke:pool` | pool validation against a live registry: validates, warns per reason, re-checks on a config edit, and still mounts when the registry is broken |
| `smoke:registration` | constructing `BasicCompactionEngine` internally (fallback facade + policy read) never claims the live `compaction` slot — the failure mode that made the plugin refuse to start when two backends were enabled |

The patch/mount scripts need the dsh installation on disk. They locate it
automatically (walking up from this checkout, then `npm root -g`); set
`DSH_MODULES` to the dsh installation's `node_modules` to point at it
explicitly. When dsh cannot be found they print `SKIP` and exit 0, so they never
fail a checkout that simply does not have dsh installed.

## Activation

Install straight from the GitHub repository (no npm publish needed):

```sh
dsh plugin --profile <name> add github:bvbhu/dsh-quilt-compact
dsh --profile <name> --dump-config   # verify the "## == dsh-quilt-compact" layer
```

The full URL form works too
(`dsh plugin --profile <name> add https://github.com/bvbhu/dsh-quilt-compact`),
as does a local path for development. A `#<ref>` suffix pins a commit or tag:
`github:bvbhu/dsh-quilt-compact#<sha>`. Pinning is recommended once you settle on
a revision, since a bare repository install follows the default branch.

Because the package declares `dsh.bundle`, that single command appends the
bundle to `dsh.profile.bundles` **and** activates the shipped layer — no manual
`insert:` is needed. A package without the `dsh.bundle` declaration still
installs, but only as a plain dependency: `dsh plugin` warns and activates no
layer.

> **This bundle also disables `compaction-basic`.** Installing it changes which
> plugin owns `ctx.compaction`, so re-read
> [Uninstalling](#uninstalling) before removing it again.

The shipped layer already:

- disables `compaction-basic` as a *service entry* (the package itself must stay
  installed — the fallback imports its `summarize` directly; peer dependency
  `@deepseek-ai/dsh-compaction-basic`, which ships with DSH by default);
- mounts `dsh-quilt-compact` from the **installed** package name, not a relative
  source path, so Node resolves the installed copy.

Layer precedence (later wins per row): each bundle patch in
`dsh.profile.bundles` order → the profile's `cordis.patch.yml` →
`$DSH_HOME/cordis.patch.yml` → `--patch` overlays. To change the model pool,
restate the whole `dsh-quilt-compact` row (with every key it needs) in your
profile patch rather than editing the package.

`dsh plugin --profile <name> remove dsh-quilt-compact` removes both the
dependency and the layer; `compaction-basic` stays installed but disabled, so
re-enable it (`disabled: false`) if you want the default backend back. See
[Uninstalling](#uninstalling) for the full procedure, including how to restore
the default backend and where cooldown state lives.

## Uninstalling

`dsh plugin remove` deletes the dependency and the bundle layer, but it cannot
undo one thing this bundle did: it **disabled** the `compaction-basic` row.
That row lives in `dsh-base` and survives removal, so removing the package
alone leaves the profile with **no** compaction service. Always finish step 3.

```sh
# 1. Remove the dependency and this bundle's layer from the profile.
dsh plugin --profile <name> remove dsh-quilt-compact

# 2. Confirm the layer is gone but compaction-basic is still disabled.
dsh --profile <name> --dump-config | Select-String -Pattern 'compaction'

# 3. Restore the default backend: re-enable the compaction-basic row.
#    In $DSH_HOME/profiles/<name>/cordis.patch.yml (the profile's own layer):
- id: compaction-basic
  disabled: false

# 4. Verify exactly one compaction service is active and one is enabled.
dsh --profile <name> --dump-config | Select-String -Pattern 'compaction'
```

Step 3 belongs in the **profile's** `cordis.patch.yml`, not in the package —
later layers win per row, so a profile-level `disabled: false` re-enables basic
without touching `dsh-base` or this package.

Cooldown state is separate from the plugin and is not removed automatically. It
is one file under the DSH home — `$DSH_HOME/storages/dsh_quilt_compact_state.json`
(the `json` backend writes one document per storage unit; the domain name is
`dsh_quilt_compact_state`). Delete it for a clean slate:

```sh
Remove-Item "$env:DSH_HOME\storages\dsh_quilt_compact_state.json" -ErrorAction SilentlyContinue
```

Leaving it behind is harmless: with the plugin gone nothing reads it. Reinstall
later and every route starts healthy, because a route with no record is healthy
by construction.

### Temporary disable (no uninstall)

To stop using the chain without removing anything, disable just the inserted row
in the profile layer and re-enable basic in the same file:

```yaml
- id: dsh-quilt-compact
  disabled: true

- id: compaction-basic
  disabled: false
```

This keeps the package installed and reverts the profile to the default backend
on the next start — the cheapest way to A/B the two.

## Review against the official plugin guide

Checked against `docs/user/develop/` in
[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/user/develop)
([first plugin](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md),
[services](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/service.md),
[configuration](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.md),
[publish](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)).

| Guide rule | Status |
|---|---|
| Provide a service with class form: `extends Service`, `super(ctx, name)` | ✅ `extends CompactionEngine` (which registers as `compaction`) |
| Declare required services in `inject` | ✅ `['llm', 'tokenMeter', 'sessions']` |
| Optional services: omit from `inject`, query with `ctx.get()` | ✅ `storageDomain`, `toolResultPruner` |
| Explicit cleanup via `ctx.effect()` disposer | ✅ lazily-opened cooldown domain closes on unload |
| Event listeners/timers auto-cleanup; never remove manually | ✅ `ctx.on(...)` only |
| Export a `Config` schemastery schema (never a plain object) | ✅ `config.js` exports `Config = z.object({...})`, `static Config` |
| Do not hardcode values two deployments may want to differ on | ✅ design v3 removed these from public config, but nothing is arbitrary: the pressure policy is **read from `dsh-compaction-basic` at runtime** (`readBasicPolicy()`), and the two model-capacity fallbacks (`262144` / `32768`) are `dsh-llm`'s unconfigured-model assumptions. `test/unit/policy.test.js` asserts both parities. |
| Declare `dsh.bundle` so `dsh plugin add` activates a layer | ✅ `dsh.bundle.patch` → `cordis.patch.yml` |
| Bundle rows reference the package by installed name | ✅ `name: dsh-quilt-compact` |
| Ship the patch file in `files` | ✅ `["lib", "client", "cordis.patch.yml"]` |
| Mark editable Config fields `.volatile()` | ✅ every field, so the settings page can write them live; `tiers` is volatile as a whole because schemastery forbids a volatile field inside an array element |
| Unwrap volatile references before use | ✅ `resolveConfig()` reads through `.get()`, and accepts plain values too (unit tests and direct construction) |
| A client half needs `dsh.client` + a `./client` export | ✅ `dsh.client.platform: web`, `exports["./client"]` → `client/client.js` |
| Client UI: host theme tokens only, no literal colors | ✅ `--dsw-alias-*` only |
| Client UI: all visible text through `ctx.locale` | ✅ `zh` + `en` dictionaries |
| Client UI: never `require` a `dsh-client-ui-*` package as a module | ✅ uses only the module table (`react`, `react/jsx-runtime`, `slots`, `primitives`) |
| Client UI: register every resource with `ctx.effect` | ✅ subscriptions and slot registrations are effects |
| dsh packages shared with the host: both `peerDependencies` and `devDependencies` | ✅ cordis, agent, compaction, compaction-basic, llm, session, storage-domain, token-meter |
| Deep imports must be allowed by the dependency's `exports` | ✅ `@deepseek-ai/dsh-token-meter/estimate` |
| `types` must point at a real artifact (publint hygiene) | ✅ no `types` field — this package ships plain JS with no build step, so no declarations are claimed |

`@deepseek-ai/dsh-storage-domain` is imported statically (its `defineDomain` /
`domainTable` build the spec at module load), so it is a real install-time
dependency; the engine still degrades to memory at runtime if the *form* is not
mounted, which is intentional (see [Persistence](#persistence)).

## Compatibility checks

Verified against the installed DSH `0.1.7-rc.1` before publishing.

| Check | Result |
|---|---|
| Every `peerDependencies` version equals the installed DSH version | ✅ `dsh-compaction`, `dsh-compaction-basic`, `dsh-llm`, `dsh-session`, `dsh-storage-domain`, `dsh-token-meter`, `dsh-agent` all `0.1.7-rc.1`; `cordis ~4.0.4` satisfied by `4.0.4` |
| `CompactionEngine` seam: `extends Service`, `super(ctx, 'compaction')` | ✅ same registration path as `dsh-compaction-basic`, so `ctx.compaction` is the one service consumers see |
| `inject` names resolve to services the base layer provides | ✅ `llm`, `tokenMeter`, `sessions` (rows `llm`, `token-meter`, `session`) |
| Automatic-pressure policy matches the built-in backend | ✅ read at runtime from `dsh-compaction-basic` via `readBasicPolicy()` — `0.8 / 0.16 / 65536 / 1 / 1` |
| Patch layer composes over the real `dsh-base` layer | ✅ dsh's own `composeEntries` yields 93 rows: `compaction-basic` disabled with `name` preserved, `dsh-quilt-compact` enabled, no collateral edits |
| The plugin mounts as `ctx.compaction` in a real cordis container | ✅ `smoke:mount`, with the real `dsh-storage` / `storage-json` / `storage-domain` stack |
| Cooldown state really persists | ✅ round-trips through the real domain and reaches `dsh_quilt_compact_state.json` |
| Unload is clean | ✅ `ctx.effect` disposer closes the domain; container disposes without error |
| Pool validation against a live registry | ✅ `smoke:pool`: validates, warns per reason, re-checks on a config edit, and still mounts when the registry is broken |
| Volatile config delivers unwrapped values | ✅ `smoke:volatile`: references are read through `.get()`, defaults still apply |
| Internal `BasicCompactionEngine` never claims `ctx.compaction` | ✅ `smoke:registration` |

Known, intended constraints:

- **`compaction-basic` is disabled as a service entry, not uninstalled.** The
  session-model fallback imports its `summarize` directly, so the package must
  stay installed. Removing the package from the tree breaks the fallback.
- **Only one compaction backend should be enabled.** Both mount the same
  `compaction` service. Enabling both fails startup with *"service
  `compaction` has been registered at `<BasicCompactionEngine>`"*; enabling
  neither leaves the profile unable to compact. The shipped bundle layer sets
  this up correctly, so a profile layer should normally say nothing at all —
  see [Temporary disable](#temporary-disable-no-uninstall).
- **There is no auto-generated settings form in DSH.** `dsh-settings` reports
  `autoGenerate` for clients that build pages from a schema, but no shipped
  client does so (`dsh-settings/README.md`). `.volatile()` is what makes a field
  *writable*; the page itself is `client/client.js`. A plugin that wanted
  automatic forms would have to build the renderer.
- **Tuned for DSH `0.1.7-rc.1`.** `readBasicPolicy()` follows upstream retuning
  automatically, but the service seam itself (`CompactionEngine`, patch format)
  is not version-negotiated — a major DSH release needs a re-run of these
  checks.

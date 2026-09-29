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

With the Web app running, open the Plugins page and choose **dsh-quilt-compact**
(its row-config entry). The page edits:

- the **model pool** — add or remove tiers, and add or remove model rows per
  tier. Provider and model are chosen from the models actually configured in
  this installation, never typed by hand; a saved route that is no longer in
  the catalog stays visible, marked unavailable, so you can see and remove it.
- **chunkRatio**, **chunkOverlapRatio**, **fallbackToSessionModel**, and the two
  prompt suffixes.
- the **Stage 0 preprocessing** switches.

The settings card mirrors `dsh-connect-trae`'s plugin card: a collapsible shell
(header carries title + description + a pure-CSS caret — no primitives icon
import, because icon names are not a stable contract across DSH releases), a
tab bar over the three sections, and token-only surfaces. It registers into
both `plugins.row.config` and `plugins.bundle.config` (each seat guarded
independently). The Save button is never disabled by a validation error:
clicking it surfaces the reason; a provider change refills the paired model
from the new provider's first model, so an edit never leaves the draft
silently invalid.

The page talks to the settings bridge (`/api/dsh-quilt-compact/*`) that the
engine registers when a web server is present. In a **web/desktop profile** the
engine runs inside the `standard` preset's `compaction` group, and the bridge
writes the copy nested in `preset-standard` through `configEditor` — the same
persistence path the official editor uses (`dsh-settings` forms cannot address
a row inside a preset group). In a **headless/sdk profile** the bridge writes
the host-plane row directly. Either way writes take effect without a restart:
the plugin reads its config through volatile references.

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

## Run log (compaction evaluation)

Every compaction writes **one JSON line** to
`~/.dsh/storages/dsh_quilt_compact_runs.jsonl` (JSONL, append-only) so you can
review later what was compacted and what came out — the point is evaluating
compression quality, not just observing that it ran:

```json
{"at":1790000000000,"trigger":"manual","regionChars":245760,"stage0Lines":120,"chunkCount":6,"chunkBudget":8192,"overlapTokens":819,"contextWindow":262144,"route":"openrouter/openrouter/free","fallback":false,"digestChars":1840,"attempts":1,"snapshotChars":20000,"snapshot":"…capped input…","result":"…final digest…"}
```

- `trigger`: `manual` (`/compact`), `pressure` (automatic step pressure),
  `context-overflow` (provider-confirmed overflow recovery), or `auto`.
- `snapshot`: the replayed conversation prefix, capped to
  `runRecord.snapshotChars` (head 80% + tail 20% with an elision marker; `0`
  keeps everything).
- `result`: the final digest text (chunk-merged, or the session-model fallback
  digest when `fallback: true`).
- `route`/`fallback`/`digestChars`/`attempts` plus the region/chunking stats.

Configured through `runRecord` (defaults: `enabled: true`, `maxEntries: 200`,
`snapshotChars: 20000`, `path: ''` → the storage root). `maxEntries` trims the
file to the most recent entries; `path` pins an absolute file location (useful
for tests and for pointing at a shared volume). The settings page's **运行记录 /
Run log** tab toggles it.

This is a deliberate, separate privacy boundary from the cooldown domain: the
run log **does** contain conversation content (snapshot + digest) by design.
Disable it (`runRecord.enabled: false`) if that is not wanted.

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
  index.js            exports: default QuiltCompactEngine, Config, spec, helpers,
                      bridge core + host wiring
  engine.js           QuiltCompactEngine: summarize, compactIfNeeded/Now/Region,
                      automatic wiring, store bootstrap, fallback delegate wiring,
                      settings-bridge registration (webServer when present)
  bridge.js           framework-free bridge core: describe/mutate/status handlers,
                      loopback guard, JSON body/response helpers, route builder
  bridge-host.js      createBridgeDeps (locate preset/host row, read/write through
                      configEditor, llm catalog, status) + registerQuiltBridge
  default-compression.js  direct facade over dsh-compaction-basic's summarize
  config.js           schemastery Config + resolveConfig (validation/defaults)
  model-pool.js       runtime validation of the pool against the live registry
  spec.js             dsh_quilt_compact_state domain spec, routeKey
  cooldown.js         computeCooldownUntil, Domain/Memory stores
  run-log.js          JSONL run log: capSnapshot, resolveRunLogPath, RunLog
  model-chain.js      tier scheduler: slots, cooldown, degradation, fallback
  summarize.js        built-in prompts, one-shot stream call, checkpoint framing
  region.js           durable compaction transaction + shrink check + recovery
  stage0/             text extraction, trims, semantic compression, chunking
client/
  client.js           browser half: the settings page (plugins.row.config seat,
                      reads/writes through the settings bridge)
cordis.patch.yml      shipped bundle layer (dsh.bundle.patch): host-plane swap +
                      preset-standard restate with the compaction-group engine
test/
  unit/               cooldown, config, stage0, model-chain, policy, model-pool,
                      bridge (describe/mutate/conflict/schema/guard/locate)
  e2e/                full transaction on real sessions; real json persistence
  smoke/              real dsh code: patch composer, container mount, volatile
                      config, pool validation, service-registration safety,
                      full web-stack composition, client render via bridge
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
| `smoke:compose-web` | the **full web stack** (web-app bundle patches in order + user profile layer + this bundle last): `preset-standard` keeps 19 plugins with the `compaction` group now carrying `dsh-quilt-compact` (isolate + command-compact + tool-result-pruner intact), the host insert row's `!!js` gate survives, and no `compaction-basic` remains in the group |
| `smoke:mount` | a real cordis `Context` with the real `dsh-storage` / `storage-json` / `storage-domain` stack; the plugin mounts as `ctx.compaction`, cooldown state really reaches the filesystem, unload is clean |
| `smoke:volatile` | a `.volatile()` Config delivers **references**, not values — the engine unwraps them and defaults still apply |
| `smoke:pool` | pool validation against a live registry: validates, warns per reason, re-checks on a config edit, and still mounts when the registry is broken |
| `smoke:registration` | constructing `BasicCompactionEngine` internally (fallback facade + policy read) never claims the live `compaction` slot — the failure mode that made the plugin refuse to start when two backends were enabled |
| `smoke:client` | the browser page renders from the **settings bridge** (stubbed fetch, real `dsh-client-store` snapshot API — `getSnapshot`/`subscribe`, no `get()`), registers into both `plugins.row.config` and `plugins.bundle.config` with the `<package>#<row>` / `<package>` keys, the shell collapses and tabs switch panels, pickers come from the catalog, a provider change refills the paired model so Save stays valid, the whole `tiers` array saves as clean JSON fenced on revision, invalid input is surfaced on click (Save is never disabled by a validation error) |
| `smoke:bridge-order` | a real cordis `Context`: bridge routes register when the engine mounts with a webServer already present, **and** register once a *late* `webServer` is provided — the actual web-profile race (`include:dsh-quilt-compact` can activate before `dsh-web-app` starts its server) that previously left the settings page a 404 `not found` |

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

### Profiles where the host plane owns compaction

This bundle layer is written for profiles where the `compaction` service lives
on the host plane — the `headless`, `sdk`, `sdk-minimal`, and custom
`dsh-base`-backed profiles. There, `dsh plugin add` flips the backend in one
step: `compaction-basic` is disabled and `dsh-quilt-compact` becomes
`ctx.compaction`, exactly as verified by `smoke:patch`.

### Web profiles: the compaction backend lives in the agent preset

The **Web** profile (`dsh --profile web`) is different, by design:

- `dsh-web-app` **disables** the host-plane `compaction-basic`,
  `command-compact`, and `tool-result-pruner` rows — its comment explains that
  the compaction backend "moves".
- The `standard` agent preset (and `minimal`/`ptc`/`cordis`) re-mounts that
  same trio inside a `compaction` **group** with
  `isolate: { compaction: true, toolResultPruner: true }`. When an agent is
  created with that preset, `dsh-agent-preset-registry` mounts the preset's
  plugin rows (including the compaction group) onto the **agent context**, in
  an isolated realm.

Since v4 the bundle handles this automatically. The shipped layer does **two**
things at once:

1. **Host-plane branch** (headless/sdk/custom): disables `compaction-basic` and
   mounts `dsh-quilt-compact` — the classic one-step swap.
2. **Web/desktop branch**: restates the `preset-standard` declaration with the
   `compaction` group's backend row swapped to `dsh-quilt-compact` (the group's
   `isolate`, `command-compact`, and `tool-result-pruner` stay untouched). The
   restate is generated verbatim from the shipped `standard.patch.yml` by
   `tools/generate-preset-restate.mjs`, so it cannot drift.

The two branches are mutually exclusive per profile: the host-plane insert row
carries `disabled: !!js "['web', 'desktop'].includes(ctx.get('profileContext')?.name)"`
(the same idiom `dsh-web-app` uses), so in a web/desktop profile only the
preset-group engine is active — never two compaction engines over the same
agent events. In a headless/sdk profile the `preset-standard` row does not
exist, so the restate is skipped (harmless "not found") and the host-plane row
is the backend. `test/smoke/compose-web.mjs` composes the full web stack
(web-app bundle patches + profile layer + this bundle) and asserts the result.

Because a patch replaces a row's `config` wholesale (never deep-merges), the
restate carries the full 19-row plugin list of `standard` preset. That freezes
the shipped preset contents in this bundle: **after a DSH upgrade that changes
the standard preset, re-run**
`$env:DSH_MODULES='…dsh\node_modules'; node tools/generate-preset-restate.mjs`
to regenerate the restate against the new files.

The settings page (see [Configuration](#configuration)) writes through the
settings bridge (`/api/dsh-quilt-compact/*`): in a web profile it edits the
copy nested inside `preset-standard` via `configEditor` (the same persistence
path the official editor uses), because `dsh-settings` forms cannot address a
row inside a preset group. In a headless/sdk profile it edits the host-plane
row directly.

Layer precedence (later wins per row): each bundle patch in
`dsh.profile.bundles` order → the profile's `cordis.patch.yml` →
`$DSH_HOME/cordis.patch.yml` → `--patch` overlays. To change the model pool,
use the settings page, or restate the whole `dsh-quilt-compact` row (with every
key it needs) in your profile patch rather than editing the package. Note the
web/desktop pool is the **copy inside `preset-standard`**; the page's bridge
writes exactly that copy, so the two places stay in sync as long as you edit
through the page or re-run the generator after hand-editing the host row.

`dsh plugin --profile <name> remove dsh-quilt-compact` removes both the
dependency and the layer. How to restore the default backend afterwards
depends on the profile kind — see [Uninstalling](#uninstalling) for the full
procedure (host-plane profiles must re-enable `compaction-basic`, Web profiles
must swap the preset's compaction group back).

## Uninstalling

How to remove the plugin depends on which kind of profile it was added to (see
[Web profiles](#web-profiles-the-compaction-backend-lives-in-the-agent-preset)).

### Host-plane profiles (headless, sdk, custom)

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

### Web profiles

`dsh plugin remove dsh-quilt-compact` removes the dependency and the bundle
layer — including the `preset-standard` restate the bundle shipped, so the
preset's `compaction` group reverts to `@deepseek-ai/dsh-compaction-basic`
automatically **unless a profile-layer override exists**:

```sh
# 1. Remove the dependency and this bundle's layer (restate included).
dsh plugin --profile web remove dsh-quilt-compact

# 2. Confirm the preset's compaction group is back to the default backend.
dsh --profile web --dump-config | Select-String -Pattern 'compaction-basic'
```

If you previously wrote your own `preset-standard` override in the **profile's**
`cordis.patch.yml` (older instructions), that layer outlives the bundle and
keeps pointing the group at `dsh-quilt-compact`; remove that block by hand so
the group returns to `@deepseek-ai/dsh-compaction-basic`. The host-plane rows
are untouched either way: the Web layer already disables them and the preset
group is what actually serves agents.

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

**Host-plane profiles** — disable just the inserted row in the profile layer and
re-enable basic in the same file:

```yaml
- id: dsh-quilt-compact
  disabled: true

- id: compaction-basic
  disabled: false
```

This keeps the package installed and reverts the profile to the default backend
on the next start — the cheapest way to A/B the two.

**Web profiles** — restate the `preset-standard` row in the profile layer with
the compaction group's backend row back at `@deepseek-ai/dsh-compaction-basic`
(a later layer wins per row, so this overrides the bundle's restate), or drop
the bundle from `dsh.profile.bundles` temporarily. There is no host-plane row
to flip; the preset group is the single place that decides.

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
| Change a shipped preset: restate the row (never insert, never patch group children) | ✅ `preset-standard` is overridden with the full 19-row list; `tools/generate-preset-restate.mjs` regenerates it verbatim from the shipped file |
| A preset plugin that supplies a service must isolate provider and consumers in one realm | ✅ the `compaction` group keeps `isolate: { compaction: true, toolResultPruner: true }`; `command-compact` (a consumer) stays in the same group |
| Optional services via `inject`/`ctx.get` so the plugin stays inactive without them | ✅ `configEditor`/`llm` are queried with `ctx.get`; the bridge registers only when a webServer exists — and **waits** for a late webServer via `ctx.inject(['webServer'])` (free-search pattern), so an engine that mounts before `dsh-web-app` starts its server still gets its routes; duplicate registrations from a sibling engine are tolerated |
| Settings UI beyond configForms: ship a page and a host bridge when the row is not an include-tree entry | ✅ `plugins.row.config` seat + `/api/dsh-quilt-compact/*` bridge (free-search / auto-approval precedent) |
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
| Full web stack: preset group serves dsh-quilt-compact, host row gated | ✅ `smoke:compose-web`: 167 rows, 19 preset plugins, group = `dsh-quilt-compact, command-compact, tool-result-pruner`, `!!js` gate intact |
| Settings bridge: describe/mutate/status + conflict/schema fencing | ✅ 21 unit tests; client renders through a stubbed bridge (`smoke:client`) |

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
- **Web profiles: the settings bridge is the only GUI path, and it is tied to
  the engine instance.** `dsh-settings` forms cannot address a row inside a
  preset group, so the page talks to `/api/dsh-quilt-compact/*` (registered by
  the engine when a web server exists). The bridge writes the nested copy in
  `preset-standard` through `configEditor`. If the preset engine is not mounted
  (e.g. the user switched to the `minimal` preset), the bridge reports
  `no-target` and the page explains rather than editing a dead row.
- **The preset restate freezes the shipped `standard` preset.** After a DSH
  upgrade that changes `presets/standard.patch.yml`, re-run
  `tools/generate-preset-restate.mjs` to regenerate the restate (see
  [Web profiles](#web-profiles-the-compaction-backend-lives-in-the-agent-preset)).
- **Tuned for DSH `0.1.7-rc.1`.** `readBasicPolicy()` follows upstream retuning
  automatically, but the service seam itself (`CompactionEngine`, patch format,
  preset shape) is not version-negotiated — a major DSH release needs a re-run
  of these checks.

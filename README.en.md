# dsh-quilt-compact

A context-compaction plugin for the DeepSeek Harness.

It replaces the default `compaction` backend: **compresses long context with
cheap, small models, chunk by chunk** — the conversation is split into small
chunks, each is summarized by an inexpensive small model, and the digests are
merged back into one checkpoint, instead of feeding the entire context to an
expensive large model in a single call.

- Configurable model tiers (different sizes per tier), auto-selected and
  degraded by capacity.
- A model that fails is cooled for a while; when everything is unavailable,
  the session model takes over.
- Chunking, summarizing, and merging run automatically, producing one small
  but complete checkpoint.

## Supported DSH version

`0.1.7-rc.1` (peer-dependency pinned).

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
row by row). The core configuration is the model pool (`tiers`) and the
chunking parameters:

```yaml
- id: dsh-quilt-compact
  config:
    # Fraction of a model's usable input one chunk may occupy; adjacent-chunk
    # overlap as a fraction of the chunk budget.
    chunkRatio: 0.8
    chunkOverlapRatio: 0.1
    # Whether the session model takes over when every tier is cooled.
    fallbackToSessionModel: true
    # Ordered model pool. cooldown is one of: duration (hours) or dailyReset
    # (UTC hour).
    tiers:
      - name: primary
        models:
          - provider: openrouter
            model: openrouter/free
            maxConcurrent: 1
            cooldown: { mode: dailyReset, hour: 0 }
```

## Privacy

The state file contains only route cooldown timestamps — no session messages,
prompts, or digests.
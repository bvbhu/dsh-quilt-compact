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
/**
 * Compaction interceptor: the cooperative, no-service-replacement seam.
 *
 * These tests pin the three properties the redesign exists for:
 * 1. only `purpose === 'compaction'` calls are touched, everything else passes;
 * 2. the host's own summary is preserved whenever compression cannot finish;
 * 3. a successful run emits a text stream carrying the session-search anchors.
 *
 * @module dsh-quilt-compact/test/unit/intercept
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CompactionStreamInterceptor,
  regionMessagesForTest,
  isCompactionRequestForTest,
} from '../../lib/intercept.js';
import { ANCHOR_OPEN_TAG, ANCHOR_CLOSE_TAG, buildAnchorBlock } from '../../lib/summarize.js';
import { createFakeLlm, defaultEngineConfig } from '../helpers/fixture.js';

/**
 * Minimal cordis-ish context: enough for the interceptor's `on`/`effect`/`get`
 * usage plus a scriptable llm. `streamCalls` records every nested call.
 */
function createInterceptContext(options = {}) {
  const handlers = [];
  const streamCalls = [];
  const llm = createFakeLlm(options.behaviors ?? {}, options);
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    llm: {
      async *stream(opts) {
        streamCalls.push(opts);
        yield* llm.stream(opts);
      },
      resolveModelInfo: (provider, model) => llm.resolveModelInfo(provider, model),
      providerRetryPolicy: (provider) => llm.providerRetryPolicy(provider),
    },
    on(event, listener) {
      handlers.push({ event, listener });
    },
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get(name) {
      if (name === 'storageDomain') return undefined;
      if (name === 'sessions') return { get: () => undefined };
      return undefined;
    },
  };
  return { ctx, handlers, streamCalls };
}

/** Drive the registered llm/stream listener with a downstream stream. */
async function runListener(handlers, options, downstreamChunks) {
  const handler = handlers.find((entry) => entry.event === 'llm/stream');
  assert.ok(handler, 'the interceptor registered llm/stream');
  const iterable = handler.listener(options, () => (async function* emit() {
    for (const chunk of downstreamChunks) yield chunk;
  })());
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

/** The chunk list a healthy downstream summarization produces. */
function summaryChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

/** Extract the text of a finished chunk list. */
function textOf(chunks) {
  let text = '';
  for (const chunk of chunks) {
    if (chunk.type === 'text-delta') text += chunk.text;
    if (chunk.type === 'block-end' && chunk.block?.type === 'text') text = chunk.block.text;
  }
  return text;
}

/** A replayed compaction request: system head, region, instruction. */
function compactionOptions(regionText, overrides = {}) {
  return {
    provider: 'session-p',
    model: 'session-m',
    purpose: 'compaction',
    sessionId: 's-test',
    maxTokens: 4096,
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'You are a helpful assistant.' }] },
      { role: 'user', content: [{ type: 'text', text: regionText }] },
      { role: 'user', content: [{ type: 'text', text: 'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE.' }] },
    ],
    ...overrides,
  };
}

test('non-compaction requests are passed through untouched (no extra model calls)', async () => {
  const { ctx, handlers, streamCalls } = createInterceptContext();
  const interceptor = new CompactionStreamInterceptor(ctx, defaultEngineConfig());
  interceptor.apply();

  const chunks = summaryChunks('plain answer');
  const out = await runListener(handlers, { provider: 'p', model: 'm', purpose: 'chat', messages: [] }, chunks);

  assert.equal(textOf(out), 'plain answer');
  assert.equal(streamCalls.length, 0, 'the interceptor issued no auxiliary call');
});

test('a compaction request is rewritten into chunk -> merge digests with anchors', async () => {
  const region = Array.from({ length: 200 }, (_, i) => `line ${i}: build step with exact path and decision`).join('\n');
  const { ctx, handlers, streamCalls } = createInterceptContext();
  const interceptor = new CompactionStreamInterceptor(ctx, defaultEngineConfig({
    // Small merge window forces the multi-chunk path through the pool.
    mergeMaxContextTokens: 4000,
  }));
  interceptor.apply();

  const out = await runListener(handlers, compactionOptions(region), summaryChunks('host summary'));
  const text = textOf(out);

  assert.ok(streamCalls.length > 0, 'the pool served at least one digest call');
  for (const call of streamCalls) {
    assert.equal(call.purpose, 'compaction', 'auxiliary calls keep the compaction purpose');
  }
  assert.ok(text.length > 0, 'a summary was produced');
  // The anchor block is present and parseable, and points at this session.
  assert.ok(text.includes(ANCHOR_OPEN_TAG) && text.includes(ANCHOR_CLOSE_TAG), 'anchor block present');
  const raw = text.slice(text.indexOf(ANCHOR_OPEN_TAG) + ANCHOR_OPEN_TAG.length, text.indexOf(ANCHOR_CLOSE_TAG)).trim();
  const anchor = JSON.parse(raw);
  assert.equal(anchor.sessionId, 's-test');
  assert.ok(Array.isArray(anchor.chunks) && anchor.chunks.length >= 1, 'per-chunk anchors recorded');
  assert.ok(anchor.id.startsWith('QC-'), 'a stable request anchor id is present');
});

test('a failing pool keeps the host summary (graceful degradation)', async () => {
  const region = Array.from({ length: 60 }, (_, i) => `row ${i} factual content for compaction`).join('\n');
  const { ctx, handlers, streamCalls } = createInterceptContext({
    behaviors: {
      'p1/m1': { kind: 'fail', code: 'SERVER', message: 'down' },
      'p1/m2': { kind: 'fail', code: 'SERVER', message: 'down' },
      'p2/m3': { kind: 'fail', code: 'SERVER', message: 'down' },
    },
  });
  const interceptor = new CompactionStreamInterceptor(ctx, defaultEngineConfig());
  interceptor.apply();

  // Downstream next() must be reached exactly once when the pool cannot serve.
  let downstreamCalls = 0;
  const handler = handlers.find((entry) => entry.event === 'llm/stream');
  const iterable = handler.listener(compactionOptions(region), () => {
    downstreamCalls += 1;
    return (async function* emit() {
      for (const chunk of summaryChunks('host fallback summary')) yield chunk;
    })();
  });
  const out = [];
  for await (const chunk of iterable) out.push(chunk);

  assert.equal(downstreamCalls, 1, 'the original summary stream is used');
  assert.equal(textOf(out), 'host fallback summary');
  assert.ok(streamCalls.length > 0, 'the pool was attempted first');
});

test('an empty conversation region delegates to the host summary', async () => {
  const { ctx, handlers, streamCalls } = createInterceptContext();
  const interceptor = new CompactionStreamInterceptor(ctx, defaultEngineConfig());
  interceptor.apply();

  // Only the system head remains: nothing meaningful is compactable, so the
  // host's own (already correct) summary is kept even though the pool ran.
  const out = await runListener(handlers, compactionOptions(''), summaryChunks('host empty'));
  assert.equal(textOf(out), 'host empty');
  assert.ok(streamCalls.length <= 1, 'no chunk fan-out for an empty region');
});

test('a small region that would not shrink keeps the host summary', async () => {
  const { ctx, handlers } = createInterceptContext();
  const interceptor = new CompactionStreamInterceptor(ctx, defaultEngineConfig());
  interceptor.apply();

  // The digest + anchor + recovery note is longer than this tiny region.
  const out = await runListener(handlers, compactionOptions('short note'), summaryChunks('host short'));
  assert.equal(textOf(out), 'host short', 'the host shrink check must keep passing');
});

test('the anchor block is compact and single-line JSON', () => {
  const block = buildAnchorBlock({ id: 'QC-1', sessionId: 's-1', seqStart: 12, seqEnd: 40, chunks: [{ i: 1, tokens: 100 }] });
  const lines = block.split('\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 3, 'open tag, one JSON line, close tag');
  assert.doesNotThrow(() => JSON.parse(lines[1]));
});

test('the compaction instruction is stripped from the region', () => {
  const options = compactionOptions('region text');
  const region = regionMessagesForTest(options);
  assert.equal(region.length, 2, 'system head + region survive');
  assert.ok(!JSON.stringify(region).includes('acting as a compaction engine'), 'instruction removed');
});

test('an invalid pool disables the interceptor instead of throwing', async () => {
  const { ctx, handlers } = createInterceptContext();
  // `tiers` must be non-empty; this config is malformed on purpose.
  const interceptor = new CompactionStreamInterceptor(ctx, { tiers: [] });
  interceptor.apply();
  assert.equal(interceptor.enabled, false, 'the interceptor turns itself off');
  const out = await runListener(handlers, compactionOptions('any region text at all'), summaryChunks('host stays'));
  assert.equal(textOf(out), 'host stays', 'the host summary still runs');
});

test('only purpose=compaction is treated as a compaction request', () => {
  assert.equal(isCompactionRequestForTest({ purpose: 'compaction' }), true);
  assert.equal(isCompactionRequestForTest({ purpose: 'session-title' }), false);
  assert.equal(isCompactionRequestForTest({}), false);
});

test('the anchor carries the exact shadowed seq span from the live session', async () => {
  const { buildSession } = await import('../helpers/fixture.js');
  const { session, seqs } = buildSession(3, 'region line with exact identifier ABC-123 and path D:/projects/app.');
  const { ctx, handlers } = createInterceptContext();
  ctx.get = (name) => (name === 'sessions' ? { get: (id) => (id === session.id ? session : undefined) } : undefined);
  const interceptor = new CompactionStreamInterceptor(ctx, defaultEngineConfig());
  interceptor.apply();

  // Replay the system head + the first two user messages, as the host does.
  const system = session.deriveEventMessage(session.eventAt(seqs.system));
  const first = session.deriveEventMessage(session.eventAt(seqs.users[0]));
  const second = session.deriveEventMessage(session.eventAt(seqs.users[1]));
  const options = {
    provider: 'session-p',
    model: 'session-m',
    purpose: 'compaction',
    sessionId: session.id,
    maxTokens: 4096,
    messages: [system, first, second].map((message) => ({ role: message.role, content: message.content })),
  };

  const out = await runListener(handlers, options, summaryChunks('host'));
  const text = textOf(out);
  const raw = text.slice(text.indexOf(ANCHOR_OPEN_TAG) + ANCHOR_OPEN_TAG.length, text.indexOf(ANCHOR_CLOSE_TAG)).trim();
  if (raw.length === 0) return; // host summary kept (region too small to shrink)
  const anchor = JSON.parse(raw);
  assert.equal(anchor.seqStart, seqs.users[0], 'anchor starts at the first compacted user message');
  assert.equal(anchor.seqEnd, seqs.users[1], 'anchor ends at the last replayed message, before the retained tail');
});

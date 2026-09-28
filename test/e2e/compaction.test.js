/**
 * End-to-end compaction via the engine over a real seeded Session: the full
 * durable transaction, chunking/merge, cooldown -> degradation -> fallback,
 * and the built-in shrink check.
 * @module dsh-quilt-compact/test/e2e/compaction
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompactionChainEngine } from '../../lib/index.js';
import {
  createTestContext,
  buildSession,
  agentFor,
  defaultEngineConfig,
} from '../helpers/fixture.js';

function engineFor(ctx, config) {
  return new CompactionChainEngine(ctx, config);
}

test('compactRegion commits the full durable transaction on a healthy pool', async () => {
  const { ctx, llm } = createTestContext({});
  const engine = engineFor(ctx, defaultEngineConfig());
  const { session, seqs } = buildSession(3);
  const agent = agentFor(session);
  const result = await engine.compactRegion(seqs.users[0], seqs.users[1], agent, undefined);

  assert.equal(result.shadowedSeqs.length, 2);
  const events = session.snapshotEvents().map((event) => event.type);
  assert.ok(events.includes('compaction/start'));
  assert.ok(events.includes('compaction/summary'));
  assert.ok(events.includes('compaction/end'));
  // The checkpoint node replaced the two user messages.
  assert.equal(session.surface.nodes.length, 3);
  const summaryEvent = session.snapshotEvents().find((event) => event.type === 'compaction/summary');
  assert.equal(summaryEvent.data.provider, 'p1');
  assert.equal(summaryEvent.data.model, 'm1');
  assert.equal(summaryEvent.data.llmStreamCall, true);
  assert.ok(summaryEvent.data.shadowedSeqs.length === 2);
  // Shrink check passed: framed checkpoint is smaller than the shadowed region.
  assert.ok(result.shadowedTokenCount > 0);
  // The region fits one chunk: exactly ONE call, no merge ("一次完成").
  assert.equal(llm.calls.length, 1, 'single-chunk region completes in one call');
});

test('a large region is chunked, summarized per chunk, and merged', async () => {
  const manyLines = Array.from(
    { length: 300 },
    (_, index) => `line-${index} about the project config and build steps with exact paths and decisions `.repeat(2),
  ).join('\n');
  const { ctx, llm } = createTestContext({ contextWindow: 1600 }); // chunkTokens = 1280
  const engine = engineFor(ctx, defaultEngineConfig());
  const { session, seqs } = buildSession(2, manyLines);
  const agent = agentFor(session);
  const result = await engine.compactRegion(seqs.users[0], seqs.users[1], agent, undefined);

  const summaryEvent = session.snapshotEvents().find((event) => event.type === 'compaction/summary');
  assert.ok(summaryEvent.data.shadowedSeqs.length === 2);
  assert.ok(result.summary[0].text.startsWith('digest('), 'final summary is a model digest');
  // Multiple chunk jobs plus one merge job went through the pool.
  const chunkCalls = llm.calls.filter((call) => call.purpose === 'compaction');
  assert.ok(chunkCalls.length >= 3, `expected chunk+merge calls, got ${chunkCalls.length}`);
  const mergeCall = chunkCalls.find((call) => String(call.messages[0].content[0].text).startsWith('--- digest 1 ---'));
  assert.ok(mergeCall, 'a merge job digested the chunk summaries');
  assert.equal(summaryEvent.data.model, 'm1', 'merge call produced the final summary');
});

test('pool failure -> cooldown -> tier degradation -> session-model fallback', async () => {
  const { ctx, llm } = createTestContext({
    behaviors: {
      'p1/m1': { kind: 'fail', code: 'RATE_LIMIT', message: 'quota' },
      'p1/m2': { kind: 'fail', code: 'SERVER', message: 'down' },
      'p2/m3': { kind: 'fail', code: 'SERVER', message: 'down' },
    },
  });
  const engine = engineFor(ctx, defaultEngineConfig());
  const { session, seqs } = buildSession(2);
  const agent = agentFor(session, { provider: 'session-p', model: 'session-m' });
  const result = await engine.compactRegion(seqs.users[0], seqs.users[1], agent, undefined);

  const store = await engine.ensureStore();
  assert.deepEqual(store.keys().sort(), ['p1/m1', 'p1/m2', 'p2/m3'], 'every failed route was cooled');
  for (const key of store.keys()) {
    assert.ok(store.cooldownUntil(key) > Date.now() - 1000, `${key} cooled into the future`);
  }
  const summaryEvent = session.snapshotEvents().find((event) => event.type === 'compaction/summary');
  assert.equal(summaryEvent.data.provider, 'session-p', 'fallback wrote the summary');
  assert.equal(summaryEvent.data.model, 'session-m');
  assert.equal(result.shadowedSeqs.length, 2);
  assert.equal(session.surface.nodes.length, 2, 'system + one checkpoint node');
  // The fallback DIRECTLY called the default compression plugin: it replayed
  // the original conversation prefix (system first) and appended the default
  // plugin's compaction instruction as the FINAL user message (KV-cache reuse),
  // and the whole region was covered by that ONE call.
  const fallbackCall = llm.calls.at(-1);
  assert.equal(fallbackCall.provider, 'session-p');
  assert.equal(fallbackCall.model, 'session-m');
  assert.equal(fallbackCall.messages[0].role, 'system', 'conversation prefix replayed for KV-cache reuse');
  assert.match(
    String(fallbackCall.messages.at(-1).content[0].text),
    /^You are now acting as a compaction engine/,
    'default plugin appended its compaction instruction as the final user message',
  );
  assert.equal(llm.calls.filter((call) => call.provider === 'session-p').length, 1, 'fallback is exactly one call');
});

test('fallback disabled -> compaction fails and the transaction records the error', async () => {
  const { ctx } = createTestContext({
    behaviors: { 'p1/m1': { kind: 'fail' }, 'p1/m2': { kind: 'fail' }, 'p2/m3': { kind: 'fail' } },
  });
  const engine = engineFor(ctx, defaultEngineConfig({ fallbackToSessionModel: false }));
  const { session, seqs } = buildSession(2);
  const agent = agentFor(session);
  await assert.rejects(
    engine.compactRegion(seqs.users[0], seqs.users[1], agent, undefined),
    /fallback is disabled/,
  );
  const endEvent = session.snapshotEvents().find((event) => event.type === 'compaction/end');
  assert.ok(endEvent, 'compaction/end appended after failure');
  assert.ok(endEvent.data.error.includes('fallback is disabled'), 'error chain recorded');
});

test('a summary larger than the region fails the built-in shrink check', async () => {
  const { ctx } = createTestContext({
    behaviors: { 'p1/m1': { kind: 'ok', text: 'BIG '.repeat(20_000) } },
  });
  const engine = engineFor(ctx, defaultEngineConfig());
  const { session, seqs } = buildSession(2);
  const agent = agentFor(session);
  await assert.rejects(
    engine.compactRegion(seqs.users[0], seqs.users[1], agent, undefined),
    /summary is not smaller than the shadowed content/,
  );
  const endEvent = session.snapshotEvents().find((event) => event.type === 'compaction/end');
  assert.ok(endEvent.data.error.includes('not smaller'), 'shrink failure recorded on compaction/end');
});

test('cancellation propagates without writing cooldowns', async () => {
  const { ctx, llm } = createTestContext({ behaviors: { 'p1/m1': { kind: 'fail', code: 'ABORTED' } }, latencyMs: 30 });
  const engine = engineFor(ctx, defaultEngineConfig());
  const { session, seqs } = buildSession(2);
  const agent = agentFor(session);
  const controller = new AbortController();
  const run = engine.compactRegion(seqs.users[0], seqs.users[1], agent, controller.signal);
  setTimeout(() => controller.abort(new Error('cancelled')), 5);
  await assert.rejects(run, /cancelled/);
  const store = await engine.ensureStore();
  assert.deepEqual(store.keys(), [], 'abort is not a model failure: no cooldown written');
});

test('debug logs identify every model call, its input segment, and output stats', async () => {
  const manyLines = Array.from(
    { length: 120 },
    (_, index) => `line-${index} about the project config and build steps with exact paths `.repeat(2),
  ).join('\n');
  const { ctx, logger } = createTestContext({ contextWindow: 1600 });
  const engine = engineFor(ctx, defaultEngineConfig({
    preprocessing: { headMiddleTail: { thresholdChars: 1_000_000, headChars: 4096, tailChars: 1024 } },
  }));
  const { session, seqs } = buildSession(1, manyLines);
  const agent = agentFor(session);
  await engine.compactRegion(seqs.users[0], seqs.users[0], agent, undefined);

  const debugLines = logger.records
    .filter(([level]) => level === 'debug')
    .map(([, message]) => String(message));

  // Every call is recorded with route, job, input segment stats, and a fingerprint.
  const callLines = debugLines.filter((line) => line.startsWith('compaction-chain call: '));
  assert.ok(callLines.length >= 3, `expected chunk + merge calls, got ${callLines.length}`);
  const chunkCall = callLines.find((line) => line.includes('job=chunk 1'));
  assert.ok(chunkCall, 'chunk call logged');
  assert.match(chunkCall, /route=p1\/m1/);
  assert.match(chunkCall, /inputChars=\d+/);
  assert.match(chunkCall, /inputTokens~=\d+/);
  assert.match(chunkCall, /lines=\d+\.\.\d+/, 'chunk segment line range recorded');
  assert.match(chunkCall, /sha=[0-9a-f]{12}/);
  assert.match(chunkCall, /preview="[^"]{1,80}"/, 'short preview only');
  const okLines = debugLines.filter((line) => line.startsWith('compaction-chain call ok: '));
  assert.ok(okLines.some((line) => line.includes('outputChars=') && line.includes('durationMs=')), 'output stats recorded');

  // Batch summary records routes, call counts, failures, and the fallback flag.
  const batchLine = logger.records
    .filter(([level]) => level === 'info')
    .map(([, message]) => String(message))
    .find((line) => line.startsWith('compaction-chain batch: '));
  assert.ok(batchLine, 'batch summary logged');
  assert.match(batchLine, /byRoute=p1\/m1:\d+/);
  assert.match(batchLine, /failures=\d+/);
  assert.match(batchLine, /fallback=false/);

  // Privacy: no log line may carry a contiguous 200+ char slice of the raw
  // region text (only <=80-char previews and fingerprints are ever emitted).
  const allLogText = logger.records.map(([, message]) => String(message)).join('\n');
  assert.ok(!allLogText.includes(manyLines.slice(0, 200)), 'full session content never enters logs');
});

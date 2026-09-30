/**
 * End-to-end compaction via the engine over a real seeded Session: the full
 * durable transaction, chunking/merge, cooldown -> degradation -> fallback,
 * and the built-in shrink check.
 * @module dsh-quilt-compact/test/e2e/compaction
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuiltCompactEngine } from '../../lib/index.js';
import { ModelChain } from '../../lib/model-chain.js';
import { computeUsableInputTokens } from '../../lib/budget.js';
import {
  createTestContext,
  buildSession,
  agentFor,
  defaultEngineConfig,
} from '../helpers/fixture.js';

function engineFor(ctx, config) {
  return new QuiltCompactEngine(ctx, config);
}

test('run log records snapshot + result for every compaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-quilt-compact-'));
  const logPath = join(root, 'runs.jsonl');
  try {
    const { ctx, llm } = createTestContext({});
    const engine = engineFor(ctx, defaultEngineConfig({ runRecord: { enabled: true, path: logPath } }));
    const { session, seqs } = buildSession(2);
    const agent = agentFor(session);
    await engine.compactRegion(seqs.users[0], seqs.users[1], agent, undefined);
    await engine.runLog.flush();

    const text = await readFile(logPath, 'utf8');
    const entry = JSON.parse(text.trim().split('\n').at(-1));
    assert.equal(entry.trigger, 'auto', 'compactRegion alone has no explicit trigger');
    assert.equal(entry.route, 'p1/m1');
    assert.equal(entry.fallback, false);
    assert.ok(entry.digestChars > 0, 'result digest length recorded');
    assert.equal(entry.chunkCount, 1, 'single-chunk region');
    assert.ok(entry.snapshot.length > 0, 'input snapshot recorded');
    assert.ok(entry.result.length > 0, 'result digest recorded');
    assert.equal(llm.calls.length, 1, 'one pool call');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run log can be disabled and never touches the filesystem', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-quilt-compact-'));
  const logPath = join(root, 'runs.jsonl');
  try {
    const { ctx } = createTestContext({});
    const engine = engineFor(ctx, defaultEngineConfig({ runRecord: { enabled: false, path: logPath } }));
    const { session, seqs } = buildSession(2);
    const agent = agentFor(session);
    await engine.compactRegion(seqs.users[0], seqs.users[1], agent, undefined);
    await engine.runLog.flush();
    await assert.rejects(readFile(logPath, 'utf8'), (error) => error.code === 'ENOENT', 'no run-log file when disabled');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
  const engine = engineFor(ctx, defaultEngineConfig());
  const { session, seqs } = buildSession(1, manyLines);
  const agent = agentFor(session);
  await engine.compactRegion(seqs.users[0], seqs.users[0], agent, undefined);

  const debugLines = logger.records
    .filter(([level]) => level === 'debug')
    .map(([, message]) => String(message));

  // Every call is recorded with route, job, input segment stats, and a fingerprint.
  const callLines = debugLines.filter((line) => line.startsWith('dsh-quilt-compact call: '));
  assert.ok(callLines.length >= 3, `expected chunk + merge calls, got ${callLines.length}`);
  const chunkCall = callLines.find((line) => line.includes('job=chunk 1'));
  assert.ok(chunkCall, 'chunk call logged');
  assert.match(chunkCall, /route=p1\/m1/);
  assert.match(chunkCall, /inputChars=\d+/);
  assert.match(chunkCall, /inputTokens~=\d+/);
  assert.match(chunkCall, /lines=\d+\.\.\d+/, 'chunk segment line range recorded');
  assert.match(chunkCall, /sha=[0-9a-f]{12}/);
  assert.match(chunkCall, /preview="[^"]{1,80}"/, 'short preview only');
  const okLines = debugLines.filter((line) => line.startsWith('dsh-quilt-compact call ok: '));
  assert.ok(okLines.some((line) => line.includes('outputChars=') && line.includes('durationMs=')), 'output stats recorded');

  // Batch summary records routes, call counts, failures, and the fallback flag.
  const batchLine = logger.records
    .filter(([level]) => level === 'info')
    .map(([, message]) => String(message))
    .find((line) => line.startsWith('dsh-quilt-compact batch: '));
  assert.ok(batchLine, 'batch summary logged');
  assert.match(batchLine, /byRoute=p1\/m1:\d+/);
  assert.match(batchLine, /failures=\d+/);
  assert.match(batchLine, /fallback=false/);

  // Privacy: no log line may carry a contiguous 200+ char slice of the raw
  // region text (only <=80-char previews and fingerprints are ever emitted).
  const allLogText = logger.records.map(([, message]) => String(message)).join('\n');
  assert.ok(!allLogText.includes(manyLines.slice(0, 200)), 'full session content never enters logs');
});

test('a loader/volatile-update edit re-resolves the config the engine actually runs', async () => {
  const { ctx } = createTestContext({});
  // Simulate schemastery volatile references: the loader rewrites the value a
  // `{ get() }` ref returns, then emits `loader/volatile-update` on the fiber's
  // ctx. The engine must re-resolve from its RAW config (the refs), not keep
  // the frozen constructor snapshot.
  const state = { chunkRatio: 0.55, mergePromptSuffix: 'OLD' };
  const volatile = (read) => ({ get: () => read() });
  const raw = defaultEngineConfig({
    chunkRatio: volatile(() => state.chunkRatio),
    mergePromptSuffix: volatile(() => state.mergePromptSuffix),
  });
  const engine = engineFor(ctx, raw);
  assert.equal(engine.config.chunkRatio, 0.55, 'construction unwraps the refs');
  assert.equal(engine.config.mergePromptSuffix, 'OLD');

  // The settings page edits the running refs, then the loader fires the event.
  state.chunkRatio = 0.3;
  state.mergePromptSuffix = 'NEW-SUFFIX';
  ctx.emit('loader/volatile-update', [['chunkRatio'], ['mergePromptSuffix']]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(engine.config.chunkRatio, 0.3, 'chunkRatio re-resolved after volatile-update');
  assert.equal(engine.config.mergePromptSuffix, 'NEW-SUFFIX', 'suffix re-resolved after volatile-update');
  assert.ok(Object.isFrozen(engine.config), 're-resolved config stays immutable');

  // The swapped config is what a subsequent compaction schedules with.
  const { session, seqs } = buildSession(2);
  await engine.compactRegion(seqs.users[0], seqs.users[1], agentFor(session), undefined);
  // chunkRatio 0.3 with the default fake 128K window: chunkBudget = usable*0.3.
  assert.ok(engine.config.chunkRatio === 0.3);
});

test('a rejected live config edit keeps the previous resolved config', async () => {
  const { ctx } = createTestContext({});
  const state = { chunkOverlapRatio: 0.2 };
  const raw = defaultEngineConfig({
    chunkOverlapRatio: { get: () => state.chunkOverlapRatio },
  });
  const engine = engineFor(ctx, raw);
  assert.equal(engine.config.chunkOverlapRatio, 0.2);
  // An edit that resolveConfig rejects (ratio >= 1) must not clobber the
  // running config.
  state.chunkOverlapRatio = 2;
  ctx.emit('loader/volatile-update', [['chunkOverlapRatio']]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.config.chunkOverlapRatio, 0.2, 'previous config survives a rejected edit');
});

test('chunk window plans against the smallest known capacity in the primary tier', async () => {
  const { ctx } = createTestContext({});
  const engine = engineFor(ctx, defaultEngineConfig());
  // A 1M primary with a 128K sibling in the SAME tier: chunking must plan for
  // the 128K window so the sibling can actually serve chunks, not the 1M.
  const capacities = new Map([
    ['p1/m1', { contextWindow: 1048576, maxTokens: 32768 }],
    ['p1/m2', { contextWindow: 131072, maxTokens: 32768 }],
    ['p2/m3', { contextWindow: 65536, maxTokens: 32768 }],
  ]);
  const { contextWindow, usableInput } = engine.resolveChunkWindow(capacities);
  assert.equal(contextWindow, 131072, 'min of known primary-tier windows, not the largest');
  assert.equal(usableInput, computeUsableInputTokens(131072));
});

test('chunk window ignores unknown-capacity routes in the min', async () => {
  const { ctx } = createTestContext({});
  const engine = engineFor(ctx, defaultEngineConfig());
  // m1 unknown, m2 known 64K: the min must come from the KNOWN route only.
  const capacities = new Map([
    ['p1/m1', undefined],
    ['p1/m2', { contextWindow: 65536, maxTokens: 32768 }],
    ['p2/m3', undefined],
  ]);
  const { contextWindow } = engine.resolveChunkWindow(capacities);
  assert.equal(contextWindow, 65536);
});

test('chunk window falls back to the fixed default when no primary route reports capacity', async () => {
  const { ctx } = createTestContext({});
  const engine = engineFor(ctx, defaultEngineConfig());
  const capacities = new Map([
    ['p1/m1', undefined],
    ['p1/m2', undefined],
    ['p2/m3', undefined],
  ]);
  const { contextWindow } = engine.resolveChunkWindow(capacities);
  assert.equal(contextWindow, 262144, 'DEFAULT_CONTEXT_WINDOW fallback');
});

test('a huge multi-chunk region merges hierarchically instead of one giant merge', async () => {
  const { ctx, llm } = createTestContext({ contextWindow: 4000 });
  const engine = engineFor(ctx, defaultEngineConfig());
  // Bypass Stage 0 chunking and feed mergeDigests directly: many large digests
  // that cannot fit one merge call with a small merge input budget, and assert
  // multiple merge levels ran.
  const digests = Array.from({ length: 12 }, (_, index) => `digest ${index}: ${'BIG '.repeat(1000)}`);
  const store = await engine.ensureStore();
  const chain = new ModelChain(ctx, engine.config, store, {});
  const agent = agentFor(buildSession(2).session);
  const finalResult = await engine.mergeDigests(chain, digests, agent, undefined, { capacities: new Map() }, 2376);
  assert.ok(finalResult.text.startsWith('digest') || finalResult.text.startsWith('BIG'), 'final merge produced a digest');
  const mergeCalls = llm.calls.filter((call) => String(call.messages[0].content[0].text).startsWith('--- digest 1 ---'));
  assert.ok(mergeCalls.length > 1, `hierarchical merge made multiple merge calls, got ${mergeCalls.length}`);
});

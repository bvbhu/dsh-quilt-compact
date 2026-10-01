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

test('run log records attribution + result (reference, no snapshot) for every compaction', async () => {
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
    // Privacy: NO conversation text is written — the record references it.
    assert.equal(entry.snapshotChars, 0, 'no snapshot by default');
    assert.equal(entry.snapshot, undefined, 'no embedded input text');
    assert.ok(entry.ref?.sessionId, 'the session is referenced');
    assert.ok(Array.isArray(entry.ref?.seqs) && entry.ref.seqs.length > 0, 'the shadowed span seqs are referenced');
    assert.ok(entry.result.length > 0, 'result digest recorded');
    // Attribution: which model handled which chunk.
    assert.ok(Array.isArray(entry.chunks) && entry.chunks.length === 1, 'per-chunk attribution recorded');
    assert.equal(entry.chunks[0].model, 'p1/m1');
    assert.ok(Number.isInteger(entry.chunks[0].lineStart), 'chunk line range recorded');
    assert.ok(Number.isInteger(entry.chunks[0].tokens), 'chunk token count recorded');
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

test('a large region is chunked, summarized per chunk, and merged in one call', async () => {
  const manyLines = Array.from(
    { length: 300 },
    (_, index) => `line-${index} about the project config and build steps with exact paths and decisions `.repeat(2),
  ).join('\n');
  // Chunk routes report 8000 (many chunks); `mergeMaxContextTokens: 8000`
  // sizes the single-level merge window to the main pool's own window, so the
  // merge runs on the main pool instead of falling back (v7: without the knob
  // the default 128k floor would outsize every route and fall straight back).
  const { ctx, llm } = createTestContext({ contextWindow: 8000 });
  const engine = engineFor(ctx, defaultEngineConfig({
    mergeMaxContextTokens: 8000,
  }));
  const { session, seqs } = buildSession(2, manyLines);
  const agent = agentFor(session);
  const result = await engine.compactRegion(seqs.users[0], seqs.users[1], agent, undefined);

  const summaryEvent = session.snapshotEvents().find((event) => event.type === 'compaction/summary');
  assert.ok(summaryEvent.data.shadowedSeqs.length === 2);
  assert.ok(result.summary[0].text.startsWith('digest('), 'final summary is a model digest');
  // Multiple chunk jobs plus ONE single-level merge job went through the pool.
  const chunkCalls = llm.calls.filter((call) => call.purpose === 'compaction');
  assert.ok(chunkCalls.length >= 3, `expected chunk+merge calls, got ${chunkCalls.length}`);
  const mergeCall = chunkCalls.find((call) => String(call.messages[0].content[0].text).startsWith('--- digest 1 ---'));
  assert.ok(mergeCall, 'a single-level merge job digested the chunk summaries');
  const mergeCalls = chunkCalls.filter((call) => String(call.messages[0].content[0].text).startsWith('--- digest 1 ---'));
  assert.equal(mergeCalls.length, 1, 'exactly one single-level merge call');
});

test('run log records which route entered cooldown and with what error', async () => {
  // The user's diagnostic ask: "记录进入冷却的报错". Every cooldown WRITE must
  // be attributable — route, job, the flattened error, until when. An
  // aggregate attempt count cannot tell a real provider error from a
  // mis-attributed one; this record can.
  const root = await mkdtemp(join(tmpdir(), 'dsh-quilt-compact-'));
  const logPath = join(root, 'runs.jsonl');
  try {
    const { ctx, llm } = createTestContext({
      behaviors: {
        'p1/m1': { kind: 'fail', code: 'RATE_LIMIT', message: 'quota exceeded' },
        'p1/m2': { kind: 'fail', code: 'SERVER', message: 'down' },
        'p2/m3': { kind: 'ok' },
      },
    });
    const engine = engineFor(ctx, defaultEngineConfig({ runRecord: { enabled: true, path: logPath } }));
    const { session, seqs } = buildSession(3);
    const agent = agentFor(session, { provider: 'session-p', model: 'session-m' });
    await engine.compactRegion(seqs.users[0], seqs.users[1], agent, undefined);
    await engine.runLog.flush();

    const entry = JSON.parse((await readFile(logPath, 'utf8')).trim().split('\n').at(-1));
    assert.ok(Array.isArray(entry.cooldowns) && entry.cooldowns.length >= 2, 'cooldown events recorded');
    const failed = entry.cooldowns.filter((c) => c.error);
    assert.ok(failed.some((c) => c.model === 'p1/m1' && /quota exceeded/.test(c.error)), 'the failing route and its error are recorded');
    assert.ok(failed.some((c) => c.model === 'p1/m2' && /down/.test(c.error)), 'each cooled route is individually attributed');
    assert.ok(failed.every((c) => Number.isInteger(c.until) && c.until > Date.now() - 1000), 'cooldown expiry timestamps recorded');
    assert.ok(failed.every((c) => c.job), 'the job that triggered the cooldown is named');
    assert.ok(failed.every((c) => typeof c.hours === 'number'), 'cooldown duration recorded');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  // The fallback DELEGATES to dsh-compaction-basic's official summarizer: it
  // replayed the original conversation prefix (system first) and appended
  // basic's own compaction instruction as the FINAL user message (KV-cache
  // reuse), and the whole region was covered by that ONE call.
  const fallbackCall = llm.calls.at(-1);
  assert.equal(fallbackCall.provider, 'session-p');
  assert.equal(fallbackCall.model, 'session-m');
  assert.equal(fallbackCall.messages[0].role, 'system', 'conversation prefix replayed for KV-cache reuse');
  assert.match(
    String(fallbackCall.messages.at(-1).content[0].text),
    /^You are now acting as a compaction engine/,
    'basic\'s own compaction instruction is the final user message',
  );
  assert.equal(llm.calls.filter((call) => call.provider === 'session-p').length, 1, 'fallback is exactly one call');
});

test('all routes cooled -> cooldowns are cleared and slicing retries once', async () => {
  // A pool-wide cooldown used to park compaction until the earliest route
  // expired. The engine now clears every cooldown once and re-slices, so a
  // transient pool-wide failure costs one extra attempt instead of one lost
  // compaction. Here all routes are pre-cooled; the models themselves are
  // healthy, so the retry after the reset succeeds.
  const { ctx, llm } = createTestContext({});
  const engine = engineFor(ctx, defaultEngineConfig());
  const { session, seqs } = buildSession(2);
  const agent = agentFor(session, { provider: 'session-p', model: 'session-m' });

  const store = await engine.ensureStore();
  const future = Date.now() + 3 * 3600 * 1000;
  for (const key of ['p1/m1', 'p1/m2', 'p2/m3']) await store.applyCooldown(key, future);
  assert.equal(engine.allRoutesCooled({ tiers: engine.config.tiers, store }), true, 'the whole pool is cooled first');

  await engine.compactRegion(seqs.users[0], seqs.users[1], agent, undefined);

  // The pool was reset and a pool model (not the session fallback) served it.
  const summaryEvent = session.snapshotEvents().find((event) => event.type === 'compaction/summary');
  assert.equal(summaryEvent.data.provider, 'p1', 'a pool route served the retry');
  assert.equal(summaryEvent.data.model, 'm1');
  assert.equal(llm.calls.filter((call) => call.provider === 'session-p').length, 0, 'no session fallback needed');
  const errorLines = ctx.logger.records
    .filter(([level]) => level === 'warn')
    .map(([, message]) => String(message));
  assert.ok(
    errorLines.some((line) => line.includes('every pool route was cooled') && line.includes('cleared all cooldowns')),
    'the reset is logged (it is a real event, not a silent retry)',
  );
});

test('pool unusable even after a cooldown reset -> default compression fallback', async () => {
  // Last resort: no chunk can be sliced at all, even after the cooldown reset
  // (pickChunkModel pinned to undefined models an exhausted pool). The
  // compaction still produces a summary through the default plugin instead of
  // throwing the old "no usable model at slice time" error.
  const { ctx, llm } = createTestContext({
    behaviors: {
      'p1/m1': { kind: 'fail', message: 'boom' },
      'p1/m2': { kind: 'fail', message: 'boom' },
      'p2/m3': { kind: 'fail', message: 'boom' },
    },
  });
  const engine = engineFor(ctx, defaultEngineConfig());
  const { session, seqs } = buildSession(2);
  const agent = agentFor(session, { provider: 'session-p', model: 'session-m' });

  const store = await engine.ensureStore();
  const future = Date.now() + 3 * 3600 * 1000;
  for (const key of ['p1/m1', 'p1/m2', 'p2/m3']) await store.applyCooldown(key, future);

  const original = ModelChain.prototype.pickChunkModel;
  ModelChain.prototype.pickChunkModel = () => undefined;
  try {
    await engine.compactRegion(seqs.users[0], seqs.users[1], agent, undefined);
  } finally {
    ModelChain.prototype.pickChunkModel = original;
  }

  // The default plugin wrote the summary (pool routes all failed).
  const summaryEvent = session.snapshotEvents().find((event) => event.type === 'compaction/summary');
  assert.equal(summaryEvent.data.provider, 'session-p', 'the default plugin wrote the summary');
  assert.equal(summaryEvent.data.model, 'session-m');
  const fallbackCalls = llm.calls.filter((call) => call.provider === 'session-p');
  assert.equal(fallbackCalls.length, 1, 'exactly one default-compression call');
  assert.equal(
    fallbackCalls[0].messages[0].role,
    'system',
    'the default plugin replays the conversation prefix (KV-cache reuse)',
  );
  const warnLines = ctx.logger.records
    .filter(([level]) => level === 'warn')
    .map(([, message]) => String(message));
  assert.ok(
    warnLines.some((line) => line.includes('model pool cannot serve this compaction')),
    'the fallback is logged with the reason',
  );
  assert.ok(
    warnLines.some((line) => line.includes('every pool route was cleared') || line.includes('cleared all cooldowns')),
    'the reset attempt is logged',
  );
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

test('a failed compaction logs the reason and records a failed run entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-quilt-compact-'));
  const logPath = join(root, 'runs.jsonl');
  try {
    const { ctx, logger } = createTestContext({
      behaviors: {
        'p1/m1': { kind: 'fail', message: 'quota' },
        'p1/m2': { kind: 'fail', message: 'down' },
        'p2/m3': { kind: 'fail', message: 'down' },
      },
    });
    const engine = engineFor(ctx, defaultEngineConfig({ fallbackToSessionModel: false, runRecord: { enabled: true, path: logPath } }));
    const { session, seqs } = buildSession(2);
    const agent = agentFor(session);
    await assert.rejects(
      engine.compactRegion(seqs.users[0], seqs.users[1], agent, undefined),
      /fallback is disabled/,
    );
    await engine.runLog.flush();

    const entry = JSON.parse((await readFile(logPath, 'utf8')).trim().split('\n').at(-1));
    assert.equal(entry.failed, true, 'the failure is IN the run log (not only successes)');
    assert.equal(entry.route, 'error');
    assert.equal(entry.trigger, 'auto');
    assert.equal(entry.attempts, 3, 'all three route attempts counted');
    assert.ok(entry.error.includes('fallback is disabled'), 'flattened reason in the record');
    assert.ok(entry.error.includes('attempts: p1/m1 x1'), 'per-route attempt summary in the reason');
    assert.ok(entry.stage0Lines > 0, 'region stats still recorded for the failed run');
    assert.equal(entry.result, '');

    const errorLines = logger.records
      .filter(([level]) => level === 'error')
      .map(([, message]) => String(message));
    assert.ok(
      errorLines.some((line) => line.includes('dsh-quilt-compact summarize failed') && line.includes('fallback is disabled')),
      'one error-level log line carries the reason',
    );
    // The SAME failure crosses the transaction boundary (compactSurfaceRegion
    // rethrows it), but the marker deduplicates: exactly one log line.
    assert.equal(
      errorLines.filter((line) => line.includes('fallback is disabled')).length,
      1,
      'a summarize-origin failure is logged once, not once per layer',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed manual compaction wraps the reason into the summary error', async () => {
  const { ctx } = createTestContext({
    behaviors: {
      'p1/m1': { kind: 'fail', message: 'quota' },
      'p1/m2': { kind: 'fail', message: 'down' },
      'p2/m3': { kind: 'fail', message: 'down' },
    },
  });
  const engine = engineFor(ctx, defaultEngineConfig({ fallbackToSessionModel: false }));
  const { session } = buildSession(2);
  // Manual compaction requires an idle session: close the fixture's open turn.
  session.append('turn/end', { turn: 1 });
  const agent = agentFor(session);
  // Minimal idle-agent stand-in: runMaintenance just runs the operation.
  agent.runMaintenance = async (run) => run(new AbortController().signal);
  await assert.rejects(
    engine.compactNow(agent, new AbortController().signal, undefined),
    (failure) => {
      assert.equal(failure.code, 'summary', 'the manual failure maps to the summary code');
      assert.match(
        failure.message,
        /manual compaction could not produce a smaller summary: .+fallback is disabled/s,
        'the message carries the underlying reason, not just the fixed classification',
      );
      assert.ok(failure.cause instanceof Error, 'the raw pipeline error rides along as the cause');
      return true;
    },
  );
});

test('a summary larger than the region fails the built-in shrink check', async () => {
  const { ctx, logger } = createTestContext({
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
  // The region-layer failure is thrown AFTER summarize returned, so it never
  // passes through recordSummarizeFailure — but it must still leave an
  // error-level log line with the flattened reason.
  const errorLines = logger.records
    .filter(([level]) => level === 'error')
    .map(([, message]) => String(message));
  assert.ok(
    errorLines.some((line) => line.includes('dsh-quilt-compact compaction failed') && line.includes('not smaller')),
    'region-layer failure logged at error level with the flattened reason',
  );
});

test('a region-layer failure records a failed run entry when the run log is enabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-quilt-compact-'));
  const logPath = join(root, 'runs.jsonl');
  try {
    const { ctx } = createTestContext({
      behaviors: { 'p1/m1': { kind: 'ok', text: 'BIG '.repeat(20_000) } },
    });
    const engine = engineFor(ctx, defaultEngineConfig({ runRecord: { enabled: true, path: logPath } }));
    const { session, seqs } = buildSession(2);
    const agent = agentFor(session);
    await assert.rejects(
      engine.compactRegion(seqs.users[0], seqs.users[1], agent, undefined),
      /not smaller/,
    );
    await engine.runLog.flush();

    const entry = JSON.parse((await readFile(logPath, 'utf8')).trim().split('\n').at(-1));
    assert.equal(entry.failed, true, 'the region-layer failure is IN the run log');
    assert.equal(entry.route, 'error');
    assert.ok(entry.error.includes('not smaller'), 'flattened reason in the record');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a manual region-layer failure logs the reason the host sentence hides', async () => {
  const { ctx, logger } = createTestContext({
    behaviors: { 'p1/m1': { kind: 'ok', text: 'BIG '.repeat(20_000) } },
  });
  const engine = engineFor(ctx, defaultEngineConfig());
  const { session } = buildSession(2);
  // Manual compaction requires an idle session: close the fixture's open turn.
  session.append('turn/end', { turn: 1 });
  const agent = agentFor(session);
  agent.runMaintenance = async (run) => run(new AbortController().signal);
  await assert.rejects(
    engine.compactNow(agent, new AbortController().signal, undefined),
    (failure) => {
      assert.equal(failure.code, 'summary', 'the shrink-check failure maps to the summary code');
      assert.match(failure.message, /manual compaction could not produce a smaller summary: .+not smaller/s);
      return true;
    },
  );
  // The host /compact command shows only the fixed sentence; the plugin must
  // leave the flattened reason in the log instead.
  const errorLines = logger.records
    .filter(([level]) => level === 'error')
    .map(([, message]) => String(message));
  assert.ok(
    errorLines.some((line) => line.includes('dsh-quilt-compact compaction failed') && line.includes('not smaller')),
    'manual region-layer failure logged with the reason, not only the fixed sentence',
  );
});

test('an entry-stage manual failure logs its cause in the log', async () => {
  const { ctx, logger } = createTestContext({});
  const engine = engineFor(ctx, defaultEngineConfig());
  const { session } = buildSession(2);
  // Manual compaction needs an idle session, but the fixture's turn is still
  // open: the entry check rejects BEFORE any summarization (no turn/end).
  const agent = agentFor(session);
  agent.runMaintenance = async (run) => run(new AbortController().signal);
  await assert.rejects(
    engine.compactNow(agent, new AbortController().signal, undefined),
    (failure) => {
      assert.equal(failure.code, 'busy', 'the open-turn rejection maps to the busy code');
      return true;
    },
  );
  const errorLines = logger.records
    .filter(([level]) => level === 'error')
    .map(([, message]) => String(message));
  assert.ok(
    errorLines.some((line) => line.includes('dsh-quilt-compact compaction failed') && line.includes('stage=entry') && line.includes('open turn')),
    'entry-stage failure logged with the cause, not only the host busy sentence',
  );
});

test('a RATE_LIMIT chunk failure retries per the provider retryPolicy and succeeds', async () => {
  // The provider's own retryPolicy (the one dsh-llm-retry applies to the agent
  // loop) must govern plugin calls too: a 429 backs off and retries instead of
  // instantly cooling the route. The fake provider declares maxRetries 3.
  const { ctx, llm } = createTestContext({
    behaviors: { 'p1/m1': { kind: 'fail', code: 'RATE_LIMIT', message: '429: inference exceeds tpm/rpm limit', times: 2 } },
    retryPolicies: {
      p1: { mode: 'normal', maxRetries: 3, retryableCodes: ['RATE_LIMIT', 'SERVER'], initialDelayMs: 5, maxDelayMs: 5, jitterRatio: 0 },
    },
  });
  const engine = engineFor(ctx, defaultEngineConfig());
  const { session, seqs } = buildSession(2);
  const agent = agentFor(session, { provider: 'session-p', model: 'session-m' });

  await engine.compactRegion(seqs.users[0], seqs.users[1], agent, undefined);

  // The route recovered inside the policy: 2 failed attempts + 1 success, and
  // NO cooldown was ever written (the policy absorbed the rate limit).
  assert.equal(llm.calls.filter((call) => call.provider === 'p1').length, 3, 'two retries then success');
  const store = await engine.ensureStore();
  assert.deepEqual(store.keys(), [], 'no cooldown written while the policy still has retries left');
  const warnLines = ctx.logger.records.filter(([level]) => level === 'warn').map(([, message]) => String(message));
  assert.ok(
    warnLines.filter((line) => line.includes('call retry')).length === 2,
    'each retry logs one warn line with the code and delay',
  );
  const summaryEvent = session.snapshotEvents().find((event) => event.type === 'compaction/summary');
  assert.equal(summaryEvent.data.provider, 'p1', 'the retried route served the compaction');
});

test('exhausting the provider retryPolicy still cools the route', async () => {
  // After the provider policy's retries are spent, the failure IS terminal:
  // the model chain cools the route exactly as before, with the LAST error.
  const { ctx, llm } = createTestContext({
    behaviors: { 'p1/m1': { kind: 'fail', code: 'RATE_LIMIT', message: '429: inference exceeds tpm/rpm limit' } },
    retryPolicies: {
      p1: { mode: 'normal', maxRetries: 2, retryableCodes: ['RATE_LIMIT'], initialDelayMs: 2, maxDelayMs: 2, jitterRatio: 0 },
    },
  });
  const engine = engineFor(ctx, defaultEngineConfig());
  const { session, seqs } = buildSession(2);
  const agent = agentFor(session, { provider: 'session-p', model: 'session-m' });

  await engine.compactRegion(seqs.users[0], seqs.users[1], agent, undefined);

  // 1 initial + 2 retries on m1, then the failure terminal -> cooldown +
  // requeue, and the sibling tier model (p1/m2) serves the chunk.
  assert.equal(llm.calls.filter((call) => call.provider === 'p1' && call.model === 'm1').length, 3, 'the policy was honored before the cooldown');
  const store = await engine.ensureStore();
  assert.ok(store.cooldownUntil('p1/m1') > Date.now(), 'the exhausted route is cooled');
  const summaryEvent = session.snapshotEvents().find((event) => event.type === 'compaction/summary');
  assert.equal(summaryEvent.data.provider, 'p1', 'a sibling tier model served the compaction');
  assert.equal(summaryEvent.data.model, 'm2');
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

test('a cancelled manual compaction lands in the run log with its cooldown facts', async () => {
  // The 2026-10-01 concurrent-burst incident: four /compact calls were aborted
  // mid-run, one chunk had already failed and cooled a route, and NONE of it
  // appeared in the run log (cancellation skipped recording). A cancelled
  // manual compaction must still append a failed record — with the cooldown
  // events the chain wrote before the abort.
  const root = await mkdtemp(join(tmpdir(), 'dsh-quilt-compact-'));
  const logPath = join(root, 'runs.jsonl');
  try {
    const { ctx } = createTestContext({
      behaviors: {
        'p1/m1': { kind: 'fail', message: 'provider down' },
        'p1/m2': { kind: 'fail', message: 'provider down' },
        'p2/m3': { kind: 'fail', message: 'provider down' },
      },
      latencyMs: 30,
    });
    const engine = engineFor(ctx, defaultEngineConfig({ fallbackToSessionModel: false, runRecord: { enabled: true, path: logPath } }));
    const { session, seqs } = buildSession(2);
    session.append('turn/end', { turn: 1 });
    const agent = agentFor(session);
    const controller = new AbortController();
    agent.runMaintenance = async (run) => run(controller.signal);
    const run = engine.compactNow(agent, controller.signal, undefined);
    // The first chunk calls fail one by one (~30ms each, cooldowns written),
    // the chain then waits for a cooldown expiry — the abort lands during
    // that wait, before the batch can finish degrading.
    setTimeout(() => controller.abort(new Error('user cancelled')), 70);
    await assert.rejects(run, /cancelled/);
    await engine.runLog.flush();

    const entry = JSON.parse((await readFile(logPath, 'utf8')).trim().split('\n').at(-1));
    assert.equal(entry.failed, true, 'the cancelled run is recorded as failed');
    assert.equal(entry.trigger, 'manual');
    assert.equal(entry.route, 'error');
    assert.match(entry.error, /cancelled/, 'the record carries the cancellation reason');
    assert.ok(Array.isArray(entry.cooldowns) && entry.cooldowns.length > 0, 'cooldown facts recorded despite cancellation');
    assert.equal(entry.cooldowns[0].model, 'p1/m1');
    assert.match(entry.cooldowns[0].error, /provider down/, 'the chunk failure reason survives the abort');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test('mergeMaxContextTokens defaults to 128k when unset', async () => {
  const { ctx } = createTestContext({});
  const engine = engineFor(ctx, defaultEngineConfig());
  const capacities = new Map([
    ['p1/m1', { contextWindow: 1048576, maxTokens: 32768 }],
    ['p1/m2', { contextWindow: 131072, maxTokens: 32768 }],
    ['p2/m3', { contextWindow: 65536, maxTokens: 32768 }],
  ]);
  const window = engine.resolveMergeWindow(capacities);
  // `mergeMaxContextTokens` always resolves: unset means the 128k default —
  // pool capacities play no part (no "max(128k, smallest pool window)" branch).
  assert.equal(window, 128000, 'unset defaults to 128k, pool windows ignored');
});

test('mergeMaxContextTokens overrides the 128k default exactly', async () => {
  const { ctx } = createTestContext({});
  const engine = engineFor(ctx, defaultEngineConfig({
    mergeMaxContextTokens: 8000,
  }));
  const capacities = new Map([
    ['p1/m1', { contextWindow: 1048576, maxTokens: 32768 }],
    ['p1/m2', { contextWindow: 131072, maxTokens: 32768 }],
    ['p2/m3', { contextWindow: 65536, maxTokens: 32768 }],
  ]);
  const window = engine.resolveMergeWindow(capacities);
  // 归并前最多保留多少上下文: the configured value wins exactly — 8000 stays
  // 8000, no floor, no pool derivation.
  assert.equal(window, 8000, 'the configured merge window wins, pool ignored');
});

test('mergeMaxContextTokens resolves to 128k regardless of pool capacities', async () => {
  const { ctx } = createTestContext({});
  const engine = engineFor(ctx, defaultEngineConfig());
  const capacities = new Map([
    ['p1/m1', undefined],
    ['p1/m2', undefined],
    ['p2/m3', undefined],
  ]);
  const window = engine.resolveMergeWindow(capacities);
  // Unknown route capacities cannot move the window: the config default is
  // authoritative (128k), not a pool-derived min.
  assert.equal(window, 128000, '128k default regardless of unknown route capacities');
});

test('the merge descends the main pool tiers to a large-window route', async () => {
  // v7: no dedicated merge pool. The merge reuses the main tiers and its own
  // scheduler descends them — tier-0 4k-window chunk models cannot hold 12
  // huge digests, so the job degrades to the tier-1 262k-window route
  // ("归并操作允许单独降池找上下文足够的模型").
  const { ctx, llm } = createTestContext({ contextWindow: 4000 });
  const engine = engineFor(ctx, defaultEngineConfig({
    mergeMaxContextTokens: 262144,
    tiers: [
      ...defaultEngineConfig().tiers,
      { name: 'big', models: [{ provider: 'bench', model: 'merge', maxConcurrent: 1, cooldownHours: 5 }] },
    ],
  }));
  llm.resolveModelInfo = async (provider, model) => ({
    provider,
    model,
    name: model,
    context: { contextWindow: model === 'merge' ? 262144 : 4000 },
    defaultMaxTokens: 32768,
  });
  // Drive the merge chain directly: many digests that could never fit ONE
  // 4k-window request are consolidated by EXACTLY ONE merge call on the
  // large-window route the descent lands on.
  const digests = Array.from({ length: 12 }, (_, index) => `digest ${index}: ${'BIG '.repeat(1000)}`);
  const store = await engine.ensureStore();
  const mergeChain = new ModelChain(
    ctx,
    engine.config,
    store,
    {},
  );
  const capacities = new Map([
    ['bench/merge', { contextWindow: 262144, maxTokens: 32768 }],
    ['p1/m1', { contextWindow: 4000, maxTokens: 32768 }],
    ['p1/m2', { contextWindow: 4000, maxTokens: 32768 }],
    ['p2/m3', { contextWindow: 4000, maxTokens: 32768 }],
  ]);
  const agent = agentFor(buildSession(2).session);
  const merged = await mergeChain.run([{
    label: 'merge',
    digests,
    inputTokens: Math.ceil(digests.join('\n\n').length / 4),
    buildMessages: (cfg) => [{ role: 'user', content: [{ type: 'text', text: digests.join('\n\n') }] }, { role: 'user', content: [{ type: 'text', text: 'merge all digests' }] }],
  }], agent, undefined, { capacities });
  assert.ok(merged[0] !== undefined && merged[0].text.length > 0, 'single merge produced a digest');
  // The descent found the only route that can hold ~12k tokens of digests:
  // the 4k-window routes were capacity-skipped, `bench/merge` (262144) served.
  const mergeCalls = llm.calls.filter((call) => call.model === 'merge');
  assert.equal(mergeCalls.length, 1, `the descent landed exactly one merge call on the large-window route, got ${mergeCalls.length}`);
});

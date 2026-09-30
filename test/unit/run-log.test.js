/**
 * RunLog JSONL recorder: path resolution, snapshot capping, serialized
 * appends, maxEntries trimming, and the record shape.
 * @module dsh-quilt-compact/test/unit/run-log
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunLog, capSnapshot, describeError, resolveRunLogPath, markFailureRecorded, wasFailureRecorded } from '../../lib/run-log.js';

test('capSnapshot keeps head and tail with an elision marker', () => {
  const text = 'a'.repeat(200);
  const capped = capSnapshot(text, 100);
  assert.ok(capped.length < 200, 'capped below the original');
  assert.ok(capped.startsWith('a'.repeat(80)), 'keeps the head (80%)');
  assert.ok(capped.endsWith('a'.repeat(20)), 'keeps the tail (20%)');
  assert.ok(capped.includes('[elided 100 chars]'), 'marks the elision');
  assert.equal(capSnapshot(text, 0), text, 'chars <= 0 keeps everything');
  assert.equal(capSnapshot('short', 100), 'short', 'short text untouched');
});

test('resolveRunLogPath pins an explicit path and defaults to the storage root', () => {
  assert.equal(resolveRunLogPath('D:/tmp/runs.jsonl'), 'D:/tmp/runs.jsonl');
  const fallback = resolveRunLogPath(undefined);
  assert.ok(fallback.endsWith(join('.dsh', 'storages', 'dsh_quilt_compact_runs.jsonl')), `default path: ${fallback}`);
});

test('resolveRunLogPath honors a non-empty DSH_HOME over the default home', () => {
  const previous = process.env.DSH_HOME;
  try {
    delete process.env.DSH_HOME;
    const defaulted = resolveRunLogPath(undefined);
    assert.ok(defaulted.includes(join('.dsh', 'storages')), `default home used when DSH_HOME unset: ${defaulted}`);
    process.env.DSH_HOME = 'D:/custom/harness-home';
    const overridden = resolveRunLogPath(undefined);
    assert.equal(overridden, join('D:/custom/harness-home', 'storages', 'dsh_quilt_compact_runs.jsonl'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test('append writes one JSONL line per run, serialized and durable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-quilt-runlog-'));
  try {
    let now = 1000;
    const log = new RunLog({ path: join(root, 'runs.jsonl'), now: () => now });
    const input = { messages: [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
    ] };
    const result = { provider: 'p1', model: 'm1', text: 'digest', fallback: false, attempts: [{ provider: 'p1', model: 'm1' }] };
    await log.append(input, result, { trigger: 'manual', regionChars: 30, stage0Lines: 2, chunkCount: 1, chunkBudget: 100, overlapTokens: 10, contextWindow: 1000 });

    const text = await readFile(join(root, 'runs.jsonl'), 'utf8');
    const parsed = JSON.parse(text.trim());
    assert.equal(parsed.at, 1000);
    assert.equal(parsed.trigger, 'manual');
    assert.equal(parsed.route, 'p1/m1');
    assert.equal(parsed.fallback, false);
    assert.equal(parsed.digestChars, 6);
    assert.equal(parsed.attempts, 1);
    assert.equal(parsed.regionChars, 30);
    assert.equal(parsed.stage0Lines, 2);
    assert.equal(parsed.chunkCount, 1);
    assert.ok(parsed.snapshot.includes('hello world'), 'snapshot carries the input');
    assert.ok(parsed.snapshot.includes('sys'), 'system prefix in the snapshot');
    assert.equal(parsed.result, 'digest');
    assert.ok(text.endsWith('\n'), 'one line per append');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('snapshotChars caps the input snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-quilt-runlog-'));
  try {
    const log = new RunLog({ path: join(root, 'runs.jsonl'), snapshotChars: 40 });
    const long = 'x'.repeat(200);
    await log.append(
      { messages: [{ role: 'user', content: [{ type: 'text', text: long }] }] },
      { provider: 'p', model: 'm', text: 'd' },
      { trigger: 'pressure' },
    );
    const [entry] = await log.recent();
    assert.ok(entry.snapshot.length <= 40 + 64, `snapshot capped (${entry.snapshot.length})`);
    assert.ok(entry.snapshot.includes('[elided'), 'elision present when capped');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('describeError flattens an error chain into one bounded single line', () => {
  const root = new Error('root cause: disk full');
  const mid = new Error('append failed', { cause: root });
  const top = new Error('manual compaction could not produce a smaller summary: append failed', { cause: mid });
  const reason = describeError(top);
  assert.match(reason, /append failed/, 'keeps the mid-chain message');
  assert.match(reason, /disk full/, 'keeps the root-cause message');
  assert.equal(reason.includes('\n'), false, 'single line');
  // A wrapper whose message already contains the cause adds nothing.
  const nested = new Error('outer: append failed', { cause: new Error('append failed') });
  assert.equal(describeError(nested), 'outer: append failed');
  assert.ok(describeError(new Error(`x${'y'.repeat(2000)}`)).length <= 600, 'bounded length');
  assert.equal(describeError(undefined), '', 'non-error input yields an empty reason');
});

test('markFailureRecorded/wasFailureRecorded deduplicate one failure across layers', () => {
  // The summarize stage and the transaction boundary see the SAME error (or a
  // wrapper around it). The marker must survive the rethrow AND the wrap.
  const inner = new Error('root quota');
  const outer = new Error('wrapper around the quota', { cause: inner });
  assert.equal(wasFailureRecorded(outer), false, 'unmarked chain is not recorded');
  markFailureRecorded(inner);
  assert.equal(wasFailureRecorded(outer), true, 'a wrapper over a marked cause counts as recorded');
  assert.equal(wasFailureRecorded(inner), true, 'the marked error itself is recorded');
  // Marking the same error twice is idempotent; unrelated errors stay unmarked.
  markFailureRecorded(inner);
  assert.equal(wasFailureRecorded(inner), true);
  assert.equal(wasFailureRecorded(new Error('fresh')), false);
  // Non-object inputs are tolerated (an error chain may end at a string).
  assert.equal(wasFailureRecorded('just a string'), false);
  assert.equal(wasFailureRecorded(undefined), false);
  markFailureRecorded('just a string');
  assert.equal(wasFailureRecorded('just a string'), false, 'string cannot be marked');
});

test('appendFailure records failed:true with the flattened reason and attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-quilt-runlog-'));
  try {
    let now = 5000;
    const log = new RunLog({ path: join(root, 'runs.jsonl'), now: () => now });
    const input = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] };
    await log.appendFailure(
      input,
      new Error('pool exhausted; attempts: p1/m1 x1 (last: quota)', { cause: new Error('quota') }),
      { trigger: 'manual', attempts: [{ model: 'p1/m1', error: 'quota' }], stage0Lines: 4, mergeWindow: 128000 },
    );
    const [entry] = await log.recent();
    assert.equal(entry.failed, true, 'the failure flag is on the record');
    assert.equal(entry.at, 5000);
    assert.equal(entry.route, 'error', 'a failed run has no route');
    assert.equal(entry.trigger, 'manual');
    assert.equal(entry.attempts, 1, 'per-route attempts counted');
    assert.equal(entry.stage0Lines, 4);
    assert.equal(entry.mergeWindow, 128000);
    assert.ok(entry.error.includes('pool exhausted'), 'flattened reason in the record');
    assert.equal(entry.result, '', 'no result digest on a failed run');
    assert.equal(entry.digestChars, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('maxEntries trims the file to the most recent entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-quilt-runlog-'));
  try {
    let now = 0;
    const log = new RunLog({ path: join(root, 'runs.jsonl'), maxEntries: 3, now: () => { now += 1; return now; } });
    for (let i = 1; i <= 5; i += 1) {
      await log.append(
        { messages: [{ role: 'user', content: [{ type: 'text', text: `run ${i}` }] }] },
        { provider: 'p', model: 'm', text: `digest ${i}` },
        { trigger: 'manual' },
      );
    }
    const entries = await log.recent(10);
    assert.equal(entries.length, 3, 'only the newest entries survive');
    assert.equal(entries[0].result, 'digest 5', 'newest first');
    assert.equal(entries[2].result, 'digest 3', 'oldest kept is the third');
    const lines = (await readFile(join(root, 'runs.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 3, 'file has exactly three lines');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

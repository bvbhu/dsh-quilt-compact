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
import { RunLog, capSnapshot, resolveRunLogPath } from '../../lib/run-log.js';

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

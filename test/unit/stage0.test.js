/**
 * Stage 0 transforms.
 * @module dsh-quilt-compact/test/unit/stage0
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupLines, purgeNoiseLines, headMiddleTail, skipBlankBlocks } from '../../lib/stage0/trim.js';
import { astSkeletonize, logCondenseLines, findLogRuns } from '../../lib/stage0/semantic.js';
import { chunkLines, lineTokenCost } from '../../lib/stage0/chunk.js';
import { runStage0 } from '../../lib/stage0/pipeline.js';
import { extractRegionLines } from '../../lib/stage0/text.js';

test('dedup collapses consecutive duplicate lines only', () => {
  assert.deepEqual(
    dedupLines(['a', 'a', 'b', 'b', 'b', 'c', 'a']),
    ['a', 'b', 'c', 'a'],
  );
});

test('purgeNoise strips ANSI escapes, caret markers, and long separators', () => {
  const out = purgeNoiseLines([
    '\u001B[31merror\u001B[0m text',
    '    ^^^^',
    '----------------',
    'keep this',
  ]);
  assert.deepEqual(out, ['error text', 'keep this']);
});

test('headMiddleTail keeps head, marker, and tail above the threshold', () => {
  const lines = Array.from({ length: 20 }, (_, index) => `line-${index} xxxxxxxxxxxxxxxxxxxx`);
  const out = headMiddleTail(lines, { thresholdChars: 100, headChars: 40, tailChars: 40 });
  assert.equal(out[0], 'line-0 xxxxxxxxxxxxxxxxxxxx');
  assert.ok(out.some((line) => line.startsWith('[condensed:')));
  assert.equal(out.at(-1), 'line-19 xxxxxxxxxxxxxxxxxxxx');
  assert.ok(out.length < lines.length);
});

test('headMiddleTail passes through short documents untouched', () => {
  const lines = ['short', 'doc'];
  assert.equal(headMiddleTail(lines, { thresholdChars: 8192, headChars: 10, tailChars: 10 }), lines);
});

test('skipBlankBlocks collapses long blank runs but preserves structure', () => {
  assert.deepEqual(skipBlankBlocks(['a', '', '', '', '', 'b']), ['a', '', 'b']);
});

test('astSkeleton keeps depth <= maxDepth and collapses deeper runs', () => {
  const block = [
    '```js',
    'export function main() {',
    '    const x = 1;',
    '            const y = 2;', // depth 3: beyond maxDepth 2
    '    return x + y;',
    '}',
    '```',
  ];
  const out = astSkeletonize(block, 2);
  assert.deepEqual(out, [
    '```js',
    'export function main() {',
    '    const x = 1;',
    '[condensed: 1 lines removed]',
    '    return x + y;',
    '}',
    '```',
  ]);
});

test('astSkeleton emits a condensed marker for deep body runs', () => {
  const block = [
    '```py',
    'def f():',
    '    if cond:',
    '            x = deep(1)',
    '            y = deep(2)',
    '            z = deep(3)',
    '    return x',
    '```',
  ];
  const out = astSkeletonize(block, 2);
  assert.ok(out.some((line) => line.startsWith('[condensed: 3 lines removed]')), JSON.stringify(out));
  assert.ok(out.includes('    if cond:'));
});

test('logCondense samples head+tail of long log runs with a marker', () => {
  const lines = [
    'INFO  2026-01-01 10:00:01 step 1',
    'INFO  2026-01-01 10:00:02 step 2',
    'INFO  2026-01-01 10:00:03 step 3',
    'INFO  2026-01-01 10:00:04 step 4',
    'INFO  2026-01-01 10:00:05 step 5',
    'INFO  2026-01-01 10:00:06 step 6',
    'INFO  2026-01-01 10:00:07 step 7',
    'INFO  2026-01-01 10:00:08 step 8',
  ];
  const out = logCondenseLines(lines, 'balanced', 4);
  assert.equal(out[0], lines[0]);
  assert.equal(out[1], lines[1]);
  assert.ok(out.some((line) => line.startsWith('[condensed: 4 lines removed]')));
  assert.equal(out.at(-1), lines.at(-1));
  assert.equal(out.at(-2), lines.at(-2));
  assert.equal(out.length, 5); // 2 head + marker + 2 tail
});

test('logCondense head mode keeps only the head budget', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `ERR 2026-01-01 10:00:0${i} boom`);
  const out = logCondenseLines(lines, 'head', 3);
  assert.equal(out.length, 4);
  assert.ok(out[3].startsWith('[condensed:'));
});

test('findLogRuns ignores short mixed prose', () => {
  const lines = ['INFO text', 'no timestamp', 'WARN another'];
  assert.deepEqual(findLogRuns(lines), []);
});

test('chunkLines splits with overlap and progress', () => {
  // 12 lines of ~10 chars each; budget = 3 lines/core, overlap = 1 line —
  // costs derived from lineTokenCost itself (the REAL tokenizer), not a
  // hardcoded chars/4 assumption.
  const lines = Array.from({ length: 12 }, (_, index) => `line-${index} abc`);
  const cost = lineTokenCost(lines[0]);
  const chunks = chunkLines(lines, cost * 3, cost);
  assert.ok(chunks.length >= 3, `expected >= 3 chunks, got ${chunks.length}`);
  // adjacent chunks overlap by whole lines
  for (let index = 1; index < chunks.length; index += 1) {
    assert.ok(chunks[index].start < chunks[index - 1].end, `chunk ${index} should overlap the previous chunk`);
    assert.ok(chunks[index].start > chunks[index - 1].start, 'chunks must make progress');
  }
  // union covers every line
  const covered = new Set();
  for (const chunk of chunks) {
    for (let line = chunk.start; line < chunk.end; line += 1) covered.add(line);
  }
  assert.equal(covered.size, lines.length);
});

test('chunkLines aligns boundaries to sentence-ending lines', () => {
  const lines = [
    'This is a long sentence that does not end here.',
    'But this one does.',
    'mid1 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    'mid2 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    'mid3 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    'Another finished sentence.',
    'mid4 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    'tail content here.',
  ];
  const chunks = chunkLines(lines, 12, 3);
  for (const chunk of chunks) {
    const last = chunk.lines.at(-1);
    assert.ok(last.trim().length > 0);
  }
  // the cut between chunk 0 and 1 should land after a sentence-ending line
  assert.ok(/[.!]$/.test(chunks[0].lines.at(-1).trim()));
});

test('chunkLines handles an oversized single line without infinite loop', () => {
  const lines = ['x'.repeat(1000), 'short'];
  const chunks = chunkLines(lines, 5, 1);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].lines[0], 'x'.repeat(1000));
});

test('chunkLines with zero overlap produces disjoint cores', () => {
  const lines = Array.from({ length: 10 }, (_, index) => `line-${index} xxxxxxxxxxxx`);
  const chunks = chunkLines(lines, 15, 0);
  for (let index = 1; index < chunks.length; index += 1) {
    assert.equal(chunks[index].start, chunks[index - 1].end);
  }
});

test('runStage0 applies the full pipeline in order', () => {
  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'first message\nfirst message\nwith \u001B[31mANSI\u001B[0m noise\n^^^^\n' }],
    },
    {
      role: 'tool',
      content: [
        { type: 'text', text: '```js\nfunction f() {\n    const a = 1;\n            const b = deep(2);\n    return a;\n}\n```' },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'text', text: 'INFO 2026-01-01 10:00:01 log a\nINFO 2026-01-01 10:00:02 log b\nINFO 2026-01-01 10:00:03 log c\nINFO 2026-01-01 10:00:04 log d\nINFO 2026-01-01 10:00:05 log e\n' }],
    },
  ];
  const preprocessing = {
    dedup: true,
    purgeErrors: true,
    astSkeleton: { enabled: true, maxDepth: 2 },
    logCondense: { mode: 'balanced', maxLines: 1 },
  };
  const out = runStage0(messages, preprocessing);
  const text = out.join('\n');
  assert.ok(!text.includes('\u001B'), 'ANSI escapes removed');
  assert.ok(!text.includes('^^^^'), 'cursor markers removed');
  assert.ok(!text.includes('const b = deep(2)'), 'deep body condensed');
  assert.ok(!text.includes('log d'), 'long log run condensed');
  assert.ok(!text.includes('log e'), 'long log run condensed');
  assert.ok(out.some((line) => line.startsWith('[condensed:')));
});

test('extractRegionLines marks roles and flattens blocks', () => {
  const lines = extractRegionLines([
    { role: 'user', content: [{ type: 'text', text: 'a\nb' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 't1', name: 'read', arguments: '{"path":"x"}' }] },
  ]);
  assert.deepEqual(lines, ['[user]', 'a', 'b', '[assistant]', '[tool-call read]', '{"path":"x"}']);
});

test('extractRegionLines preserves file and image identity instead of anonymizing them', () => {
  const lines = extractRegionLines([
    {
      role: 'user',
      content: [
        { type: 'file', attachment: { name: 'src/components/editor/Editor.tsx', bytes: 123, attachmentId: 'sha256:aa' } },
        { type: 'file', attachment: { name: 'logs/build-failure.txt' } },
        { type: 'image', attachment: { name: 'screenshot.png' } },
        { type: 'image', attachment: { name: 'diagram.jpg' }, offloaded: true },
        { type: 'file' },
        { type: 'image', offloaded: true },
      ],
    },
  ]);
  assert.deepEqual(lines, [
    '[user]',
    '[file: src/components/editor/Editor.tsx]',
    '[file: logs/build-failure.txt]',
    '[image: screenshot.png]',
    '[image: diagram.jpg (offloaded)]',
    '[file]',
    '[image (offloaded)]',
  ]);
});

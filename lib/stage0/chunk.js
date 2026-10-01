/**
 * Stage 0c overlapping chunker.
 *
 * Cores partition the preprocessed line document; each chunk is its core plus
 * the trailing overlap that slides into the next chunk:
 *
 * ```
 * core_1: [========]            chunk_1 = [core_1 + 后向 overlap]
 * core_2:          [========]  chunk_2 = [前向 overlap + core_2 + 后向 overlap]
 * core_3:                   [========]  chunk_3 = [前向 overlap + core_3]
 * ```
 *
 * Chunking is pure computation over REAL token costs (the deepseek-v4
 * tokenizer, see {@link lineTokenCost}). Lines are atomic: cut boundaries are
 * snapped to the nearest newline (lines) and preferred sentence-ending lines,
 * so words and code lines are never split. Whole lines near the cut appear in
 * both neighbours and the merge model deduplicates them.
 *
 * @module dsh-quilt-compact/stage0/chunk
 */
import { countTokens } from '../tokenizer.js';

/**
 * Line-cost under the REAL tokenizer, including the trailing newline. The old
 * `chars/4` heuristic is CJK-blind: real sessions tokenize to ~2x-2.4x its
 * count, and an undersized estimate made providers reject oversized chunks
 * with an opaque 400.
 */
export function lineTokenCost(line) {
  return countTokens(line) + 1;
}

/** Characters that end a sentence or clause at a line boundary. */
const SENTENCE_END_CHARS = new Set(['.', '?', '!', ':', ';', ',', '}', ']', ')', '"', "'", '`']);

/** Whether a line is a preferred cut boundary (blank or sentence-ending). */
function isBoundaryLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return true;
  return SENTENCE_END_CHARS.has(trimmed[trimmed.length - 1]);
}

/** How far BACK a cut may snap to a sentence-ending line, in lines. */
const ALIGN_WINDOW_LINES = 12;

/**
 * Split preprocessed lines into overlapping chunks.
 * @param lines - preprocessed line document.
 * @param chunkTokens - core budget per chunk (`contextWindow * chunkRatio`).
 * @param overlapTokens - overlap budget per boundary (`chunkTokens * chunkOverlapRatio`).
 * @returns chunk descriptors `{ start, end, lines }` where `lines = lines.slice(start, end)`.
 */
export function chunkLines(lines, chunkTokens, overlapTokens) {
  if (lines.length === 0) return [];
  const costs = lines.map(lineTokenCost);
  const chunks = [];
  let start = 0;
  while (start < lines.length) {
    const sliced = sliceAt(lines, costs, start, chunkTokens, overlapTokens);
    chunks.push({ start, end: sliced.end, lines: lines.slice(start, sliced.end) });
    if (sliced.next <= start) {
      // No progress is impossible after the >=1-line guarantee; guard anyway.
      chunks.push({ start, end: lines.length, lines: lines.slice(start) });
      break;
    }
    start = sliced.next;
  }
  return chunks;
}

/**
 * Slice ONE chunk starting at `start` (v7 model-driven slicing): the core
 * advances while the next line still fits `chunkTokens`, the cut snaps to a
 * sentence-ending line boundary, and the chunk's trailing overlap slides into
 * the next core. Returns the chunk's end and the next core's start.
 *
 * @param lines - preprocessed line document.
 * @param costs - per-line token costs (see {@link lineTokenCost}).
 * @param start - index of the first line of this chunk.
 * @param chunkTokens - core budget for this chunk.
 * @param overlapTokens - overlap budget at this boundary.
 * @returns `{ end, next }` — `end` is the chunk's exclusive end; `next` is the
 *   start of the next chunk's core (`next = overlap > start ? overlap : end`).
 */
function sliceAt(lines, costs, start, chunkTokens, overlapTokens) {
  // Advance the core while the next line still fits (always take >= 1 line).
  let end = start;
  let acc = 0;
  while (end < lines.length && (end === start || acc + costs[end] <= chunkTokens)) {
    acc += costs[end];
    end += 1;
  }
  if (end >= lines.length) return { end: lines.length, next: lines.length };
  // Snap the cut to the nearest sentence-ending line boundary at or BEFORE
  // `end`. `end` is the first line that does NOT fit the budget, so snapping
  // forward would emit an oversized chunk.
  const aligned = alignEndBoundary(lines, start, end);
  const overlap = overlapStart(lines, costs, start, aligned, overlapTokens);
  const next = overlap > start ? overlap : aligned;
  return { end: aligned, next };
}

/**
 * v7 public one-chunk slice: slice the next chunk from a line document starting
 * at `start`, using the budget for THIS chunk. Keeps `chunkLines` as the pure
 * full-document helper; the engine uses this when slicing follows the chosen
 * model's window (each chunk can have a different budget).
 *
 * @param lines - preprocessed line document.
 * @param start - index of the first line of the next chunk.
 * @param chunkTokens - core budget for this chunk.
 * @param overlapTokens - overlap budget at this boundary.
 * @returns `{ end, next }` (see {@link sliceAt}).
 */
export function sliceNextChunk(lines, start, chunkTokens, overlapTokens) {
  if (start >= lines.length) return { end: lines.length, next: lines.length };
  const costs = lines.map(lineTokenCost);
  return sliceAt(lines, costs, start, chunkTokens, overlapTokens);
}

/**
 * Choose the cut position: start from the candidate `end` (the FIRST line that
 * would push the chunk past its token budget) and snap BACKWARDS to the nearest
 * line boundary — the closest cut whose previous line ends a sentence or clause.
 *
 * The cut may never move FORWARD past `candidate`. That line does not fit the
 * budget, so including it would emit a chunk larger than the one it was sliced
 * for; the request then gets capacity-rejected at dispatch and the scheduler
 * degrades or falls back for a chunk the chunker should have sized correctly.
 * Alignment is only a PREFERENCE, so not aligning at all (`cut === candidate`)
 * is always the safe answer.
 *
 * @param lines - preprocessed line document.
 * @param start - index of the chunk's first line.
 * @param candidate - the first cut position the token budget allows.
 * @returns the cut position, always within `[start + 1, candidate]`.
 */
function alignEndBoundary(lines, start, candidate) {
  const low = Math.max(start + 1, candidate - ALIGN_WINDOW_LINES);
  for (let cut = candidate; cut >= low; cut -= 1) {
    if (isBoundaryLine(lines[cut - 1])) return cut;
  }
  return candidate;
}

/**
 * Where the next chunk starts: walk backwards from `end` accumulating line
 * costs until `overlapTokens` is covered (whole lines only).
 */
function overlapStart(lines, costs, start, end, overlapTokens) {
  if (overlapTokens <= 0) return end;
  let cursor = end;
  let acc = 0;
  while (cursor > start && acc < overlapTokens) {
    cursor -= 1;
    acc += costs[cursor];
  }
  return cursor;
}

/** Estimate tokens of one chunk text (line-sum, for diagnostics). */
export function chunkTokens(chunk) {
  return chunk.lines.reduce((sum, line) => sum + lineTokenCost(line), 0);
}

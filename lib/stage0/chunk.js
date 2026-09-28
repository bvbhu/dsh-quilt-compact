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
 * Chunking is pure computation (line costs under the meter's `chars/4`
 * heuristic). Lines are atomic: cut boundaries are snapped to the nearest
 * newline (lines) and preferred sentence-ending lines, so words and code
 * lines are never split. Whole lines near the cut appear in both neighbours
 * and the merge model deduplicates them.
 *
 * @module dsh-quilt-compact/stage0/chunk
 */

/** Chars per token under the shared fixed-density heuristic (see dsh-token-meter). */
const CHARS_PER_TOKEN = 4;

/** Line-cost under the shared heuristic, including the trailing newline. */
export function lineTokenCost(line) {
  return Math.ceil((line.length + 1) / CHARS_PER_TOKEN);
}

/** Characters that end a sentence or clause at a line boundary. */
const SENTENCE_END_CHARS = new Set(['.', '?', '!', ':', ';', ',', '}', ']', ')', '"', "'", '`']);

/** Whether a line is a preferred cut boundary (blank or sentence-ending). */
function isBoundaryLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return true;
  return SENTENCE_END_CHARS.has(trimmed[trimmed.length - 1]);
}

/** Bound for snapping a cut to a sentence-ending line, in lines. */
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
    // Advance the core while the next line still fits (always take >= 1 line).
    let end = start;
    let acc = 0;
    while (end < lines.length && (end === start || acc + costs[end] <= chunkTokens)) {
      acc += costs[end];
      end += 1;
    }
    if (end >= lines.length) {
      chunks.push({ start, end: lines.length, lines: lines.slice(start) });
      break;
    }
    // Snap the cut to the nearest sentence-ending line boundary within the window.
    const aligned = alignEndBoundary(lines, start, end);
    const overlap = overlapStart(lines, costs, start, aligned, overlapTokens);
    chunks.push({ start, end: aligned, lines: lines.slice(start, aligned) });
    const next = overlap > start ? overlap : aligned;
    if (next <= start) {
      // No progress is impossible after the >=1-line guarantee; guard anyway.
      chunks.push({ start, end: lines.length, lines: lines.slice(start) });
      break;
    }
    start = next;
  }
  return chunks;
}

/**
 * Choose the cut position: start from the candidate `end` (first line of the
 * next core) and prefer the nearest line boundary whose previous line ends
 * with sentence punctuation, staying inside `[start + 1, lines.length]`.
 */
function alignEndBoundary(lines, start, candidate) {
  let best = candidate;
  let bestDistance = Infinity;
  const low = Math.max(start + 1, candidate - ALIGN_WINDOW_LINES);
  const high = Math.min(lines.length, candidate + ALIGN_WINDOW_LINES);
  for (let cut = low; cut <= high; cut += 1) {
    if (cut === start) continue;
    const previous = lines[cut - 1];
    if (isBoundaryLine(previous)) {
      const distance = Math.abs(cut - candidate);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = cut;
      }
    }
  }
  return best;
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

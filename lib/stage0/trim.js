/**
 * Stage 0a deterministic trims shared by the dsh-quilt-compact pipeline.
 *
 * All transforms are pure line-array functions: deterministic, no LLM, and
 * fully unit-testable. They only ever shrink the text (plus insert
 * `[condensed: N ...]` metadata lines), so the final summary still has to
 * beat the built-in "smaller than the shadowed region" check.
 *
 * @module dsh-quilt-compact/stage0/trim
 */

/** Collapse consecutive duplicate lines: keep the first occurrence. */
export function dedupLines(lines) {
  const out = [];
  let previous = undefined;
  for (const line of lines) {
    if (line === previous) continue;
    out.push(line);
    previous = line;
  }
  return out;
}

/**
 * Remove terminal noise: ANSI escape sequences (very common in tool output),
 * caret/underline/tilde cursor markers, and long pure-punctuation separator
 * runs. Conservative by design: real error text is never removed.
 */
const ANSI_ESCAPE = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CURSOR_MARKER = /^\s*[\^~]{4,}\s*$/;
const LONG_SEPARATOR = /^\s*([^\s\w])\1{15,}\s*$/;

export function purgeNoiseLines(lines) {
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(ANSI_ESCAPE, '');
    if (CURSOR_MARKER.test(line)) continue;
    if (LONG_SEPARATOR.test(line)) continue;
    out.push(line);
  }
  return out;
}

/**
 * Head-middle-tail trim: when the document exceeds `thresholdChars`, keep the
 * `headChars` head and the `tailChars` tail, collapsing the middle into one
 * `[condensed: N chars removed]` metadata line.
 */
export function headMiddleTail(lines, config) {
  const { thresholdChars, headChars, tailChars } = config;
  const total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  if (total <= thresholdChars) return lines;

  const head = [];
  let headCharsUsed = 0;
  for (const line of lines) {
    if (headCharsUsed + line.length + 1 > headChars && head.length > 0) break;
    head.push(line);
    headCharsUsed += line.length + 1;
  }

  const tail = [];
  let tailCharsUsed = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (tailCharsUsed + line.length + 1 > tailChars && tail.length > 0) break;
    tail.push(line);
    tailCharsUsed += line.length + 1;
  }
  tail.reverse();

  const headEnd = head.length;
  const tailStart = lines.length - tail.length;
  const removed = tailStart - headEnd;
  if (removed <= 0) return lines;
  return [...head, `[condensed: ${removed} lines removed]`, ...tail];
}

/** Skip blank blocks: collapse runs of three or more blank lines to one. */
export function skipBlankBlocks(lines) {
  const out = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      blankRun += 1;
      if (blankRun === 3) out.push('');
      continue;
    }
    blankRun = 0;
    out.push(line);
  }
  // Drop a lone collapsed blank at the very end when the document already ends.
  while (out.length > 1 && out[out.length - 1] === '') out.pop();
  return out;
}

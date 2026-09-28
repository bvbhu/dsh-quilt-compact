/**
 * Stage 0b semantic compression: AST skeletonization and log condensation.
 *
 * Both are embedded deterministic algorithms (MIT-idea style, no external
 * package), operating on the line document after 0a trims. They collapse
 * verbatim bulk while preserving structure and inserting
 * `[condensed: N lines removed]` metadata lines so a reader (or the merge
 * model) knows content was dropped.
 *
 * @module dsh-quilt-compact/stage0/semantic
 */

/** Detect a fenced code block opener: ```` ```lang ```` or ```` ``` ````. */
const FENCE_OPEN = /^```[^\s`]*\s*$/;
/** Detect a fenced code block closer. */
const FENCE_CLOSE = /^```\s*$/;

/**
 * AST skeletonization of fenced code blocks: keep lines whose indentation
 * depth is at most `maxDepth` (structural lines: signatures, control flow),
 * collapse deeper body lines into one metadata line per run. Only fenced
 * blocks are touched; prose is preserved verbatim.
 *
 * Indentation depth counts leading whitespace runs (tabs expand to 4).
 */
export function astSkeletonize(lines, maxDepth) {
  const out = [];
  let index = 0;
  let inFence = false;
  while (index < lines.length) {
    const line = lines[index];
    if (inFence) {
      if (FENCE_CLOSE.test(line)) {
        inFence = false;
        out.push(line);
        index += 1;
        continue;
      }
      const depth = indentationDepth(line);
      if (depth <= maxDepth) {
        out.push(line);
      } else {
        // collapse the body run into one metadata line
        let removed = 0;
        while (index < lines.length && !FENCE_CLOSE.test(lines[index]) && indentationDepth(lines[index]) > maxDepth) {
          removed += 1;
          index += 1;
        }
        out.push(`[condensed: ${removed} lines removed]`);
        continue;
      }
      index += 1;
      continue;
    }
    out.push(line);
    if (FENCE_OPEN.test(line)) inFence = true;
    index += 1;
  }
  return out;
}

/** Indentation depth of a line: tabs count as 4 columns, then /4. */
function indentationDepth(line) {
  let columns = 0;
  for (const char of line) {
    if (char === ' ') columns += 1;
    else if (char === '\t') columns += 4;
    else break;
  }
  return Math.floor(columns / 4);
}

/** Whether a line looks like a log-record line (timestamped or level-tagged). */
const LOG_TIMESTAMP = /^\S+\s+\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
const LOG_LEVEL = /\b(?:INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\b/;

/** Find [start, end) runs of consecutive log-ish lines (at least 4 long). */
export function findLogRuns(lines) {
  const runs = [];
  let start = -1;
  const isLogLine = (line) => LOG_TIMESTAMP.test(line) || LOG_LEVEL.test(line);
  for (let index = 0; index <= lines.length; index += 1) {
    const logLike = index < lines.length && isLogLine(lines[index]);
    if (logLike && start === -1) start = index;
    if (!logLike && start !== -1) {
      if (index - start >= 4) runs.push([start, index]);
      start = -1;
    }
  }
  return runs;
}

/**
 * Condense each log run longer than `maxLines` down to a sampled prefix, a
 * metadata line, and a sampled suffix:
 *
 * - `balanced`: first half of the budget from the head, rest from the tail.
 * - `head`: the first `maxLines` lines.
 * - `tail`: the last `maxLines` lines.
 *
 * `maxLines: 0` keeps only the metadata line (run fully condensed).
 */
export function logCondenseLines(lines, mode, maxLines) {
  const runs = findLogRuns(lines);
  if (runs.length === 0) return lines;
  const out = [];
  let cursor = 0;
  for (const [start, end] of runs) {
    const count = end - start;
    out.push(...lines.slice(cursor, start));
    if (count <= maxLines) {
      out.push(...lines.slice(start, end));
    } else if (maxLines === 0) {
      out.push(`[condensed: ${count} lines removed]`);
    } else {
      const headCount = mode === 'balanced'
        ? Math.ceil(maxLines / 2)
        : mode === 'head' ? maxLines : 0;
      const tailCount = mode === 'balanced'
        ? Math.floor(maxLines / 2)
        : mode === 'head' ? 0 : maxLines;
      out.push(...lines.slice(start, start + headCount));
      out.push(`[condensed: ${count - maxLines} lines removed]`);
      out.push(...lines.slice(end - tailCount, end));
    }
    cursor = end;
  }
  out.push(...lines.slice(cursor));
  return out;
}

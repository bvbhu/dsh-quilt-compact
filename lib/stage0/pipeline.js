/**
 * Stage 0 pipeline orchestration: 0a deterministic trims, 0b semantic
 * compression, then the resolved configuration used by 0c chunking.
 *
 * Length is NOT managed here. The overlapping chunker (Stage 0c) is the
 * pipeline's length mechanism: it splits a document of any size into chunks
 * that each fit the model, summarizes them, and merges hierarchically. A
 * second, content-deleting length control at this stage would duplicate that
 * job with a destructive method — and measurement showed it cost ~35 points of
 * recall versus letting the chunker handle size alone.
 *
 * What remains here is therefore only lossless or near-lossless cleanup:
 * duplicates, ANSI artifacts, blank runs, and (optionally) structural/code
 * transforms whose removals are explicitly marked.
 *
 * @module dsh-quilt-compact/stage0/pipeline
 */
import { extractRegionLines } from './text.js';
import {
  dedupLines,
  purgeNoiseLines,
  skipBlankBlocks,
} from './trim.js';
import { astSkeletonize, logCondenseLines } from './semantic.js';

/**
 * Run Stage 0 (0a + 0b) over the summarization input messages.
 * @param messages - replay prefix messages (`{ messages }` from the region).
 * @param preprocessing - resolved preprocessing config.
 * @returns the preprocessed line document (0c consumes it).
 */
export function runStage0(messages, preprocessing) {
  let lines = extractRegionLines(messages);
  if (preprocessing.dedup) lines = dedupLines(lines);
  if (preprocessing.purgeErrors) lines = purgeNoiseLines(lines);
  lines = skipBlankBlocks(lines);
  if (preprocessing.astSkeleton.enabled) {
    lines = astSkeletonize(lines, preprocessing.astSkeleton.maxDepth);
  }
  lines = logCondenseLines(lines, preprocessing.logCondense.mode, preprocessing.logCondense.maxLines);
  return lines;
}

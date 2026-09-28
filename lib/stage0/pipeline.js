/**
 * Stage 0 pipeline orchestration: 0a deterministic trims, 0b semantic
 * compression, then the resolved configuration used by 0c chunking.
 *
 * @module dsh-quilt-compact/stage0/pipeline
 */
import { extractRegionLines } from './text.js';
import {
  dedupLines,
  purgeNoiseLines,
  headMiddleTail,
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
  lines = headMiddleTail(lines, preprocessing.headMiddleTail);
  lines = skipBlankBlocks(lines);
  if (preprocessing.astSkeleton.enabled) {
    lines = astSkeletonize(lines, preprocessing.astSkeleton.maxDepth);
  }
  lines = logCondenseLines(lines, preprocessing.logCondense.mode, preprocessing.logCondense.maxLines);
  return lines;
}

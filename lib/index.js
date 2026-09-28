/**
 * dsh-quilt-compact: a tiered model-pool summarization backend for the DeepSeek
 * Harness.
 *
 * Load this plugin as the `compaction` service in place of
 * `dsh-compaction-basic`. See the README for the exact profile entry.
 *
 * @module dsh-quilt-compact
 */
export { estimateMessage } from '@deepseek-ai/dsh-token-meter/estimate';
export { QuiltCompactEngine, QuiltCompactEngine as default } from './engine.js';
export { Config, readConfigValue } from './config.js';
export { validateModelPool, collectAvailableRoutes } from './model-pool.js';
export { chainStateSpec } from './spec.js';
export { computeCooldownUntil } from './cooldown.js';
export { ModelChain, chunkJob, mergeJob, sessionTarget } from './model-chain.js';
export { runStage0 } from './stage0/pipeline.js';
export { chunkLines, lineTokenCost, chunkTokens } from './stage0/chunk.js';

export const name = 'dsh-quilt-compact';
export const inject = ['llm', 'tokenMeter', 'sessions'];

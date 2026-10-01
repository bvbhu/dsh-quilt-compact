/**
 * dsh-quilt-compact: a tiered model-pool summarization backend for the DeepSeek
 * Harness.
 *
 * Load this plugin as the `compaction` service in place of
 * `dsh-compaction-basic`. See the README for the exact profile entry.
 *
 * The plugin also ships a settings bridge: when a `webServer` is present
 * (web/desktop profiles), routes under `/api/dsh-quilt-compact/*` let the
 * bundle's client page read and write the backend config — including the copy
 * nested inside a `preset-standard` override, which `dsh-settings` forms cannot
 * address.
 *
 * @module dsh-quilt-compact
 */
export { estimateMessage } from '@deepseek-ai/dsh-token-meter/estimate';
export { QuiltCompactEngine, QuiltCompactEngine as default } from './engine.js';
export { Config, readConfigValue } from './config.js';
export { validateModelPool, collectAvailableRoutes } from './model-pool.js';
export { chainStateSpec } from './spec.js';
export { computeCooldownUntil } from './cooldown.js';
export { RunLog, capSnapshot, resolveRunLogPath, DEFAULT_RUN_LOG } from './run-log.js';
export { ModelChain, chunkJob, mergeJob, sessionTarget } from './model-chain.js';
export { runStage0 } from './stage0/pipeline.js';
export { chunkLines, chunkTokens } from './stage0/chunk.js';
export { createBridgeHandlers, createBridgeRoutes, guardBridgeRequest, readJsonBody, writeJson } from './bridge.js';
export { createBridgeDeps, registerQuiltBridge } from './bridge-host.js';
export { readBasicPolicy } from './default-compression.js';

export const name = 'dsh-quilt-compact';
export const inject = ['llm', 'tokenMeter', 'sessions'];

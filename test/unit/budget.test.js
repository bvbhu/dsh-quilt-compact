/**
 * Context budget math: output reservation, usable input, and the chunk budget.
 * @module dsh-quilt-compact/test/unit/budget
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTPUT_RESERVATION_RATIO,
  PROMPT_OVERHEAD_TOKENS,
  SAFETY_HEADROOM_TOKENS,
  computeOutputBudget,
  computeUsableInputTokens,
  computeChunkBudget,
} from '../../lib/budget.js';

test('output reservation is 15% of the window, capped by DEFAULT_MAX_TOKENS', () => {
  assert.equal(OUTPUT_RESERVATION_RATIO, 0.15);
  // 128K window: 15% = 19200 < 32768 cap.
  assert.equal(computeOutputBudget(128000), 19200);
  // 1M window: 15% = 157286, capped at the 32768 per-call output cap.
  assert.equal(computeOutputBudget(1048576), 32768);
  // 64K window: 15% = 9830.
  assert.equal(computeOutputBudget(65536), 9830);
});

test('usable input subtracts output reservation, prompt overhead, and headroom', () => {
  assert.equal(PROMPT_OVERHEAD_TOKENS, 512);
  assert.equal(SAFETY_HEADROOM_TOKENS, 512);
  const window = 128000;
  assert.equal(
    computeUsableInputTokens(window),
    window - computeOutputBudget(window) - PROMPT_OVERHEAD_TOKENS - SAFETY_HEADROOM_TOKENS,
  );
  // Never below 1, even for a window smaller than the reservations.
  assert.equal(computeUsableInputTokens(1), 1);
});

test('a chunk sized by usableInput * chunkRatio never exceeds the window with output', () => {
  // The user-visible guarantee: chunk input + instruction + output must fit.
  const window = 65536;
  const chunk = computeChunkBudget(window, 0.8);
  const reserved = computeOutputBudget(window);
  // chunk (input) + prompt overhead + output reservation must fit the window.
  assert.ok(chunk + PROMPT_OVERHEAD_TOKENS + reserved <= window, 'input+output fits the window');
  assert.equal(computeChunkBudget(window, 0.8), Math.floor(computeUsableInputTokens(window) * 0.8));
});

test('chunkRatio is a fraction of the USABLE input, not of the raw window', () => {
  const window = 128000;
  const usable = computeUsableInputTokens(window);
  const fullWindowRatio = Math.floor(window * 0.8);
  assert.ok(computeChunkBudget(window, 0.8) < fullWindowRatio, 'never reserves raw-window 80% as input');
  assert.equal(computeChunkBudget(window, 0.5), Math.floor(usable * 0.5));
  // Degenerate window still yields a 1-token chunk.
  assert.equal(computeChunkBudget(1, 0.8), 1);
});
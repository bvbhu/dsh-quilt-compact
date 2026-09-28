/**
 * Test harness: fake LLM service, fake context, and session fixture builder.
 *
 * The fake LLM mimics the DSH adapter contract: failures surface as terminal
 * `finish` chunks with `kind: 'error'` (exactly what `dsh-llm` normalizes to
 * a thrown `LlmError`), and every call is recorded for assertions.
 *
 * @module dsh-quilt-compact/test/helpers
 */
import { Context } from '@deepseek-ai/cordis';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { estimateMessage } from '@deepseek-ai/dsh-token-meter/estimate';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deterministic digest text naming the route and input length. */
function defaultText(options) {
  const first = options.messages[0]?.content?.[0]?.text ?? '';
  return `digest(${options.provider}/${options.model}, len=${String(first).length})`;
}

/**
 * A scriptable fake LLM service.
 * @param behaviors - routeKey (`provider/model`) -> behavior:
 *   `'ok'`, `{ kind: 'ok', text }`, or `{ kind: 'fail', code, message, times }`
 *   (fails the first `times` calls, then succeeds).
 * @param options - `{ contextWindow, latencyMs, emitUsage }`.
 */
export function createFakeLlm(behaviors = {}, options = {}) {
  const calls = [];
  const inflight = new Map();
  let peak = 0;
  const llm = {
    calls,
    inflight,
    get peakConcurrency() {
      return peak;
    },
    behavior(key, behavior) {
      behaviors[key] = behavior;
    },
    async *stream(opts) {
      const key = `${opts.provider}/${opts.model}`;
      calls.push({
        provider: opts.provider,
        model: opts.model,
        messages: opts.messages,
        maxTokens: opts.maxTokens,
        purpose: opts.purpose,
        sessionId: opts.sessionId,
        signal: opts.signal,
      });
      const count = (inflight.get(key) ?? 0) + 1;
      inflight.set(key, count);
      peak = Math.max(peak, count);
      try {
        if (options.latencyMs) await sleep(options.latencyMs);
        let behavior = behaviors[key] ?? { kind: 'ok', text: defaultText(opts) };
        if (typeof behavior === 'string') behavior = { kind: behavior };
        if (behavior.kind === 'fail') {
          const failure = { message: behavior.message ?? 'provider boom', code: behavior.code ?? 'SERVER' };
          if (behavior.times !== undefined) {
            behavior.times -= 1;
            if (behavior.times < 0) behavior = { kind: 'ok', text: defaultText(opts) };
          }
          if (behavior.kind === 'fail') {
            yield { type: 'finish', reason: { kind: 'error', failure } };
            return;
          }
        }
        const text = behavior.text ?? defaultText(opts);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        if (options.emitUsage) {
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } };
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
      } finally {
        inflight.set(key, Math.max(0, count - 1));
      }
    },
    async resolveModelInfo(provider, model) {
      return { provider, model, name: model, context: { contextWindow: options.contextWindow ?? 128000 } };
    },
  };
  return llm;
}

/** A token-meter stand-in that prices the live session surface heuristically. */
export const fakeTokenMeter = {
  measure(session) {
    const nodes = session.surface.nodes.map((seq) => {
      const message = session.deriveEventMessage(session.eventAt(seq));
      const tokens = message === null ? 0 : estimateMessage(message);
      return { seq, tokens, heuristicTokens: tokens };
    });
    return { nodes, totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0) };
  },
};

/**
 * Build a cordis Context with fakes wired: `llm`, `tokenMeter`, `sessions`,
 * and a logger stub. The returned `logger` records every call for
 * assertions (`logger.records`).
 * @param options - forwarded to {@link createFakeLlm}.
 */
export function createTestContext(options = {}) {
  const ctx = new Context();
  const records = [];
  const logger = {
    records,
    debug(...args) {
      records.push(['debug', ...args]);
    },
    info(...args) {
      records.push(['info', ...args]);
    },
    warn(...args) {
      records.push(['warn', ...args]);
    },
    error(...args) {
      records.push(['error', ...args]);
    },
  };
  ctx.logger = logger;
  const llm = createFakeLlm(options.behaviors, options);
  ctx.llm = llm;
  ctx.tokenMeter = fakeTokenMeter;
  ctx.sessions = { flush: async () => true };
  return { ctx, llm, logger };
}

/**
 * Build a seeded, detached Session with a system head and N user messages.
 * @param n - number of user messages after the system head.
 * @param line - content repeated per user message (default a long factual line).
 * @returns `{ session, seqs: { system, users: number[] } }`.
 */
export function buildSession(n = 3, line) {
  const seed = [];
  let seq = 0;
  const timeBase = Date.now();
  const push = (type, data, opts) => {
    seed.push({ type, seq: seq++, time: timeBase + seq, data, ...(opts ?? {}) });
  };
  push('turn/start', { turn: 1 });
  push('system/message', {
    turn: 1,
    step: 1,
    message: {
      role: 'system',
      id: 'msg-sys',
      content: [{ type: 'text', text: 'You are a helpful assistant.' }],
      source: { kind: 'system-prompt' },
    },
  }, { surfaceOp: 'append' });
  const text = line ?? 'line about the project config and build steps with exact paths and decisions '.repeat(30);
  const users = [];
  for (let index = 1; index <= n; index += 1) {
    const seqAt = seq;
    users.push(seqAt);
    push('user/message', {
      role: 'user',
      id: `msg-u${index}`,
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' });
  }
  const session = Session.create(SessionId(`s-fixture-${n}-${Date.now()}`), seed);
  return { session, seqs: { system: 1, users } };
}

/** Standard agent context wrapping a session. */
export function agentFor(session, options = { provider: 'session-p', model: 'session-m' }) {
  return { session, options };
}

/** Build the default two-tier test config used by most tests. */
export function defaultEngineConfig(overrides = {}) {
  return {
    tiers: [
      {
        name: 'primary',
        models: [
          { provider: 'p1', model: 'm1', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 5 } },
          { provider: 'p1', model: 'm2', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 5 } },
        ],
      },
      {
        name: 'fallback-tier',
        models: [
          { provider: 'p2', model: 'm3', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 5 } },
        ],
      },
    ],
    ...overrides,
  };
}

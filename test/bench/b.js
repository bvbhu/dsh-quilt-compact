/**
 * **Suite B — Retrieval over the compressed history.** Measures whether the
 * compaction is searchable: does a `grep`-like tool still surface the relevant
 * line from the compacted context?
 *
 * @module dsh-quilt-compact/test/bench/b
 */
import { createFakeLlm } from './llm.js';
import { buildEpisode } from './sessions.js';
import { QuiltCompactEngine } from '../../lib/index.js';
import { surfaceText, contextChars } from './metrics.js';
import { createTestContext } from '../helpers/fixture.js';
import { planRetention } from './a.js';
import { BENCH_CONTEXT_WINDOW } from './matrix.js';

/** Count lines matching a needle, case-insensitively. */
function grepCount(text, needle) {
  const target = needle.toLowerCase();
  return text.split('\n').filter((line) => line.toLowerCase().includes(target)).length;
}

/**
 * Build the compacted SEEDED variant that keeps the whole section intact, so
 * the retrieval question has something to find.
 * @param options.episode - episode id.
 * @param options.config - engine config.
 * @param options.behavior - summarizer persona.
 * @param options.keepRight - retained recent nodes.
 * @returns `{ beforeText, afterText, beforeChars, afterChars, hits }`.
 */
export async function compactWholeHistory(options) {
  const { episode, config, behavior = 'perfect', keepRight = 2 } = options;
  const { session } = buildEpisode(episode);
  // Swap in the benchmark's scripted summarizer: the shared fixture's stub
  // answers with a constant digest that ignores its prompt, which would make
  // every variant score identically. See the rationale in `a.js`.
  const { ctx } = createTestContext({ behavior, contextWindow: BENCH_CONTEXT_WINDOW });
  const llm = createFakeLlm({ behavior, contextWindow: BENCH_CONTEXT_WINDOW });
  ctx.llm = llm;
  const engine = new QuiltCompactEngine(ctx, config);
  // Share Suite A's retention planner so both suites compact the SAME span of
  // the SAME episode: otherwise cross-suite numbers are not comparable.
  const plan = planRetentionWithRetry(session, keepRight);
  const beforeText = historyText(session);
  const beforeChars = contextChars(session);
  await engine.compactRegion(plan.start, plan.end, {
    session,
    options: { provider: 'session-p', model: 'session-m' },
  }, undefined, 'manual');
  return { beforeText, afterText: surfaceText(session), beforeChars, afterChars: contextChars(session) };
}

/**
 * Retention plan for this episode, retried over progressively smaller windows
 * until a tool-pairing-balanced range is found. Thin episodes would otherwise
 * yield a single-node range whose compaction the engine's shrink check rejects.
 * @param session - the episode session.
 * @param keepRight - desired retained recent nodes.
 * @returns a usable plan.
 */
function planRetentionWithRetry(session, keepRight) {
  for (let window = keepRight; window >= 1; window -= 1) {
    const plan = planRetention(session, window);
    if (plan !== null) return plan;
  }
  throw new Error('no tool-pairing-balanced compaction range exists for this episode');
}

/** Render the full session history (all events) as searchable text. */
export function historyText(session) {
  return session.snapshotEvents()
    .map((event) => {
      const message = session.deriveEventMessage(event);
      if (message === null) return null;
      const body = (message.content ?? []).map((block) => block.text ?? '').join('');
      return `${String(event.type)}: ${body}`;
    })
    .filter((line) => line !== null)
    .join('\n');
}

/**
 * Run the retrieval suite: for each needle the compaction should still answer,
 * count hits before and after.
 * @param options.episodes - episodes to run.
 * @param options.config - engine config.
 * @param options.behavior - summarizer persona.
 * @param options.keepRight - retained recent nodes.
 * @returns per-episode, per-needle hit counts.
 */
export async function suiteB(options = {}) {
  const {
    episodes = ['code-debug', 'ci-log', 'refactor'],
    config,
    behavior = 'perfect',
    keepRight = 2,
  } = options;
  const rows = [];
  for (const episode of episodes) {
    const { beforeText, afterText, beforeChars, afterChars } = await compactWholeHistory({
      episode, config, behavior, keepRight,
    });
    const needles = retrievalNeedles(episode);
    const records = needles.map((needle) => ({
      needle,
      before: grepCount(beforeText, needle),
      after: grepCount(afterText, needle),
    }));
    const answeredBefore = records.filter((record) => record.before > 0).length;
    const answeredAfter = records.filter((record) => record.after > 0).length;
    rows.push({
      episode,
      answeredBefore,
      answeredAfter,
      recall: answeredBefore === 0 ? null : answeredAfter / answeredBefore,
      beforeChars,
      afterChars,
      ratio: beforeChars === 0 ? null : afterChars / beforeChars,
      records,
    });
  }
  return rows;
}

/**
 * The grep targets one episode must still answer after compression.
 * @param episode - episode id.
 * @returns needles drawn from the ground-truth tokens.
 */
export function retrievalNeedles(episode) {
  const table = {
    'code-debug': ['Token has expired', 'clock skew', 'src/auth/token.ts', 'helpers.idOf', 'setSkew'],
    'ci-log': ['SIGKILL', 'gh-xlarge-08', 'ci/integration.yml', 'SHARD_INDEX', '7 GiB'],
    refactor: ['Option B', 'UserFacade.ts', 'deleteUser', 'inheritance', 'PasswordResetPolicy.ts'],
  };
  return table[episode] ?? [];
}

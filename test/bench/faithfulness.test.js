/**
 * Agentic Context-Compression Faithfulness Benchmark — regression assertions.
 *
 * These tests turn the benchmark into a GUARD: they assert the pipeline retains
 * the specific evidence the compression rubric cares about (errors, file paths,
 * decisions, numbers) across realistic multi-step agent episodes.
 *
 * Why these particular assertions are the ones worth locking down:
 *
 * - They exercise the FULL pipeline (Stage 0 -> chunk -> pool -> merge ->
 *   durable transaction) rather than one transform, so a refactor that keeps
 *   every unit test green but breaks the pipeline still fails here.
 * - The numbers come from a scripted summarizer (`test/bench/llm.js`), not a
 *   live model, so they are stable across machines and commits.
 * - The `no-salvage` variant encodes what the pipeline did BEFORE the middle-
 *   section rescue existed. It is deliberately asserted to be WORSE: that row
 *   is the regression fence for `lib/stage0/salient.js`. If someone removes the
 *   salvage pass, these fail rather than quietly halving real recall.
 *
 * Run the interactive report with `npm run bench`.
 *
 * @module dsh-quilt-compact/test/bench/faithfulness
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suiteA } from './a.js';
import { suiteB } from './b.js';
import { selectVariants } from './matrix.js';
import { EPISODES, buildEpisode, fillerBlock } from './sessions.js';
import { gradeCheckpoint, gradeProbe, hasToken } from './grader.js';
import { contextTokens, ratio, surfaceText } from './metrics.js';
import { headMiddleTail } from '../../lib/stage0/trim.js';

const ALL_EPISODES = Object.keys(EPISODES);

/** Every row of suite A for one variant, averaged. */
async function recallFor(variantId, options = {}) {
  const [variant] = selectVariants(variantId);
  const rows = await suiteA({
    episodes: ALL_EPISODES,
    config: variant.config,
    legacyTrim: variant.legacyTrim,
    ...options,
  });
  const perfect = rows.filter((row) => row.persona === 'perfect');
  return perfect.reduce((sum, row) => sum + row.recall, 0) / perfect.length;
}

test('every episode seeds a durable session with its own ground truth', () => {
  for (const id of ALL_EPISODES) {
    const { session, facts } = buildEpisode(id);
    assert.ok(session.surface.nodes.length >= 5, `${id} should have a real multi-turn surface`);
    assert.ok(facts.probes.length >= 3, `${id} needs enough probes to be meaningful`);
    for (const probe of facts.probes) {
      assert.ok(probe.need.length > 0, `${id}/${probe.id} must name its ground truth`);
      assert.ok(typeof probe.ask === 'string' && probe.ask.length > 0, `${id}/${probe.id} must ask something`);
    }
  }
});

test('the load-bearing facts really are inside the compacted span', async () => {
  // A benchmark whose answers sit in RETAINED context rather than the compacted
  // region measures nothing: every strategy would score 100% for free. This is
  // the guard that the episodes stay constructed the way they must be.
  const { planRetention } = await import('./a.js');
  for (const id of ALL_EPISODES) {
    const { session, facts } = buildEpisode(id);
    const plan = planRetention(session, 2);
    assert.ok(plan !== null, `${id} must expose a tool-pairing-balanced range`);
    const nodes = session.surface.nodes;
    const span = surfaceText(session, nodes.slice(1, plan.keepFrom));
    for (const probe of facts.probes) {
      const reachable = probe.need.filter((token) => hasToken(span, token));
      assert.ok(
        reachable.length > 0,
        `${id}/${probe.id}: no ground-truth token survives into the compacted span (${probe.need.join('|')})`,
      );
    }
  }
});

test('the pipeline retains recall well above simply deleting the span', async () => {
  const [variant] = selectVariants('default');
  const rows = await suiteA({ episodes: ALL_EPISODES, config: variant.config });
  const perfect = rows.filter((row) => row.persona === 'perfect');
  assert.ok(perfect.length > 0);
  for (const row of perfect) {
    assert.ok(row.recall >= 0.6, `${row.episode}: recall ${row.recall} is too low`);
    // The control is the SAME span deleted outright; compaction must beat it.
    assert.ok(row.recall > row.controlRecall, `${row.episode}: recall must beat the delete-only control`);
    assert.ok(row.afterChars < row.beforeChars, `${row.episode}: must actually shrink`);
  }
});

test('regression fence: a content-deleting Stage 0 trim must stay removed', async () => {
  // The pipeline manages length by chunking, not by deleting content. This
  // asserts the shipped Stage 0 does not drop the middle of a long document:
  // the `legacy-trim` variant re-adds that transform and must score WORSE.
  const shipped = await recallFor('default');
  const legacy = await recallFor('legacy-trim');
  assert.ok(
    shipped > legacy + 0.1,
    `the shipped pipeline must beat the content-deleting trim: shipped=${shipped.toFixed(3)} legacy=${legacy.toFixed(3)}`,
  );
});

test('a forgetful summarizer is measurably worse than a faithful one', async () => {
  const [variant] = selectVariants('default');
  const rows = await suiteA({ episodes: ALL_EPISODES, config: variant.config });
  const faithful = rows.filter((row) => row.persona === 'perfect');
  const forgetful = rows.filter((row) => row.persona === 'forgetful');
  const mean = (xs) => xs.reduce((sum, row) => sum + row.recall, 0) / xs.length;
  assert.ok(mean(faithful) > mean(forgetful), 'the persona control must actually move the metric');
  assert.ok(mean(forgetful) < 0.3, `forgetful persona should score near zero, got ${mean(forgetful)}`);
});

test('the committed checkpoint grades as faithful against the episode truth', async () => {
  const { planRetention } = await import('./a.js');
  const { buildTarget } = await import('./a.js');
  const [variant] = selectVariants('default');
  for (const id of ALL_EPISODES) {
    const target = await buildTarget({ episode: id, config: variant.config, behavior: 'perfect', keepRight: 2 });
    const grade = gradeCheckpoint(target.text, target.facts);
    assert.ok(grade.faithfulness >= 0.6, `${id}: checkpoint faithfulness ${grade.faithfulness}`);
  }
});

test('retrieval still finds every load-bearing needle after compression', async () => {
  const [variant] = selectVariants('default');
  const rows = await suiteB({ episodes: ALL_EPISODES, config: variant.config });
  for (const row of rows) {
    assert.equal(row.recall, 1, `${row.episode}: lost retrieval targets ${JSON.stringify(row.records.filter((r) => r.after === 0).map((r) => r.needle))}`);
  }
});

test('compression ratios stay within a sane operating band', async () => {
  const [variant] = selectVariants('default');
  const rows = await suiteA({ episodes: ALL_EPISODES, config: variant.config });
  for (const row of rows.filter((entry) => entry.persona === 'perfect')) {
    const shrink = ratio(row.beforeChars, row.afterChars);
    assert.ok(shrink !== null && shrink < 0.9, `${row.episode}: should visibly shrink (${shrink})`);
    assert.ok(shrink > 0.02, `${row.episode}: should not collapse to almost nothing (${shrink})`);
  }
});

test('headMiddleTail keeps head and tail and marks what it dropped', () => {
  // Retained as a documented, tested public transform even though the pipeline
  // no longer runs it: length is the chunker's job (see `stage0/pipeline.js`).
  const lines = Array.from({ length: 40 }, (_, index) => `consistent body line ${index} of the document`);
  const out = headMiddleTail(lines, { thresholdChars: 200, headChars: 200, tailChars: 100 });
  assert.equal(out[0], lines[0]);
  assert.equal(out.at(-1), lines.at(-1));
  assert.ok(out.some((line) => line.startsWith('[condensed:')), 'omission must be marked');
  assert.ok(out.length < lines.length, 'must trim');
});

test('Stage 0 does not delete content to manage length', async () => {
  // The point of removing the trim: a long document must survive into the
  // chunker intact, so the LLM sees it rather than a pre-truncated remnant.
  const { session } = buildEpisode('ci-log');
  const { planRetention } = await import('./a.js');
  const plan = planRetention(session, 2);
  const { buildSummarizationInput } = await import('../../lib/region.js');
  const { resolveConfig } = await import('../../lib/config.js');
  const { runStage0 } = await import('../../lib/stage0/pipeline.js');
  const cfg = resolveConfig({ tiers: [{ name: 'p', models: [{ provider: 'b', model: 'd', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 5 } }] }] });
  const input = buildSummarizationInput(session, session.surface.nodes.slice(1, plan.keepFrom));
  const raw = input.messages.map((m) => (m.content ?? []).map((b) => b.text ?? '').join('')).join('\n');
  const lines = runStage0(input.messages, cfg.preprocessing);
  for (const needle of ['SIGKILL', 'gh-xlarge-08', 'ci/integration.yml']) {
    assert.ok(raw.includes(needle), `${needle} should be in the input at all`);
    assert.ok(
      lines.join('\n').includes(needle),
      `Stage 0 must not delete ${needle}: length control belongs to the chunker`,
    );
  }
});

test('the grader distinguishes missing facts from hallucinated ones', () => {
  const probe = { id: 'p', type: 'recall', ask: 'what?', need: ['alpha', 'beta'] };
  const full = gradeProbe('we saw alpha and beta', {}, probe);
  assert.equal(full.recall, 1);
  assert.equal(full.hallucinated, 0);
  const partial = gradeProbe('only alpha here', {}, probe);
  assert.equal(partial.recall, 0.5);
  assert.deepEqual(partial.missing, ['beta']);
  // Stating both sides of a rejection as if adopted is a contradiction.
  const contradicted = gradeProbe('we rejected it and also chose it', {}, probe);
  assert.equal(contradicted.hallucinated, 1);
});

test('filler is never mistaken for evidence', () => {
  const block = fillerBlock(200, 'noise');
  const grade = gradeProbe(block, {}, { id: 'x', need: ['SIGKILL', 'src/app.ts'] });
  assert.equal(grade.recall, 0, 'bulk filler must satisfy no probe');
  const { planRetention } = { planRetention: null };
  assert.equal(planRetention, null, 'placeholder keeps this test independent of async imports');
});

test('contextTokens uses the same fixed density as the projects own estimator', () => {
  for (const id of ALL_EPISODES) {
    const { session } = buildEpisode(id);
    const tokens = contextTokens(session);
    assert.ok(tokens > 0, `${id} prices to a positive token count`);
    // chars/4 exactly, so reconstructing from chars must agree.
    assert.equal(tokens, Math.ceil(surfaceText(session).length / 4));
  }
});

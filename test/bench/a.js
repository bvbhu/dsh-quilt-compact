/**
 * **Suite A — Faithfulness under proven recontainment** (`suiteA`).
 *
 * Whether the post-compaction context still supports the task: after the
 * compacted span is REMOVED from what the model can see, can it still answer
 * questions whose answers live only in that span? Two configurations can post
 * the same "tokens saved" number while differing enormously in FUNCTIONAL
 * retention, so the ratio alone is not the metric — the metric is whether the
 * surviving checkpoint still carries the answers.
 *
 * The experiment is a paired comparison over one seeded episode:
 *
 * - target branch: the real compacted surface (checkpoint replaced the span).
 * - control branch: the SAME window with the span simply DELETED.
 *
 * Both are then answered strictly from retained evidence, so a higher score is
 * attributable to what compaction preserved rather than to leftover transcript.
 *
 * @module dsh-quilt-compact/test/bench/a
 */
import { createFakeLlm } from './llm.js';
import { BENCH_CONTEXT_WINDOW } from './matrix.js';
import { buildEpisode } from './sessions.js';
import { QuiltCompactEngine } from '../../lib/index.js';
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';
import { runStage0 } from '../../lib/stage0/pipeline.js';
import { headMiddleTail } from '../../lib/stage0/trim.js';
import { gradeProbe } from './grader.js';
import { contextChars, surfaceText } from './metrics.js';
import { createTestContext } from '../helpers/fixture.js';

/**
 * Wire the REAL cordis context the unit tests use, then swap in a summarizer.
 *
 * Two lanes:
 *
 * - deterministic (default): `createFakeLlm` personas. Cheap, stable, run on
 *   every commit.
 * - real-model (`llmFactory`): a thin wrapper over a live `ctx.llm.stream`.
 *   Expensive and nondeterministic — run periodically/release, not in CI. The
 *   wrapper keeps the SAME `stream()` contract the engine already calls, so the
 *   whole pipeline (Stage 0 -> chunk -> merge -> transaction) is exercised with
 *   a real model reading real prompts.
 *
 * The shared fixture's `createFakeLlm` answers with a constant
 * `digest(route, len=N)` stub, which deliberately says nothing about what the
 * pipeline fed it. That is correct for plumbing tests but fatal here: a
 * benchmark would then measure only whether calls happened, and every variant
 * would score identically. The pipeline must be exercised end to end, so the
 * summarizer has to actually read its prompt.
 *
 * @param options - options forwarded to {@link createFakeLlm} (persona), plus
 *   optional `llmFactory` returning a real summarizer.
 * @returns `{ ctx, llm }`.
 */
function newContext(options = {}) {
  const { ctx } = createTestContext(options);
  const llm = options.llmFactory !== undefined
    ? options.llmFactory(ctx, options)
    : createFakeLlm(options);
  ctx.llm = llm;
  return { ctx, llm };
}

/**
 * Slice the surface: keep node 0 (system) and the last `keepRight` nodes,
 * drop everything else — but SNAP the boundary to a tool-pairing-balanced cut.
 *
 * A compaction range may not split a tool call from its result (the engine's
 * `selectCompactableRange` and `validateSurfaceRegion` both enforce this), so
 * the retained tail cannot start anywhere: it has to start at a position where
 * no tool call is still open. Walking backwards to the nearest balanced cut is
 * what the engine itself does, so the benchmark measures a range the harness
 * would genuinely compact.
 *
 * @param session - the episode session.
 * @param keepRight - desired number of retained recent surface nodes.
 * @returns `{ start, end, keepFrom }` for the compactable range, or `null`
 *   when no balanced range exists.
 */
export function planRetention(session, keepRight) {
  const nodes = session.surface.nodes;
  // Leave at least the system head plus `keepRight` nodes behind, so the
  // retained window stays comparable across episodes of different lengths.
  let keepFrom = Math.max(1, Math.min(nodes.length - keepRight, nodes.length - 1));
  while (keepFrom > 1 && !toolPairingBalancedBefore(session, nodes[keepFrom])) keepFrom -= 1;
  if (keepFrom <= 1) return null;
  return { start: nodes[1], end: nodes[keepFrom - 1], keepFrom };
}

/**
 * Build the target branch: compact the range through the engine under test.
 * @param options.episode - episode id.
 * @param options.config - engine config overrides.
 * @param options.behavior - summary model persona.
 * @param options.keepRight - retained recent surface nodes.
 * @returns branch description `{ text, meta }`.
 */
export async function buildTarget(options) {
  const { episode, config, behavior, keepRight } = options;
  const { session, facts } = buildEpisode(episode);
  const plan = planRetention(session, keepRight);
  const { ctx, llm } = newContext({
    behavior,
    contextWindow: BENCH_CONTEXT_WINDOW,
    ...(options.llmFactory === undefined ? {} : { llmFactory: options.llmFactory }),
  });
  const engine = new QuiltCompactEngine(ctx, config);
  // `legacyTrim` restores a Stage 0 transform the pipeline no longer runs, so
  // the ablation compares the same engine with and without it.
  if (options.legacyTrim !== undefined) applyLegacyTrim(engine, options.legacyTrim);
  const beforeChars = contextChars(session);
  await engine.compactRegion(plan.start, plan.end, {
    session,
    options: { provider: 'session-p', model: 'session-m' },
  }, undefined, 'manual');
  const afterChars = contextChars(session);
  return {
    session,
    facts,
    text: surfaceText(session),
    meta: {
      beforeChars,
      afterChars,
      calls: llm.calls.length,
    },
  };
}

/**
 * Re-wrap an engine's Stage 0 hook so the ablation can restore the legacy
 * content-deleting trim on an otherwise identical engine.
 *
 * @param engine - the engine under test.
 * @param config - `{ thresholdChars, headChars, tailChars }` for the trim.
 */
function applyLegacyTrim(engine, config) {
  engine.runStage0 = (messages) => headMiddleTail(
    runStage0(messages, engine.config.preprocessing),
    config,
  );
}

/**
 * Build the control branch: NO compaction, just delete the same span.
 * @param options - same shape as {@link buildTarget}.
 */
export function buildControl(options) {
  const { episode, keepRight } = options;
  const { session, facts } = buildEpisode(episode);
  const plan = planRetention(session, keepRight);
  const beforeChars = contextChars(session);
  const nodes = session.surface.nodes;
  const keptSeqs = [nodes[0], ...nodes.slice(plan.keepFrom)];
  return {
    session,
    facts,
    text: surfaceText(session, keptSeqs),
    meta: { beforeChars, afterChars: beforeChars, calls: 0 },
  };
}

/**
 * Answer one probe strictly from the retained context using the same scripted
 * summarizer.
 */
export function answerByProbe(branch, probe, options = {}) {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: branch.text }] },
    { role: 'user', content: [{ type: 'text', text: `Answer strictly from the context above: ${probe.ask}` }] },
  ];
  return messages;
}

/**
 * Run Suite A over the selected episodes.
 * @param options.episodes - episode ids to run.
 * @param options.config - engine config.
 * @param options.behavior - summarizer persona for compaction.
 * @param options.keepRight - retained recent nodes (the "window").
 * @param options.personas - personas whose probe answers are compared.
 * @param options.legacyTrim - restores the removed content-deleting trim.
 * @param options.llmFactory - optional real-model summarizer factory.
 * @returns rows, one per episode+persona.
 */
export async function suiteA(options = {}) {
  const {
    episodes = ['code-debug', 'ci-log', 'refactor'],
    config,
    behavior = 'perfect',
    keepRight = 2,
    personas = ['perfect', 'leak', 'forgetful'],
    legacyTrim,
    llmFactory,
  } = options;
  const rows = [];
  for (const episode of episodes) {
    const target = await buildTarget({ episode, config, behavior, keepRight, legacyTrim, llmFactory });
    const control = buildControl({ episode, keepRight });
    for (const persona of personas) {
      const records = [];
      let recall = 0;
      let controlRecall = 0;
      let hallucinationCount = 0;
      for (const probe of target.facts.probes) {
        const answer = summarizeForProbe(target, probe, persona);
        const controlAnswer = summarizeForProbe(control, probe, persona);
        const grade = gradeProbe(answer, target.facts, probe);
        const controlGrade = gradeProbe(controlAnswer, target.facts, probe);
        recall += grade.recall;
        controlRecall += controlGrade.recall;
        hallucinationCount += grade.hallucinated;
        records.push({
          probe: probe.id,
          recall: grade.recall,
          controlRecall: controlGrade.recall,
          missing: grade.missing,
          hallucinated: grade.hallucinated,
        });
      }
      const probes = target.facts.probes.length;
      rows.push({
        episode,
        persona,
        recall: recall / probes,
        controlRecall: controlRecall / probes,
        gain: (recall - controlRecall) / probes,
        hallucination: hallucinationCount / probes,
        beforeChars: target.meta.beforeChars,
        afterChars: target.meta.afterChars,
        calls: target.meta.calls,
        records,
      });
    }
  }
  return rows;
}

/**
 * Use the scripted summarizer as the "answerer" of one probe: it can only
 * repeat what survived into the context it is shown, which is exactly the
 * property Suite A measures.
 */
function summarizeForProbe(branch, probe, persona) {
  const messages = answerByProbe(branch, probe, { behavior: persona });
  const material = messages.map((message) => message.content[0].text).join('\n');
  if (persona === 'forgetful') return 'I do not have that information.';
  const lines = material.split('\n');
  if (persona === 'leak') return lines.filter((line, index) => index % 4 !== 3).join('\n');
  return material;
}



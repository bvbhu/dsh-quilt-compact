/**
 * Surface retention selection and the shared durable compaction transaction.
 *
 * This module is a close port of `dsh-compaction-basic`'s region machinery
 * (the reference implementation of the `CompactionEngine` seam), with one
 * deliberate difference: shadowed pricing uses the pure fixed-density
 * estimators (`@deepseek-ai/dsh-token-meter/estimate`) over the replayed
 * messages instead of a live `ctx.tokenMeter.measure()` snapshot. The region
 * is text-only (images/files project to placeholder lines in Stage 0), so
 * one heuristic price is consistent for both the audit field and the
 * "summary must be smaller" check.
 *
 * @module dsh-quilt-compact/region
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction';
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm';
import { estimateMessage } from '@deepseek-ai/dsh-token-meter/estimate';
import { SessionSeq } from '@deepseek-ai/dsh-session';

/** Reject a summary whose replacement boundaries are no longer the ones it was built from. */
class SurfaceChangedError extends Error {}

/** The `system/message` holding surface node 0, or `undefined` without one. */
function systemHead(session, headSeq) {
  const head = session.eventAt(headSeq);
  return head.type === 'system/message' ? head : undefined;
}

/**
 * Resolve the next range starting at the first non-system surface node while
 * retaining a priced recent tail and never splitting an assistant
 * tool-call/result pair.
 * @param session - session supplying authoritative surface positions.
 * @param nodes - priced surface nodes (`TokenMeasurement.nodes` shape).
 * @param retainTokens - minimum recent tail budget retained verbatim.
 * @returns the inclusive positional seq range to compact, or `null`.
 */
export function selectCompactableRange(session, nodes, retainTokens) {
  if (nodes.length === 0) return null;
  const surfaceNodes = session.surface.nodes;
  if (surfaceNodes.length !== nodes.length || surfaceNodes.some((seq, index) => seq !== nodes[index]?.seq)) {
    throw new Error('compaction: token surface does not match the current session surface');
  }
  const firstIdx = systemHead(session, surfaceNodes[0]) === undefined ? 0 : 1;
  let accumulated = 0;
  let keepFromIdx = nodes.length;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    accumulated += nodes[index].tokens;
    keepFromIdx = index;
    if (accumulated >= retainTokens) break;
  }
  if (keepFromIdx <= firstIdx) return null;
  while (keepFromIdx > firstIdx) {
    if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])) break;
    keepFromIdx -= 1;
  }
  if (keepFromIdx <= firstIdx) return null;
  return {
    start: surfaceNodes[firstIdx],
    end: surfaceNodes[keepFromIdx - 1],
  };
}

/**
 * Run the single compaction transaction over one selected positional span.
 * Selection and validation are read-only; `compaction/start` is the durable
 * lock before summarization yields. Every later failure makes exactly one
 * `compaction/end` attempt.
 *
 * @param deps - `{ summarize, recover, estimateMessage }` (see engine).
 * @param session - session whose surface is mutated.
 * @param start - inclusive first surface-node seq.
 * @param end - inclusive last surface-node seq.
 * @param agent - agent used by the summarizer.
 * @param options - bracket owner, stability rule, optional durability checkpoint.
 * @param signal - optional summarization cancellation signal.
 * @returns the successful durable compaction result.
 */
export async function compactSurfaceRegion(deps, session, start, end, agent, options, signal) {
  if (options.owner === null) signal?.throwIfAborted();
  const selection = validateSurfaceRegion(session, start, end);
  const entryState = inspectCompactionEntryState(session);
  assertCompactionInactive(entryState.unmatchedCompactionStart, entryState.latestEndSeedSeq, 'compaction');
  let owner;
  if (options.owner === null) {
    if (entryState.openTurn !== null) throw new ManualCompactionError('busy', 'manual compaction: the session already has an open turn');
    owner = null;
  } else {
    if (entryState.openTurn === null) throw new Error('compactRegion: no open turn — automatic compaction events must be enclosed in a turn');
    owner = entryState.openTurn;
  }
  const compactionId = CompactionId(randomUUID());
  const lifecycle = {
    compactionId,
    ...options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId },
    turn: owner,
  };
  const startEvent = session.append('compaction/start', lifecycle);
  const assertStable = options.stability === 'whole-surface' ? assertWholeSurfaceUnchanged : assertSelectedSpanStable;
  let failure;
  let flushFailure;
  let result;
  let closed = false;
  let closing = false;
  let stage = 'summary';
  try {
    const summarized = await summarizeCompaction(deps, prepareCompaction(deps, session, selection), agent, compactionId, options.sourceCommandId, assertStable, signal);
    if (options.owner === null) signal?.throwIfAborted();
    assertStable(deps, session, summarized);
    stage = 'commit';
    const pending = commitCompactionBody(session, startEvent, summarized);
    closing = true;
    const endEvent = session.append('compaction/end', lifecycle);
    closed = true;
    result = completeCompaction(pending, endEvent);
  } catch (error) {
    failure = { error, stage: closing ? 'commit' : stage };
    if (!closing) {
      closing = true;
      try {
        session.append('compaction/end', { ...lifecycle, error: errorChain(error) });
        closed = true;
      } catch (closeError) {
        failure = { error: closeError, stage: 'commit' };
      }
    }
  }
  if (closed && options.flush !== undefined) {
    try {
      await options.flush();
    } catch (error) {
      flushFailure = error;
    }
  }
  if (options.owner === null) signal?.throwIfAborted();
  if (failure !== undefined) {
    if (options.owner === null) throwManualFailure(failure);
    throw failure.error;
  }
  if (flushFailure !== undefined) {
    throw new ManualCompactionError('persistence', 'manual compaction durability checkpoint failed', { cause: flushFailure });
  }
  if (result === undefined) throw new Error('compaction committed without a result');
  return result;
}

/** Classify one closed manual attempt without weakening cancellation precedence. */
function throwManualFailure(failure) {
  if (failure.stage === 'commit') {
    throw new ManualCompactionError('commit', 'manual compaction did not commit cleanly', { cause: failure.error });
  }
  if (failure.error instanceof SurfaceChangedError) {
    throw new ManualCompactionError('changed', 'the compacted history changed during manual compaction', { cause: failure.error });
  }
  throw new ManualCompactionError('summary', 'manual compaction could not produce a smaller summary', { cause: failure.error });
}

/** Reject a durable unmatched compaction marker unless a later seed boundary proves it stale. */
function assertCompactionInactive(unmatchedCompactionStart, latestEndSeedSeq, stage) {
  if (unmatchedCompactionStart === undefined
    || (latestEndSeedSeq !== undefined && latestEndSeedSeq > unmatchedCompactionStart.seq)) {
    return;
  }
  throw new ManualCompactionError('busy', `${stage}: compaction already in progress; the session compaction lock is already active`);
}

/** Recheck the durable lock after an asynchronous policy decision. */
export function assertNoActiveCompaction(session, stage) {
  const entryState = inspectCompactionEntryState(session);
  assertCompactionInactive(entryState.unmatchedCompactionStart, entryState.latestEndSeedSeq, stage);
}

/** Validate one requested surface-position span before asynchronous work begins. */
export function validateSurfaceRegion(session, start, end) {
  const nodes = session.surface.nodes;
  const startIdx = nodes.indexOf(start);
  const endIdx = nodes.indexOf(end);
  if (startIdx === -1) throw new Error(`compactRegion: start seq ${start} not found in surface`);
  if (endIdx === -1) throw new Error(`compactRegion: end seq ${end} not found in surface`);
  if (startIdx > endIdx) throw new Error(`compactRegion: start seq ${start} (position ${startIdx}) is after end seq ${end} (position ${endIdx}) on the surface`);
  if (!toolPairingBalancedBefore(session, nodes[startIdx])) {
    throw new Error(`compactRegion: start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`);
  }
  if (!toolPairingBalancedAfter(session, nodes[endIdx])) {
    throw new Error(`compactRegion: end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`);
  }
  return {
    start,
    end,
    startIdx,
    endIdx,
    shadowedSeqs: nodes.slice(startIdx, endIdx + 1),
  };
}

/** Snapshot pricing and replay input for a validated surface range. */
function prepareCompaction(deps, session, selection) {
  const regionMessages = selection.shadowedSeqs
    .map((seq) => session.deriveEventMessage(session.eventAt(seq)))
    .filter((message) => message !== null);
  if (regionMessages.length === 0) {
    throw new SurfaceChangedError('compaction: selected surface span produces no messages to condense');
  }
  return {
    ...selection,
    shadowedTokenCount: regionMessages.reduce((sum, message) => sum + deps.estimateMessage(message), 0),
    measurementNodes: deps.measureNodes(session),
    input: buildSummarizationInput(session, selection.shadowedSeqs),
  };
}

/** Run the summarizer and frame its replacement checkpoint. */
async function summarizeCompaction(deps, prepared, agent, compactionId, sourceCommandId, assertStable, signal) {
  let summaryResult;
  for (;;) {
    signal?.throwIfAborted();
    try {
      summaryResult = await deps.summarize(prepared.input, agent, signal);
      break;
    } catch (error) {
      if (signal?.aborted === true) throw error;
      assertStable(deps, agent.session, prepared);
      if (!deps.recover(error, agent, prepared.shadowedSeqs, signal)) throw error;
      prepared = prepareCompaction(deps, agent.session, validateSurfaceRegion(agent.session, prepared.start, prepared.end));
    }
  }
  const checkpointMessage = createUserMessage({
    content: summaryResult.checkpoint,
    source: compactCheckpointSource(compactionId, sourceCommandId),
  });
  const framedSummaryTokenCount = deps.estimateMessage(checkpointMessage);
  if (framedSummaryTokenCount >= prepared.shadowedTokenCount) {
    throw new Error(`summary is not smaller than the shadowed content (${framedSummaryTokenCount} estimated framed tokens >= ${prepared.shadowedTokenCount})`);
  }
  return {
    ...prepared,
    ...summaryResult,
    checkpointMessage,
  };
}

/** Reject a summary prepared against any earlier surface generation. */
function assertWholeSurfaceUnchanged(deps, session, prepared) {
  const nodes = deps.measureNodes(session);
  if (!isDeepStrictEqual(nodes, prepared.measurementNodes)) {
    throw new SurfaceChangedError('compaction: session surface changed during summarization');
  }
}

/** Require the selected span to stay the same present, contiguous, equally priced, balanced target. */
function assertSelectedSpanStable(deps, session, prepared) {
  let current;
  try {
    current = validateSurfaceRegion(session, prepared.start, prepared.end);
  } catch (error) {
    throw new SurfaceChangedError('compaction: the selected span is no longer a valid replacement target', { cause: error });
  }
  if (!isDeepStrictEqual([...current.shadowedSeqs], [...prepared.shadowedSeqs])) {
    throw new SurfaceChangedError('compaction: the selected span changed during summarization');
  }
  const nowTotal = deps.spanPrice(session, current.shadowedSeqs);
  if (nowTotal !== prepared.shadowedTokenCount) {
    throw new SurfaceChangedError('compaction: the selected span was rewritten during summarization');
  }
}

/** Append one completed summary record and replacement body without yielding. */
function commitCompactionBody(session, startEvent, summarized) {
  const {
    start,
    end,
    shadowedSeqs,
    shadowedTokenCount,
    summary,
    provider,
    model,
    maxTokens,
    usage,
    checkpointMessage,
    rawOutput,
  } = summarized;
  const callRecord = {
    ...(rawOutput === undefined ? {} : { rawOutput }),
    llmStreamCall: true,
  };
  const summaryEvent = session.append('compaction/summary', {
    compactionId: startEvent.data.compactionId,
    ...startEvent.data.sourceCommandId === undefined ? {} : { sourceCommandId: startEvent.data.sourceCommandId },
    summary,
    ...callRecord,
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
    provider,
    model,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(usage === undefined ? {} : { usage }),
  });
  session.append('user/message', checkpointMessage, {
    surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
  });
  return {
    compactionId: startEvent.data.compactionId,
    ...startEvent.data.sourceCommandId === undefined ? {} : { sourceCommandId: startEvent.data.sourceCommandId },
    startSeq: startEvent.seq,
    summarySeq: summaryEvent.seq,
    summary,
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
  };
}

/** Attach the successfully appended close event to a pending result. */
function completeCompaction(pending, endEvent) {
  return { ...pending, endSeq: endEvent.seq };
}

/**
 * Reconstruct the last routed request's cacheable prefix for the shadowed
 * region: the system prompt at surface node 0, the header's tool schemas,
 * then the region's own derived messages in surface order.
 */
export function buildSummarizationInput(session, shadowedSeqs) {
  const header = session.requestHeader();
  const head = systemHead(session, session.surface.nodes[0]);
  const system = head === undefined ? null : session.deriveEventMessage(head);
  const regionMessages = shadowedSeqs
    .map((seq) => session.deriveEventMessage(session.eventAt(seq)))
    .filter((message) => message !== null);
  return {
    ...(header?.tools === undefined ? {} : { tools: header.tools }),
    messages: system === null ? regionMessages : [system, ...regionMessages],
  };
}

/** Inspect open-turn, unmatched-compaction, and latest seed-boundary state independently. */
function inspectCompactionEntryState(session) {
  let openTurn = null;
  let openTurnStateKnown = false;
  let unmatchedCompactionStart;
  let compactionEntryStateKnown = false;
  let latestEndSeedSeq;
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(SessionSeq(seq));
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') latestEndSeedSeq = event.seq;
    if (!compactionEntryStateKnown) {
      if (event.type === 'compaction/start') {
        unmatchedCompactionStart = event;
        compactionEntryStateKnown = true;
      } else if (event.type === 'compaction/end') {
        compactionEntryStateKnown = true;
      }
    }
    if (!openTurnStateKnown) {
      if (event.type === 'turn/start') {
        openTurn = event.data.turn;
        openTurnStateKnown = true;
      } else if (event.type === 'turn/end') {
        openTurnStateKnown = true;
      }
    }
    if (openTurnStateKnown && compactionEntryStateKnown && latestEndSeedSeq !== undefined) break;
  }
  return { openTurn, unmatchedCompactionStart, latestEndSeedSeq };
}

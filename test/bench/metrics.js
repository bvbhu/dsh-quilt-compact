/**
 * Token-level metrics shared by every suite.
 * @module dsh-quilt-compact/test/bench/metrics
 */

/** Characters per token under the shared fixed-density heuristic. */
const CHARS_PER_TOKEN = 4;

/**
 * Render one branch's context the way a provider would be charged for it: the
 * derived messages of the nodes still visible, joined by role.
 * @param session - the branch session.
 * @param seqs - optional node subset (defaults to the whole surface).
 * @returns the visible context text.
 */
export function surfaceText(session, seqs) {
  const nodes = seqs ?? session.surface.nodes;
  return nodes.map((seq) => {
    const event = session.eventAt(seq);
    const message = session.deriveEventMessage(event);
    if (message === null) return '';
    const body = (message.content ?? []).map((block) => block.text ?? '').join('\n');
    return `[${String(message.role ?? event.type)}] ${body}`;
  }).join('\n');
}

/**
 * Overall grade for one episode: character size of the visible surface.
 * @param session - branch session.
 * @returns context size in characters.
 */
export function contextChars(session) {
  return surfaceText(session).length;
}

/**
 * Token estimate of the visible context using the project's own heuristic.
 * Keeping this identical to `dsh-token-meter`'s fixed density is what makes
 * these numbers comparable to the plugin's internal shrink check.
 * @param session - branch session.
 * @returns estimated tokens.
 */
export function contextTokens(session) {
  return Math.ceil(contextChars(session) / CHARS_PER_TOKEN);
}

/**
 * Compression ratio for one compaction: after / before.
 * @param before - pre-compaction size.
 * @param after - post-compaction size.
 * @returns ratio in (0, 1] when `before > 0`; `null` otherwise.
 */
export function ratio(before, after) {
  if (before <= 0) return null;
  return after / before;
}

/** Percentage-point helper for reporting. */
export function pct(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

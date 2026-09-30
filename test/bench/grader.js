/**
 * **Grader** for Suite A/B/C — how a "faithful" answer is decided.
 *
 * Every probe carries its own ground truth (`need` tokens). We do NOT grade by
 * LLM-judge here; that would make the pipeline's score depend on whichever
 * model happens to be installed, and two runs of the same commit would not be
 * comparable. Instead we grade by TOKEN RECALL against author-supplied truth:
 *
 *  recall = (matched tokens) / (required tokens)
 *
 * and additionally track two failure modes that a plain F1 would hide:
 *
 * - MISSING: a required token absent from the retrieved context.
 * - HALLUCINATION: a token that contradicts recorded facts ("rejected" flipped
 *   to "chosen", a stale filename presented as current).
 *
 * @module dsh-quilt-compact/test/bench/grader
 */

/**
 * Case-insensitive whole-token presence test.
 * @param text - haystack.
 * @param token - needle, compared case-insensitively.
 */
export function hasToken(text, token) {
  return text.toLowerCase().includes(String(token).toLowerCase());
}

/**
 * Grade one probe answer.
 * @param answer - the answer text the pipeline's context produced.
 * @param facts - the episode ground truth bag.
 * @param probe - probe descriptor carrying `need` tokens.
 * @returns `{ matched, recall, missing, hallucinated }`.
 */
export function gradeProbe(answer, facts, probe) {
  const need = probe.need ?? [];
  const haystack = String(answer ?? '');
  let matched = 0;
  const missing = [];
  for (const token of need) {
    if (hasToken(haystack, token)) matched += 1;
    else missing.push(token);
  }
  return {
    id: probe.id,
    matched,
    required: need.length,
    recall: need.length === 0 ? null : matched / need.length,
    missing,
    hallucinated: detectHallucination(haystack, facts ?? {}, probe) ? 1 : 0,
  };
}

/**
 * Negation verbs and the adoption verbs that contradict them. Recording both
 * sides of a decision as true ("we rejected X" and "we chose X") is the classic
 * compression hallucination: a checkpoint that forgets a refusal re-proposes
 * the rejected option, which is exactly the failure the refactor episode probes.
 */
const REJECTIONS = ['rejected', 'reject', 'declined', 'avoid', 'must not', 'do not', "don't", 'no longer'];
const ADOPTIONS = ['chosen', 'chose', 'adopted', 'selected', 'decided to', 'we will use', 'went with'];

/**
 * Whether an answer states something that contradicts the recorded facts.
 *
 * The checks cover the three ways compression actually corrupts an episode:
 *
 * - a DECISION FLIP: both the rejection and the adoption of a thing in one
 *   answer, which is self-contradictory whatever the subject is;
 * - a STALE IDENTIFIER presented as current, when the episode marked it retired
 *   (`staleTokens`) — how a rename episode gets re-broken;
 * - a foreign CONSTRAINT: for `decision` probes, asserting "rejected" and "we
 *   chose" together is a contradiction even when neither token names the subject.
 *
 * @param answer - the answer text produced from the compacted context.
 * @param facts - episode ground truth (may carry `staleTokens`).
 * @param probe - probe descriptor.
 * @returns true when a contradiction or a stale-name claim is detected.
 */
export function detectHallucination(answer, facts, probe) {
  const text = String(answer ?? '').toLowerCase();
  for (const rejection of REJECTIONS) {
    if (!text.includes(rejection)) continue;
    for (const adoption of ADOPTIONS) {
      if (text.includes(adoption)) return true;
    }
  }
  for (const stale of facts.staleTokens ?? []) {
    const token = String(stale).toLowerCase();
    if (!text.includes(token)) continue;
    if (/still (?:valid|available|supported)|is (?:still )?current|recommended/.test(text)) return true;
  }
  if (probe?.type === 'decision' && text.includes('rejected') && /we (?:also )?(?:chose|chosen|decided|picked)/.test(text)) {
    return true;
  }
  return false;
}

/**
 * Score the CHECKPOINT TEXT ITSELF (the durable artifact), independent of any
 * answering model: does the committed summary contain the facts?
 * @param checkpoint - the committed checkpoint text.
 * @param facts - episode facts carrying `probes`.
 * @returns per-probe checklist result plus the aggregate.
 */
export function gradeCheckpoint(checkpoint, facts) {
  const text = String(checkpoint ?? '');
  const records = (facts.probes ?? []).map((probe) => gradeProbe(text, facts, probe));
  const required = records.reduce((sum, record) => sum + record.required, 0);
  const matched = records.reduce((sum, record) => sum + record.matched, 0);
  return {
    records,
    matched,
    required,
    faithfulness: required === 0 ? null : matched / required,
  };
}

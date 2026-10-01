/**
 * Exact token counting with the DeepSeek V4 tokenizer, plus a conservative
 * per-word/per-character fallback.
 *
 * WHY: the harness's meter prices text at `chars/4` (dsh-token-meter), which
 * is CJK-blind. Real sessions are Chinese-heavy — measured on SenseNova,
 * 84,000 mixed Chinese characters tokenize to ~50,000 tokens (≈1.7 chars per
 * token), so a chunk "sized" at 209k estimated tokens can really be 400k+.
 * The provider rejects the oversized request with an opaque
 * `400 inference request is invalid`, which used to cool every route and kill
 * the compaction. Sizing decisions here therefore use the REAL tokenizer (the
 * same one the DeepSeek V4 models apply server-side). There is NO heuristic
 * fallback: if the tokenizer asset cannot be loaded the failure is loud — a
 * compaction sized by a wrong estimator is worse than no compaction.
 *
 * The tokenizer is `tokenizer.json` (HF `tokenizers` format, ByteLevel BPE,
 * 128k vocab) shipped gzipped at `assets/deepseek-v4-tokenizer.json.gz`; it is
 * parsed lazily once per process. Counting is memoized with a bounded cache —
 * session lines repeat across chunk builds and retry pricing.
 *
 * @module dsh-quilt-compact/tokenizer
 */
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

/** Load and parse the tokenizer once; throws on failure (no fallback). */
let _tokenizer; // { vocab: Map, merges: Map, b2u: string[], u2b: Map } | null
let _loadAttempted = false;

function loadTokenizer() {
  if (_loadAttempted) return _tokenizer;
  _loadAttempted = true;
  try {
    const raw = gunzipSync(readFileSync(new URL('../assets/deepseek-v4-tokenizer.json.gz', import.meta.url)));
    const json = JSON.parse(raw.toString('utf8'));
    const vocab = new Map(Object.entries(json.model.vocab));
    const merges = new Map();
    for (let index = 0; index < json.model.merges.length; index += 1) {
      const merge = json.model.merges[index];
      const space = typeof merge === 'string' ? merge.indexOf(' ') : -1;
      if (space > 0) merges.set(merge, index);
      else if (Array.isArray(merge)) merges.set(`${merge[0]} ${merge[1]}`, index);
    }
    // GPT-2/HF ByteLevel byte<->unicode table: printable bytes map to
    // themselves, everything else to U+0100+ so tokens never need escaping.
    // The mapping MUST match the vocab's serialization exactly.
    const b2u = [];
    const printable = (b) => (b >= 33 && b <= 126) || (b >= 161 && b <= 172) || (b >= 174 && b <= 255);
    let n = 0;
    for (let b = 0; b < 256; b += 1) {
      b2u[b] = printable(b) ? String.fromCharCode(b) : String.fromCharCode(256 + n++);
    }
    _tokenizer = { vocab, merges, b2u };
  } catch {
    _tokenizer = null;
  }
  return _tokenizer;
}

/** The tokenizer's pre-split regexes, applied in order (behavior: Isolated). */
const SPLIT_NUMBER = /\p{N}{1,3}/gu;
const SPLIT_CJK = /[一-龥぀-ゟ゠-ヿ]+/gu;
const SPLIT_WORD = /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~][A-Za-z]+|[^\r\n\p{L}\p{P}\p{S}]?[\p{L}\p{M}]+| ?[\p{P}\p{S}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

/** Split `text` into [between, match, between, match, …] parts. */
function splitIsolated(text, regex) {
  if (text.length === 0) return [text];
  const parts = [];
  let last = 0;
  regex.lastIndex = 0;
  for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(match[0]);
    last = match.index + match[0].length;
    if (match[0].length === 0) regex.lastIndex += 1; // zero-width safety
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const encodeCache = new Map();
const ENCODE_CACHE_MAX = 8192;

/**
 * Count the tokens of one pre-split part under byte-level BPE. Linked-list +
 * min-heap (rank, then position) so a pathological run — 280k identical
 * characters is one pre-token — costs O(n log n) instead of the naive
 * re-scan's O(n²), which hung real compaction sizing.
 */
function bpeCount(symbols, merges) {
  const initial = symbols.length;
  if (initial < 2) return initial;
  const prev = new Int32Array(initial);
  const next = new Int32Array(initial);
  for (let index = 0; index < initial; index += 1) {
    prev[index] = index - 1;
    next[index] = index + 1;
  }
  let alive = initial;

  // Min-heap of candidate merges keyed by (rank, position). Entries are lazy:
  // a pop re-validates the pair it names before merging.
  const heapRank = [];
  const heapPos = [];
  const heapLeft = [];
  const heapRight = [];
  let heapSize = 0;
  function swap(a, b) {
    let v = heapRank[a]; heapRank[a] = heapRank[b]; heapRank[b] = v;
    v = heapPos[a]; heapPos[a] = heapPos[b]; heapPos[b] = v;
    v = heapLeft[a]; heapLeft[a] = heapLeft[b]; heapLeft[b] = v;
    v = heapRight[a]; heapRight[a] = heapRight[b]; heapRight[b] = v;
  }
  function push(rank, pos, left, right) {
    let index = heapSize++;
    heapRank[index] = rank; heapPos[index] = pos; heapLeft[index] = left; heapRight[index] = right;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heapRank[parent] < heapRank[index]
        || (heapRank[parent] === heapRank[index] && heapPos[parent] <= heapPos[index])) break;
      swap(parent, index);
      index = parent;
    }
  }
  function pop() {
    const top = [heapRank[0], heapPos[0], heapLeft[0], heapRight[0]];
    heapSize -= 1;
    if (heapSize > 0) {
      heapRank[0] = heapRank[heapSize]; heapPos[0] = heapPos[heapSize];
      heapLeft[0] = heapLeft[heapSize]; heapRight[0] = heapRight[heapSize];
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < heapSize && (heapRank[left] < heapRank[smallest]
          || (heapRank[left] === heapRank[smallest] && heapPos[left] < heapPos[smallest]))) smallest = left;
        if (right < heapSize && (heapRank[right] < heapRank[smallest]
          || (heapRank[right] === heapRank[smallest] && heapPos[right] < heapPos[smallest]))) smallest = right;
        if (smallest === index) break;
        swap(index, smallest);
        index = smallest;
      }
    }
    return top;
  }

  for (let index = 0; index < initial - 1; index += 1) {
    const rank = merges.get(`${symbols[index]} ${symbols[index + 1]}`);
    if (rank !== undefined) push(rank, index, symbols[index], symbols[index + 1]);
  }

  while (alive >= 2 && heapSize > 0) {
    const [rank, pos, left, right] = pop();
    // Stale entry: the pair must be EXACTLY the current adjacent pair —
    // merged-away symbols carry next = -1 and can never merge again.
    if (next[pos] < 0 || next[pos] >= initial || symbols[pos] !== left) continue;
    const rightIndex = next[pos];
    if (symbols[rightIndex] !== right) continue;
    // Merge right into pos; mark right dead.
    symbols[pos] = left + right;
    next[pos] = next[rightIndex];
    if (next[pos] >= 0 && next[pos] < initial) prev[next[pos]] = pos;
    next[rightIndex] = -1;
    alive -= 1;
    // New candidate pairs around the merged symbol.
    if (prev[pos] >= 0) {
      const pair = `${symbols[prev[pos]]} ${symbols[pos]}`;
      const newRank = merges.get(pair);
      if (newRank !== undefined) push(newRank, prev[pos], symbols[prev[pos]], symbols[pos]);
    }
    if (next[pos] < initial) {
      const pair = `${symbols[pos]} ${symbols[next[pos]]}`;
      const newRank = merges.get(pair);
      if (newRank !== undefined) push(newRank, pos, symbols[pos], symbols[next[pos]]);
    }
  }
  return alive;
}

/** Count tokens of one pre-tokenized part: byte-encode, then BPE-merge. */
function countPart(part, tokenizer) {
  const bytes = new TextEncoder().encode(part);
  let mapped = '';
  for (let index = 0; index < bytes.length; index += 1) mapped += tokenizer.b2u[bytes[index]];
  if (mapped.length === 0) return 0;
  return bpeCount([...mapped], tokenizer.merges);
}

/**
 * Count the tokens of `text` with the real tokenizer (loads on first use).
 * @param text - the raw text.
 * @returns the exact token count (>= 0).
 * @throws when the tokenizer asset cannot be loaded — sizing must never
 *   silently degrade to a wrong estimator.
 */
export function countTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const cached = encodeCache.get(text);
  if (cached !== undefined) return cached;

  const tokenizer = loadTokenizer();
  if (tokenizer === null) {
    throw new Error('dsh-quilt-compact: the deepseek-v4 tokenizer asset failed to load; refusing to size compaction with a wrong estimator');
  }
  let parts = [text];
  for (const regex of [SPLIT_NUMBER, SPLIT_CJK, SPLIT_WORD]) {
    parts = parts.flatMap((part) => splitIsolated(part, regex));
  }
  let count = 0;
  for (const part of parts) count += countPart(part, tokenizer);

  if (encodeCache.size >= ENCODE_CACHE_MAX) encodeCache.clear();
  encodeCache.set(text, count);
  return count;
}

/** Message pricing overhead per content block (mirrors dsh-token-meter). */
const BLOCK_OVERHEAD = 4;

/**
 * Price one chat message with the real tokenizer: text/reasoning blocks are
 * counted exactly; other block kinds keep the meter's JSON/4 heuristic
 * (their content is structural, not prose).
 * @param message - a chat message (`{ role, content }`, content may be a
 *   string or a block array).
 * @returns the estimated token count including role framing.
 */
export function messageTokens(message) {
  const content = message?.content;
  if (content === undefined || content === null) return 4;
  if (typeof content === 'string') return countTokens(content) + 4;
  if (!Array.isArray(content)) return Math.ceil(JSON.stringify(content).length / 4) + 4;
  let tokens = 4;
  for (const block of content) {
    if (block?.type === 'text' || block?.type === 'reasoning') {
      tokens += countTokens(block.text ?? '') + BLOCK_OVERHEAD;
    } else if (block?.type === 'tool-call') {
      tokens += countTokens(`${block.name ?? ''}${block.arguments ?? ''}`) + BLOCK_OVERHEAD;
    } else {
      tokens += Math.ceil(JSON.stringify(block).length / 4) + BLOCK_OVERHEAD;
    }
  }
  return tokens;
}

/** Whether the real tokenizer loaded (tests + diagnostics). */
export function tokenizerAvailable() {
  return loadTokenizer() !== null;
}

/**
 * Configuration matrix: named pipeline variants the suites can compare.
 *
 * Each entry is a full engine config plus a note on what it isolates. Keeping
 * these in ONE file is what stops benchmark results from being unreproducible:
 * a run names its variants, and `run.mjs` prints them alongside every row.
 *
 * @module dsh-quilt-compact/test/bench/matrix
 */

/** Shared model pool (routes are fake; the benchmark never calls a provider). */
const POOL = [
  {
    name: 'primary',
    models: [
      { provider: 'bench', model: 'digest', maxConcurrent: 1, cooldown: { mode: 'duration', hours: 5 } },
    ],
  },
];

/**
 * Context window the scripted summarizer reports.
 *
 * This is deliberately SMALL. With a realistic 200k window every episode fits
 * a single chunk in a single call, so every variant produces byte-identical
 * behaviour and the benchmark cannot discriminate anything. Constraining the
 * window is what actually engages the machinery being measured — Stage 0
 * trims, overlapping chunking, and hierarchical merge — the same way it engages
 * in production when a large session meets a small route.
 */
export const BENCH_CONTEXT_WINDOW = 3000;

/**
 * Every named variant. `id` is what `--variants` accepts.
 */
export const VARIANTS = {
  default: {
    id: 'default',
    note: 'shipped defaults',
    config: { tiers: POOL },
  },
  'legacy-trim': {
    id: 'legacy-trim',
    note: 'content-deleting head/middle/tail trim restored — the measured-worse behaviour',
    config: { tiers: POOL },
    // Applied by re-wrapping the engine's Stage 0 hook; the shipped pipeline no
    // longer runs this transform.
    legacyTrim: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
  },
  'log-aggressive': {
    id: 'log-aggressive',
    note: 'logCondense maxLines lowered to 20 (aggressive log condensation)',
    config: {
      tiers: POOL,
      preprocessing: { logCondense: { mode: 'tail', maxLines: 20 } },
    },
  },
  'small-chunks': {
    id: 'small-chunks',
    note: 'chunkRatio 0.15 with 0.2 overlap (many small chunks, hierarchical merge)',
    config: { tiers: POOL, chunkRatio: 0.15, chunkOverlapRatio: 0.2 },
  },
};

/**
 * Resolve `--variants a,b` into config objects.
 * @param names - comma-separated variant ids, or undefined for all.
 * @returns the selected variant descriptors.
 */
export function selectVariants(names) {
  if (names === undefined || names === '') return Object.values(VARIANTS);
  const out = [];
  for (const name of names.split(',')) {
    const trimmed = name.trim();
    if (trimmed === '') continue;
    const variant = VARIANTS[trimmed];
    if (variant === undefined) {
      throw new Error(`unknown variant "${trimmed}" (available: ${Object.keys(VARIANTS).join(', ')})`);
    }
    out.push(variant);
  }
  return out;
}

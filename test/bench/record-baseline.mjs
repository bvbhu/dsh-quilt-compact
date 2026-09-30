#!/usr/bin/env node
/**
 * Re-record `baseline.json` from the current deterministic-lane scores.
 *
 * Run this ONLY on a deliberate quality change (episode set, summarizer
 * persona, pipeline semantics). The point of a baseline is that an ACCIDENTAL
 * regression fails the test suite without anyone editing this file; regenerating
 * it on every whim defeats that. `npm test` asserts against the recorded file.
 *
 * @module dsh-quilt-compact/test/bench/record-baseline
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { suiteA } from './a.js';
import { selectVariants } from './matrix.js';
import { EPISODES } from './sessions.js';

const episodes = Object.keys(EPISODES);

async function scoresFor(variantId) {
  const [variant] = selectVariants(variantId);
  const rows = await suiteA({
    episodes,
    config: variant.config,
    legacyTrim: variant.legacyTrim,
  });
  const perfect = rows.filter((row) => row.persona === 'perfect');
  const byEpisode = {};
  let mean = 0;
  for (const row of perfect) {
    byEpisode[row.episode] = Number(row.recall.toFixed(3));
    mean += row.recall;
  }
  return { ...byEpisode, mean: Number((mean / perfect.length).toFixed(3)) };
}

const baseline = {
  '//': 'Faithfulness benchmark baselines, recorded by `npm run bench:baseline`.',
  '//2': 'Assertions in faithfulness.test.js check current >= baseline - tolerance,',
  '//3': 'so a new commit cannot quietly degrade retention without this file changing.',
  generated: 'deterministic lane (scripted personas); stable across machines',
  default: await scoresFor('default'),
  'legacy-trim': await scoresFor('legacy-trim'),
};

const out = new URL('./baseline.json', import.meta.url);
writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`);
console.log(`wrote ${fileURLToPath(out)}`);
console.log(`default mean: ${baseline.default.mean} | legacy-trim mean: ${baseline['legacy-trim'].mean}`);

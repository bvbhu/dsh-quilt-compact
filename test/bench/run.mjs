#!/usr/bin/env node
/**
 * CLI entry point for the Agentic Context-Compression Faithfulness Benchmark.
 *
 * Usage:
 *   node test/bench/run.mjs                       # tables for every suite
 *   node test/bench/run.mjs --json                # machine-readable output
 *   node test/bench/run.mjs --suite a             # just suite A
 *   node test/bench/run.mjs --variants default,no-stage0
 *   node test/bench/run.mjs --list                # variants + episodes
 *
 * Flags are parsed by hand (no dependency): the whole point is that this runs
 * anywhere `npm install` did, including CI sandboxes without network.
 *
 * @module dsh-quilt-compact/test/bench/run
 */
import { suiteA } from './a.js';
import { suiteB } from './b.js';
import { selectVariants, VARIANTS } from './matrix.js';
import { EPISODES } from './sessions.js';
import { pct } from './metrics.js';

/** Parse `--key value` / `--key` pairs into an object. Booleans are flags. */
function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) { out._.push(token); continue; }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next;
    index += 1;
  }
  return out;
}

/** Render one table from headers + rows. Column widths are computed. */
function table(headers, rows) {
  const widths = headers.map((header, column) => Math.max(
    header.length,
    ...rows.map((row) => String(row[column] ?? '').length),
  ));
  const line = (cells) => cells.map((cell, column) => String(cell ?? '').padEnd(widths[column])).join('  ');
  return [line(headers), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(line)].join('\n');
}

/** Print the catalog and exit. */
function listEverything() {
  console.log('Variants:');
  for (const variant of Object.values(VARIANTS)) console.log(`  ${variant.id.padEnd(16)} ${variant.note}`);
  console.log('\nEpisodes:');
  for (const [id, entry] of Object.entries(EPISODES)) console.log(`  ${id.padEnd(16)} ${entry.title}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list === true) { listEverything(); return; }
  const variants = selectVariants(args.variants === true ? undefined : args.variants);
  const episodes = args.episodes === undefined || args.episodes === true
    ? Object.keys(EPISODES)
    : String(args.episodes).split(',').map((name) => name.trim()).filter(Boolean);
  const suiteNames = args.suite === undefined || args.suite === true ? ['a', 'b'] : String(args.suite).split(',').map((name) => name.trim());
  // Retain only the 2 most recent nodes. The episodes place their load-bearing
  // facts INSIDE the compacted span, so a larger retained window would leave
  // the answers sitting in untouched context and every variant would score
  // full marks for free.
  const keepRight = args.keepRight === undefined ? 2 : Number(args.keepRight);

  const report = { variants: variants.map((variant) => variant.id), episodes, suites: {} };

  if (suiteNames.includes('a')) {
    const rows = [];
    for (const variant of variants) {
      const suiteRows = await suiteA({
        episodes, config: variant.config, behavior: 'perfect', keepRight, legacyTrim: variant.legacyTrim,
      });
      for (const row of suiteRows) rows.push({ variant: variant.id, ...row });
    }
    report.suites.a = rows;
    if (args.json !== true) {
      console.log('\n=== Suite A — Faithfulness (checkpoint checklist recall) ===');
      console.log(table(
        ['variant', 'episode', 'recall', 'control', 'lift', 'size', 'calls'],
        rows.map((row) => [
          row.variant,
          row.episode,
          pct(row.recall),
          pct(row.controlRecall),
          pct(row.gain),
          `${row.beforeChars}->${row.afterChars}`,
          row.calls,
        ]),
      ));
      const detail = rows.flatMap((row) => row.records.map((record) => [
        row.variant, `${row.episode}/${record.probe}`, pct(record.recall), record.missing.join('|') || '-', record.hallucinated,
      ]));
      console.log('\n--- per-probe detail ---');
      console.log(table(['variant', 'probe', 'recall', 'missing', 'halluc'], detail));
    }
  }

  if (suiteNames.includes('b')) {
    const rows = [];
    for (const variant of variants) {
      const suiteRows = await suiteB({ episodes, config: variant.config, behavior: 'perfect', keepRight });
      for (const row of suiteRows) rows.push({ variant: variant.id, ...row });
    }
    report.suites.b = rows;
    if (args.json !== true) {
      console.log('\n=== Suite B — Retrieval recall over the compressed history ===');
      console.log(table(
        ['variant', 'episode', 'answered', 'of', 'recall', 'chars'],
        rows.map((row) => [
          row.variant, row.episode, row.answeredAfter, row.answeredBefore, pct(row.recall), `${row.beforeChars}->${row.afterChars}`,
        ]),
      ));
    }
  }

  if (args.json === true) console.log(JSON.stringify(report, null, 2));
}

await main().catch((error) => {
  console.error(`bench failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});

/**
 * Validate the regenerated bundle end to end:
 *  - the whole cordis.patch.yml parses through dsh's own loadOverlayPatches
 *  - preset-standard keeps 19 plugins, compaction group swapped with config
 *  - the host-plane branch still present (compaction-basic disabled + insert)
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dshModules } from '../test/helpers/dsh-modules.js';

if (dshModules === undefined) {
  console.error('SKIP tools/verify-bundle: dsh installation not found (set DSH_MODULES to its node_modules to enable)');
  process.exit(1);
}
const { loadOverlayPatches } = await import(
  pathToFileURL(join(dshModules, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href
);

const here = dirname(fileURLToPath(import.meta.url)) + '/..';
const layers = loadOverlayPatches('dsh', `${here}/cordis.patch.yml`);
console.log('top-level ops:', layers.length);

for (const l of layers) {
  if (l.id) console.log(' - id-row:', l.id, '| disabled:', JSON.stringify(l.disabled));
  if (l.insert) console.log(' - insert rows:', l.insert.map((e) => e.id).join(', '));
}

const host = layers.find((l) => l.id === 'compaction-basic');
if (host?.disabled !== true) throw new Error('host compaction-basic must be disabled');
const insert = layers.flatMap((l) => l.insert ?? []).find((e) => e.id === 'dsh-quilt-compact');
if (!insert) throw new Error('host dsh-quilt-compact insert missing');
if (typeof insert.disabled !== 'object') throw new Error(`host insert gate must be a !!js expression, got ${JSON.stringify(insert.disabled)}`);
console.log('host gate expr:', insert.disabled?.__jsExpr);

const ps = layers.find((l) => l.id === 'preset-standard');
if (!ps) throw new Error('preset-standard restate missing');
if (ps.config.plugins.length !== 19) throw new Error(`expected 19 plugins, got ${ps.config.plugins.length}`);
const group = ps.config.plugins.find((p) => p.id === 'compaction');
if (!group) throw new Error('compaction group missing');
const ids = group.config.map((r) => r.id);
if (JSON.stringify(ids) !== JSON.stringify(['dsh-quilt-compact', 'command-compact', 'tool-result-pruner'])) {
  throw new Error(`bad group rows: ${ids}`);
}
if (group.isolate?.compaction !== true || group.isolate?.toolResultPruner !== true) {
  throw new Error(`isolate lost: ${JSON.stringify(group.isolate)}`);
}
const quilt = group.config.find((r) => r.id === 'dsh-quilt-compact');
if (!quilt.config?.tiers || quilt.config.tiers.length !== 1) throw new Error('quilt config tiers missing');
if (quilt.config.tiers[0].name !== 'primary' || quilt.config.tiers[0].models[0].model !== 'openrouter/free') {
  throw new Error(`bad quilt config: ${JSON.stringify(quilt.config.tiers[0].models[0])}`);
}
console.log('quilt tiers:', quilt.config.tiers.map((t) => `${t.name}(${t.models.length})`).join(', '));
console.log('plan-mode intact:', ps.config.plugins.find((p) => p.id === 'planning').config[0].config.section.length > 200);
console.log('\nBUNDLE-OK');
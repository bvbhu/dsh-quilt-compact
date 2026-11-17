/**
 * Validate the bundle patch end to end through dsh's own loader:
 *  - the whole cordis.patch.yml parses through loadOverlayPatches
 *  - the only op is the interceptor insert
 *  - compaction-basic is NOT disabled and preset-standard is NOT restated
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

// Cooperative shape: no row is disabled and no preset is restated.
for (const l of layers) {
  if (l.id === 'compaction-basic' && l.disabled === true) {
    throw new Error('compaction-basic must NOT be disabled: the interceptor only rewrites compaction calls');
  }
  if (l.id === 'preset-standard') {
    throw new Error('preset-standard must NOT be restated: restating the preset replaces the whole agent preset');
  }
}

const insert = layers.flatMap((l) => l.insert ?? []).find((e) => e.id === 'dsh-quilt-compact');
if (!insert) throw new Error('dsh-quilt-compact insert missing');
if (insert.name !== 'dsh-quilt-compact/intercept') {
  throw new Error(`unexpected entry point: ${String(insert.name)}`);
}
if (insert.disabled !== undefined) throw new Error('the interceptor row must be enabled unconditionally');
if (!insert.config?.tiers || insert.config.tiers.length !== 1) throw new Error('quilt config tiers missing');
if (insert.config.tiers[0].name !== 'primary' || insert.config.tiers[0].models[0].model !== 'openrouter/free') {
  throw new Error(`bad quilt config: ${JSON.stringify(insert.config.tiers[0].models[0])}`);
}
console.log('quilt tiers:', insert.config.tiers.map((t) => `${t.name}(${t.models.length})`).join(', '));
console.log('preprocessing:', JSON.stringify(insert.config.preprocessing));
console.log('\nBUNDLE-OK');

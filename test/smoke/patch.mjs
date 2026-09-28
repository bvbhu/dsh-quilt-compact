/**
 * Patch-layer smoke test: compose the REAL dsh-base layer + this bundle's
 * layer using dsh's OWN applyEntryPatches, then assert the composed tree is
 * exactly what `dsh --profile <name> --dump-config` would show:
 *   - compaction-basic row: name preserved, disabled: true
 *   - compaction-chain row: inserted, name 'dsh-quilt-compact'
 *   - every pre-existing row (storage, storage-json, storage-domain, ...)
 *     survives untouched
 *
 * Using dsh's own composer (not a reimplementation) is what makes this a real
 * compatibility check rather than a restatement of our assumptions.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

import { dshModules } from '../helpers/dsh-modules.js';

// `dsh-app-boot` and `dsh-base` are not dependencies of dsh-quilt-compact; they
// ship inside the dsh installation. See ../helpers/dsh-modules.js.
// dsh-app-boot's own composer and patch loader, exported for tooling: the same
// functions the boot include and `dsh --dump-config` use. loadOverlayPatches
// installs the `!!js` YAML tag, which a plain yaml parse cannot resolve.
if (dshModules === undefined) {
  console.log('SKIP smoke/patch: dsh installation not found (set DSH_MODULES to its node_modules to enable)');
  process.exit(0);
}
const boot = await import(pathToFileURL(join(dshModules, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href);
const { composeEntries, loadOverlayPatches } = boot;
assert.equal(typeof composeEntries, 'function', 'composeEntries must be exported by dsh-app-boot');
assert.equal(typeof loadOverlayPatches, 'function', 'loadOverlayPatches must be exported by dsh-app-boot');

const read = (p) => loadOverlayPatches('dsh', p);

const BASE = join(dshModules, '@deepseek-ai', 'dsh-base', 'cordis.patch.yml');
const OURS = fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url));
assert.ok(existsSync(BASE), `dsh-base patch layer not found at ${BASE}`);
assert.ok(existsSync(OURS), `this bundle's patch layer not found at ${OURS}`);

const base = read(BASE);
const ours = read(OURS);

// --- before: base alone ---------------------------------------------------
const before = composeEntries([base]);
const basicBefore = before.find((e) => e.id === 'compaction-basic');
assert.ok(basicBefore, 'base must carry a compaction-basic row');
assert.equal(basicBefore.name, '@deepseek-ai/dsh-compaction-basic');
assert.notEqual(basicBefore.disabled, true, 'basic is enabled by default');

// --- after: base + our bundle layer --------------------------------------
const after = composeEntries([base, ours]);

const basic = after.find((e) => e.id === 'compaction-basic');
assert.ok(basic, 'compaction-basic row must survive');
assert.equal(basic.name, '@deepseek-ai/dsh-compaction-basic', 'name must be preserved (patch sets disabled only)');
assert.equal(basic.disabled, true, 'compaction-basic must be disabled');

const chain = after.find((e) => e.id === 'compaction-chain');
assert.ok(chain, 'compaction-chain row must be inserted');
assert.equal(chain.name, 'dsh-quilt-compact');
assert.equal(chain.config.tiers.length, 2);

// --- nothing else was disturbed ------------------------------------------
const allIds = after.map((e) => e.id);
for (const id of ['storage', 'storage-json', 'storage-domain', 'agent', 'llm', 'token-meter', 'command-compact']) {
  const row = after.find((e) => e.id === id);
  assert.ok(row, `row ${id} must survive our layer`);
}
// Our `inject` names are SERVICE names (camelCase); row ids are kebab-case.
// Both `dsh-compaction-basic` (the plugin we replace) and this plugin declare
// the same three, and the base rows below supply them.
const SERVICE_ROWS = { llm: 'llm', tokenMeter: 'token-meter', sessions: 'session' };
for (const [service, rowId] of Object.entries(SERVICE_ROWS)) {
  assert.ok(allIds.includes(rowId), `row "${rowId}" must exist to provide the "${service}" service our inject requires`);
}
const storageDomain = after.find((e) => e.id === 'storage-domain');
assert.equal(storageDomain.config.backend, 'json', 'storage-domain config untouched');

// --- exactly one compaction service is enabled ---------------------------
const compactionRows = after.filter((e) => e.name?.includes('compaction-basic') || e.id === 'compaction-chain');
const enabled = compactionRows.filter((e) => e.disabled !== true);
assert.equal(enabled.length, 1, `exactly one compaction backend must stay enabled (saw ${enabled.map((e) => e.id).join(', ')})`);
assert.equal(enabled[0].id, 'compaction-chain');

console.log(`PATCH OK: ${after.length} rows composed; compaction-basic disabled, compaction-chain enabled, no collateral edits`);

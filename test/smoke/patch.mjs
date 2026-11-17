/**
 * Patch-layer smoke test: compose the REAL dsh-base layer + this bundle's
 * layer using dsh's OWN applyEntryPatches, then assert the cooperative shape:
 *   - compaction-basic keeps `disabled` unset (the host engine stays the owner)
 *   - our row is inserted as the compaction-only interceptor
 *   - preset-standard is NOT restated by this bundle
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

// The host engine is untouched: this bundle must NOT disable it.
const basic = after.find((e) => e.id === 'compaction-basic');
assert.ok(basic, 'compaction-basic row must survive');
assert.equal(basic.name, '@deepseek-ai/dsh-compaction-basic', 'name must be preserved');
assert.notEqual(basic.disabled, true, 'compaction-basic must stay ENABLED (cooperative interceptor)');

// Our interceptor row is present and is not a compaction service.
const chain = after.find((e) => e.id === 'dsh-quilt-compact');
assert.ok(chain, 'dsh-quilt-compact row must be inserted');
assert.equal(chain.name, 'dsh-quilt-compact/intercept', 'the row loads the interceptor entry point, not a compaction engine');
assert.equal(chain.config.tiers.length, 1);

// No preset restate: replacing preset-standard would overwrite the whole
// agent preset and is exactly the conflict this redesign removes.
assert.equal(after.find((e) => e.id === 'preset-standard'), undefined, 'preset-standard must not be restated');

// --- nothing else was disturbed ------------------------------------------
const allIds = after.map((e) => e.id);
for (const id of ['storage', 'storage-json', 'storage-domain', 'agent', 'llm', 'token-meter', 'command-compact']) {
  const row = after.find((e) => e.id === id);
  assert.ok(row, `row ${id} must survive our layer`);
}
// Our `inject` names are SERVICE names (camelCase); row ids are kebab-case.
const SERVICE_ROWS = { llm: 'llm', tokenMeter: 'token-meter', sessions: 'session' };
for (const [service, rowId] of Object.entries(SERVICE_ROWS)) {
  assert.ok(allIds.includes(rowId), `row "${rowId}" must exist to provide the "${service}" service our inject requires`);
}
const storageDomain = after.find((e) => e.id === 'storage-domain');
assert.equal(storageDomain.config.backend, 'json', 'storage-domain config untouched');

console.log(`PATCH OK: ${after.length} rows composed; compaction-basic stays enabled, interceptor inserted, no preset restate`);

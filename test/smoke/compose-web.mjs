/**
 * Compose the FULL web-profile patch stack like the real launcher does, apply
 * our bundle on top, and assert the cooperative shape holds in a web profile:
 *   - preset-standard is NOT restated, so the agent preset is untouched;
 *   - compaction-basic stays enabled (the host keeps owning compaction);
 *   - exactly one dsh-quilt-compact interceptor row exists, and it is a plain
 *     host-plane row (not inside the preset's isolate group).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { dshModules } from '../helpers/dsh-modules.js';

if (dshModules === undefined) {
  console.log('SKIP smoke/compose-web: dsh installation not found (set DSH_MODULES to its node_modules to enable)');
  process.exit(0);
}
const M = dshModules;
const boot = await import(pathToFileURL(join(M, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href);
const { composeEntries, loadOverlayPatches } = boot;

const R = M;

// Web-app bundle patches in their declared order.
const webApp = join(R, '@deepseek-ai', 'dsh-web-app');
const webAppPkg = JSON.parse(readFileSync(join(webApp, 'package.json'), 'utf8'));
const patchFiles = ['cordis.patch.yml', ...(webAppPkg.dsh?.bundle?.patch ?? [])].map((f) => join(webApp, f));
console.log('web-app bundle patch files:', patchFiles.map((f) => f.split('/').pop()).join(', '));

let patches = [];
for (const f of patchFiles) patches.push(...loadOverlayPatches('dsh', f));

// User profile layer (when present) + our bundle last.
const profileFile = 'C:/Users/Administrator/.dsh/profiles/web/cordis.patch.yml';
if (existsSync(profileFile)) patches.push(...loadOverlayPatches('dsh', profileFile));
else console.log('(no web profile patch at', profileFile, '- composing without it)');
patches.push(...loadOverlayPatches('dsh', fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url))));

const rows = composeEntries([patches]);
console.log('composed rows:', rows.length);

// The agent preset must be untouched by this bundle.
const ps = rows.find((r) => r.id === 'preset-standard');
if (ps !== undefined) {
  const group = ps.config.plugins.find((p) => p.id === 'compaction');
  const ids = group?.config?.map((r) => r.id) ?? [];
  console.log('preset compaction group rows:', ids.join(', '));
  if (ids.includes('dsh-quilt-compact')) {
    console.error('this bundle must not inject itself into the agent preset compaction group');
    process.exit(1);
  }
  if (!ids.includes('compaction-basic')) {
    console.error('compaction-basic must remain the preset compaction backend');
    process.exit(1);
  }
} else {
  console.log('(no preset-standard row in this profile shape)');
}

// Our interceptor is a plain host-plane row.
const interceptorRows = rows.filter((r) => r.id === 'dsh-quilt-compact' && r.group !== true);
if (interceptorRows.length !== 1) {
  console.error(`expected exactly one interceptor row, found ${interceptorRows.length}`);
  process.exit(1);
}
const row = interceptorRows[0];
if (row.name !== 'dsh-quilt-compact/intercept') {
  console.error(`unexpected entry point: ${String(row.name)}`);
  process.exit(1);
}
if (row.disabled === true) {
  console.error('the interceptor row must be enabled in a web profile');
  process.exit(1);
}
console.log('interceptor row: name=' + row.name + ' tiers=' + row.config?.tiers?.length);

// And the host engine is still enabled.
const basic = rows.find((r) => r.id === 'compaction-basic');
if (basic !== undefined && basic.disabled === true) {
  console.error('compaction-basic must not be disabled by this bundle');
  process.exit(1);
}
console.log('\nCOMPOSED-OK');

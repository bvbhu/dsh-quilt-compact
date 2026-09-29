/**
 * Compose the FULL web-profile patch stack like the real launcher does, apply
 * our bundle on top, and assert the preset-standard row's compaction group now
 * contains dsh-quilt-compact. This mirrors what happens when the user's
 * dsh-quilt-compact is last in dsh.profile.bundles.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const M = process.env.DSH_MODULES;
const boot = await import(pathToFileURL(join(M, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href);
const { composeEntries, loadOverlayPatches } = boot;

const R = 'D:/Program Files/nodejs/node_global/node_modules/@deepseek-ai/dsh/node_modules';

// Web-app bundle patches in their declared order.
const webApp = join(R, '@deepseek-ai', 'dsh-web-app');
const webAppPkg = JSON.parse(readFileSync(join(webApp, 'package.json'), 'utf8'));
const patchFiles = ['cordis.patch.yml', ...(webAppPkg.dsh?.bundle?.patch ?? [])].map((f) => join(webApp, f));
console.log('web-app bundle patch files:', patchFiles.map((f) => f.split('/').pop()).join(', '));

let patches = [];
for (const f of patchFiles) patches.push(...loadOverlayPatches('dsh', f));

// User profile layer (18 patches seen earlier) + our bundle last.
const profileFile = 'C:/Users/Administrator/.dsh/profiles/web/cordis.patch.yml';
patches.push(...loadOverlayPatches('dsh', profileFile));
patches.push(...loadOverlayPatches('dsh', 'D:/projects/dsh-quilt-compact/cordis.patch.yml'));

const rows = composeEntries([patches]);
console.log('composed rows:', rows.length);

const ps = rows.find((r) => r.id === 'preset-standard');
if (!ps) { console.error('preset-standard NOT in composed rows'); process.exit(1); }
console.log('preset-standard plugins:', ps.config.plugins.length);

const group = ps.config.plugins.find((p) => p.id === 'compaction');
const ids = group?.config?.map((r) => r.id) ?? [];
console.log('compaction group rows:', ids.join(', '));
console.log('isolate:', JSON.stringify(group?.isolate));

const quilt = group?.config?.find((r) => r.id === 'dsh-quilt-compact');
console.log('dsh-quilt-compact tiers:', quilt?.config?.tiers?.length);
console.log('still has basic?', ids.includes('compaction-basic'));

// The host-plane insert row's !!js gate survives composition untouched.
const hostRow = rows.flatMap((r) => (r.id === 'dsh-quilt-compact' && !r.group ? [r] : []))[0];
console.log('host row disabled:', JSON.stringify(hostRow?.disabled));

if (!ids.includes('dsh-quilt-compact') || ids.includes('compaction-basic')) process.exit(1);
console.log('\nCOMPOSED-OK');
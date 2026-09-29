import { loadOverlayPatches } from 'file:///D:/Program Files/nodejs/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js';
const layers = loadOverlayPatches('dsh', 'D:/projects/dsh-quilt-compact/cordis.patch.yml');
const host = layers.flatMap((l) => l.insert ?? []).find((e) => e.id === 'dsh-quilt-compact');
const ps = layers.find((l) => l.id === 'preset-standard');
const quilt = ps.config.plugins.find((p) => p.id === 'compaction').config.find((r) => r.id === 'dsh-quilt-compact');
const a = JSON.stringify(host.config);
const b = JSON.stringify(quilt.config);
console.log('host config === restate config:', a === b);
if (a !== b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) { console.log('diff@', i, JSON.stringify(a.slice(i, i + 60)), '<>', JSON.stringify(b.slice(i, i + 60))); break; }
  }
}
// Also verify the !!js expr matches official loader syntax
console.log('host gate __jsExpr:', host.disabled?.__jsExpr);
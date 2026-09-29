#!/usr/bin/env node
/**
 * Generate the `preset-standard` full-restate block for our bundle.
 *
 * Patch semantics: overriding `preset-standard` replaces its entire `config`,
 * never deep-merged, so the full plugin list must be restated EXACTLY as the
 * shipped standard.patch.yml carries it — with one change: inside the
 * `compaction` group, the `compaction-basic` row becomes a `dsh-quilt-compact`
 * row carrying the same config as the host-plane row in our own cordis.patch.yml.
 *
 * Everything is edited at the TEXT level: re-serializing through a YAML
 * library would mangle the `!!js` loader expressions, which must stay raw.
 *
 * Official indentation (verified against 0.1.7-rc.1 standard.patch.yml):
 *   - insert:           0
 *     - id: preset-standard   4
 *       config:         6
 *         - id: persona 10
 *           config:     12
 *       (group row)     10
 *         config:       12
 *           - id: ...   14
 *             config:   16
 *
 * Dev-time only; cordis.patch.yml embeds the output so the package stays
 * self-contained. Run with DSH_MODULES set to the dsh installation node_modules.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DSH_MODULES = process.env.DSH_MODULES;
if (!DSH_MODULES) { console.error('set DSH_MODULES to the dsh installation node_modules'); process.exit(1); }
const here = dirname(fileURLToPath(import.meta.url));

// --- 1. slice the official preset declaration's config ---------------------
const standardFile = join(DSH_MODULES, '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml');
const srcLines = readFileSync(standardFile, 'utf8').split('\n');

const declIdx = srcLines.findIndex((l) => /^ {4}- id: preset-standard$/.test(l));
if (declIdx < 0) { console.error('preset-standard declaration not found'); process.exit(1); }
const configIdx = srcLines.findIndex((l, i) => i > declIdx && /^ {6}config:$/.test(l));
if (configIdx < 0) { console.error('preset-standard config: not found'); process.exit(1); }

// Everything from `config:` (6sp) to EOF, re-indented -4 so it reads as a
// top-level override row: `  config:` (2sp), `    id/order/plugins:` (4sp),
// plugin rows at 6sp — the same relative depth as the shipped file's 10sp
// under 6sp config (semantically identical YAML; loadOverlayPatches parses
// it the same).
const configBody = srcLines.slice(configIdx).map((l) => (l.trim() === '' ? '' : l.replace(/^ {4}/, '')));

// --- 2. swap the compaction group's backend row -----------------------------
// After the -4 re-indent: group `- id: compaction` at 6sp, group config at
// 8sp, group children at 10sp.
const groupIdx = configBody.findIndex((l) => /^ {6}- id: compaction$/.test(l));
if (groupIdx < 0) { console.error('compaction group not found'); process.exit(1); }
const basicIdx = configBody.findIndex((l, i) => i > groupIdx && /^ {10}- id: compaction-basic$/.test(l));
if (basicIdx < 0) { console.error('compaction-basic row not found in the group'); process.exit(1); }
// The basic row is a block: its id line plus its `name:` line (the shipped
// compaction-basic row has no config). Replace the WHOLE block up to the next
// group child `- id:` so no stale name line survives the swap.
let blockEnd = basicIdx + 1;
while (blockEnd < configBody.length && !/^ {10}- id: /.test(configBody[blockEnd])) blockEnd += 1;

// --- 3. read the host-plane dsh-quilt-compact row's config from our bundle --
const ourPatchFile = join(here, '..', 'cordis.patch.yml');
const ourLines = readFileSync(ourPatchFile, 'utf8').split('\n');
// The host row is nested under `- insert:` (4sp): match its id at that depth.
const hostLineIdx = ourLines.findIndex((l) => /^ {4}- id: dsh-quilt-compact\s*$/.test(l));
if (hostLineIdx < 0) { console.error('host dsh-quilt-compact row not found'); process.exit(1); }
let hostEndLine = ourLines.length;
for (let i = hostLineIdx + 1; i < ourLines.length; i += 1) {
  if (/^ {4}- id: /.test(ourLines[i]) || /^ {0}- id: /.test(ourLines[i]) || /^# --- web\/desktop/.test(ourLines[i])) { hostEndLine = i; break; }
}
const hostRow = ourLines.slice(hostLineIdx, hostEndLine).filter((l) => l.trim() !== '');

const nameLine = hostRow.find((l) => l.trim().startsWith('name:'));
const cfgIdx = hostRow.findIndex((l) => l.trim() === 'config:');
if (!nameLine || cfgIdx < 0) { console.error('host row missing name or config'); process.exit(1); }

// Shift the whole host row by +6 spaces into the group's child indentation:
// host `- id:` (4sp) -> 10sp (group child), host name/config keys (6sp) ->
// 12sp, host config contents (8sp) -> 14sp, deeper lines proportionally.
// The host's `disabled:` gate is DROPPED: in a web profile it would evaluate
// true inside the preset and disable the very row that should serve the
// backend; the preset group controls enablement instead.
const hostShift = (l) => (l.trim() === '' ? '' : '      ' + l);
const swapped = [
  '          - id: dsh-quilt-compact',
  hostShift(nameLine),
  '            config:',
  ...hostRow.slice(cfgIdx + 1).map(hostShift),
];

const restateBody = [...configBody.slice(0, basicIdx), ...swapped, ...configBody.slice(blockEnd)];

// --- 4. sanity + assemble ----------------------------------------------------
const joined = restateBody.join('\n');
if (joined.includes('- id: compaction-basic')) { console.error('compaction-basic still present'); process.exit(1); }
if ((joined.match(/ {8}- id: dsh-quilt-compact/g) ?? []).length !== 1) { console.error('expected one group-level dsh-quilt-compact row'); process.exit(1); }

const block = [
  '# --- preset-standard full restate (web/desktop profiles) ----------------',
  '# Shipped by @deepseek-ai/dsh-web-app as presets/standard.patch.yml.',
  "# Overriding the row replaces its WHOLE config (never deep-merged), so the",
  "# full plugin list is restated VERBATIM with one change: the compaction",
  "# group's backend row is dsh-quilt-compact instead of",
  '# @deepseek-ai/dsh-compaction-basic. The group keeps isolate +',
  '# command-compact + tool-result-pruner untouched; the dsh-quilt-compact',
  '# row carries the same config as the host-plane row, regenerated by',
  '# tools/generate-preset-restate.mjs so the two copies cannot drift.',
  '- id: preset-standard',
  "  name: '@deepseek-ai/dsh-agent-preset'",
  ...restateBody,
].join('\n');

mkdirSync(join(here, '..', 'generated'), { recursive: true });
const restateOut = join(here, '..', 'generated', 'preset-standard.restate.yml');
writeFileSync(restateOut, block + '\n');

// Replace everything from the web/desktop marker onward in our bundle.
const current = readFileSync(ourPatchFile, 'utf8');
const marker = '# --- web/desktop branch: preset-standard restate';
const at = current.indexOf(marker);
const hostFragment = at < 0 ? current : current.slice(0, at);
writeFileSync(ourPatchFile, `${hostFragment}# --- web/desktop branch: preset-standard restate ---\n${block}\n`);

console.log('wrote', restateOut, 'lines:', block.split('\n').length);
console.log('wrote', ourPatchFile);
console.log('group rows:', joined.match(/ {8}- id: (\S+)/g).map((s) => s.trim().replace('- id: ', '')).join(', '));
console.log('plan-mode verbatim:', joined.includes('to keep the tool catalog unchanged. Do not use todo_write'));
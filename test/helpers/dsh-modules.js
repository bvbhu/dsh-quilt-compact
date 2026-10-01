/**
 * Locate the dsh installation's `node_modules`.
 *
 * dsh-quilt-compact declares its dsh peers as devDependencies, so they may
 * resolve from THIS package's own node_modules (a standalone checkout) rather
 * than from the dsh installation. Some smoke-test subjects — `yaml`,
 * `dsh-app-boot`, `dsh-base` — are not dependencies of this package at all and
 * live ONLY in the dsh installation. This helper finds that directory.
 *
 * Location is BEST EFFORT: a checkout developed standalone may have dsh
 * installed somewhere this process cannot discover (for example a sandboxed
 * environment that forbids spawning `npm root -g`). {@link dshModules}
 * therefore returns `undefined` instead of throwing, and each smoke test skips
 * itself in that case — these tests gate a real installation, not the package's
 * own unit/e2e suite.
 *
 * @module dsh-quilt-compact/test/helpers/dsh-modules
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path of the dsh installation's `node_modules`, or `undefined` when
 * it cannot be located.
 *
 * @returns the directory containing `@deepseek-ai/dsh-app-boot`.
 */
function findDshModules() {
  const candidates = [];
  // Explicit override: set DSH_MODULES to the dsh installation's node_modules
  // when automatic discovery cannot see it (sandboxed CI, unusual layouts).
  if (process.env.DSH_MODULES !== undefined && process.env.DSH_MODULES !== '') {
    candidates.push(process.env.DSH_MODULES);
    candidates.push(join(process.env.DSH_MODULES, '@deepseek-ai', 'dsh', 'node_modules'));
  }
  // Walk up from this file, testing at each level both the plain `node_modules`
  // and — because the dsh package nests its own copy — `node_modules` inside a
  // `@deepseek-ai/dsh` installed at that level.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) break;
    const nm = join(parent, 'node_modules');
    candidates.push(nm);
    candidates.push(join(nm, '@deepseek-ai', 'dsh', 'node_modules'));
    dir = parent;
  }
  // Probe from any dsh package resolvable through our own graph.
  for (const spec of ['@deepseek-ai/dsh-token-meter', '@deepseek-ai/cordis', '@deepseek-ai/dsh-compaction-basic']) {
    try {
      const entry = fileURLToPath(import.meta.resolve(spec));
      const at = entry.lastIndexOf(`${sep}@deepseek-ai${sep}`);
      if (at > 0) {
        const root = entry.slice(0, at);
        candidates.push(root);
        candidates.push(join(root, '@deepseek-ai', 'dsh', 'node_modules'));
      }
    } catch { /* not installed locally */ }
  }
  // The dsh CLI is normally in the GLOBAL npm root, whose path is unrelated to
  // this checkout's ancestors. `npm root -g` is the authoritative answer, but
  // spawning is denied in some sandboxes — hence the graceful fallback below.
  try {
    // On Windows npm is npm.cmd and execFileSync cannot spawn it without a
    // shell; on POSIX a shell would be redundant but harmless here. The
    // command is a fixed literal, so passing it through the shell is safe.
    const globalRoot = execFileSync('npm root -g', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    }).trim();
    if (globalRoot !== '') {
      candidates.push(globalRoot);
      candidates.push(join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules'));
    }
  } catch { /* npm unavailable or spawning denied */ }

  for (const candidate of candidates) {
    if (existsSync(join(candidate, '@deepseek-ai', 'dsh-app-boot'))) return candidate;
  }
  return undefined;
}

export const dshModules = findDshModules();

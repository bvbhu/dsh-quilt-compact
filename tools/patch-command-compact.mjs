#!/usr/bin/env node
/**
 * Patch the installed `@deepseek-ai/dsh-command-compact` so a failed /compact
 * (and the other expected compaction-failure codes) appends the REAL failure
 * reason to its fixed per-code sentence.
 *
 * Why a host patch: upstream `expectedFailure` maps each ManualCompactionError
 * CODE to one fixed sentence and discards `error.message` / `error.cause`, so
 * the chat output can only ever say "Compaction could not produce a useful
 * summary. The attempt is recorded in the session log." — no matter how
 * precise the engine's own error chain is. The engine (this repo) puts the
 * actionable facts INTO that chain (flattened reason + per-route attempt
 * summary), so the command is the one place the reason can reach the user.
 *
 * Idempotent: re-running detects the marker and exits 0. Refuses to touch a
 * file whose `expectedFailure` block does not match the known original (an
 * upstream upgrade changed the shape → re-review, never a corrupt patch).
 * Writes `index.js.bak-quilt` beside the original before the first patch.
 * Takes effect on the next harness start (the module is loaded at boot).
 *
 * Usage:
 *   node tools/patch-command-compact.mjs [path-to-lib/index.js] [--check]
 *
 * Path resolution: explicit argv wins; then a require.resolve from this repo;
 * then `$DSH_INSTALL_DIR`; then this machine's default global install.
 */
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const MARKER = 'dsh-quilt-compact failure-reason patch';
const DEFAULT_INSTALL = ['D:', 'Program Files', 'nodejs', 'node_global', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-command-compact', 'lib', 'index.js'];

/** The upstream block, verbatim (tab-indented, as shipped in 0.1.7-rc.1). */
const ORIGINAL = [
  '/** Convert expected capability failures into concise human-only outcomes. */',
  'function expectedFailure(error) {',
  '\tswitch (error.code) {',
  '\t\tcase "busy": return {',
  '\t\t\tkind: "error",',
  '\t\t\ttext: "Compaction is unavailable because this process has an active compaction, or the agent is not idle."',
  '\t\t};',
  '\t\tcase "cancelled": return {',
  '\t\t\tkind: "error",',
  '\t\t\ttext: "Compaction cancelled."',
  '\t\t};',
  '\t\tcase "changed": return {',
  '\t\t\tkind: "error",',
  '\t\t\ttext: "The history selected for compaction changed before it could be replaced. The attempt is recorded in the session log."',
  '\t\t};',
  '\t\tcase "summary": return {',
  '\t\t\tkind: "error",',
  '\t\t\ttext: "Compaction could not produce a useful summary. The attempt is recorded in the session log."',
  '\t\t};',
  '\t\tcase "commit": return {',
  '\t\t\tkind: "error",',
  '\t\t\ttext: "Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying."',
  '\t\t};',
  '\t\tcase "persistence": return {',
  '\t\t\tkind: "error",',
  '\t\t\ttext: "Compaction finished, but the session could not be saved."',
  '\t\t};',
  '\t\t/* v8 ignore next 2 -- ManualCompactionErrorCode is closed and every member is handled above */',
  '\t\tdefault: return assertNever(error.code);',
  '\t}',
  '}',
  '',
].join('\n');

/** The replacement: same sentences, plus the bounded reason from the cause chain. */
const PATCHED = [
  `/** ${MARKER}: pull one bounded reason out of an error chain. */`,
  'function failureReason(error, limit = 400) {',
  '\tconst parts = [];',
  '\tfor (let current = error instanceof Error ? error.cause : undefined, depth = 0; current instanceof Error && depth < 3; current = current.cause, depth += 1) {',
  '\t\tconst message = typeof current.message === "string" ? current.message : undefined;',
  '\t\tif (message === undefined || message.length === 0) continue;',
  '\t\tif (parts.some((part) => part.includes(message) || message.includes(part))) continue;',
  '\t\tparts.push(message);',
  '\t}',
  '\tif (parts.length === 0 && error instanceof Error && typeof error.message === "string" && error.message.length > 0) parts.push(error.message);',
  '\tconst reason = parts.join(": ");',
  '\treturn reason.length > limit ? reason.slice(0, limit - 1) + "\\u2026" : reason;',
  '}',
  '/** Convert expected capability failures into concise human-only outcomes.',
  ' *',
  ` * ${MARKER}: the fixed per-code sentences are kept, but the REAL reason (the`,
  ' * cause chain the compaction engine attached) is appended, so a failed',
  ' * /compact states WHY it failed instead of only pointing at the session log.',
  ' */',
  'function expectedFailure(error) {',
  '\tconst reason = failureReason(error);',
  '\tconst detail = reason.length > 0 ? " Reason: " + reason : "";',
  '\tswitch (error.code) {',
  '\t\tcase "busy": return {',
  '\t\t\tkind: "error",',
  '\t\t\ttext: "Compaction is unavailable because this process has an active compaction, or the agent is not idle."',
  '\t\t};',
  '\t\tcase "cancelled": return {',
  '\t\t\tkind: "error",',
  '\t\t\ttext: "Compaction cancelled."',
  '\t\t};',
  '\t\tcase "changed": return {',
  '\t\t\tkind: "error",',
  '\t\t\ttext: "The history selected for compaction changed before it could be replaced. The attempt is recorded in the session log." + detail',
  '\t\t};',
  '\t\tcase "summary": return {',
  '\t\t\tkind: "error",',
  '\t\t\ttext: "Compaction could not produce a useful summary. The attempt is recorded in the session log." + detail',
  '\t\t};',
  '\t\tcase "commit": return {',
  '\t\t\tkind: "error",',
  '\t\t\ttext: "Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying." + detail',
  '\t\t};',
  '\t\tcase "persistence": return {',
  '\t\t\tkind: "error",',
  '\t\t\ttext: "Compaction finished, but the session could not be saved." + detail',
  '\t\t};',
  '\t\t/* v8 ignore next 2 -- ManualCompactionErrorCode is closed and every member is handled above */',
  '\t\tdefault: return assertNever(error.code);',
  '\t}',
  '}',
  '',
].join('\n');

/** Where the installed package might live, in priority order. */
function candidatePaths() {
  const candidates = [];
  const argvPath = process.argv.find((arg, index) => index >= 2 && !arg.startsWith('--'));
  if (argvPath !== undefined) candidates.push(argvPath);
  try {
    const require = createRequire(import.meta.url);
    candidates.push(join(dirname(require.resolve('@deepseek-ai/dsh-command-compact/package.json')), 'lib', 'index.js'));
  } catch {
    // Not resolvable from this repo (the engine does not depend on it).
  }
  if (process.env.DSH_INSTALL_DIR) {
    candidates.push(join(process.env.DSH_INSTALL_DIR, 'node_modules', '@deepseek-ai', 'dsh-command-compact', 'lib', 'index.js'));
  }
  candidates.push(join(...DEFAULT_INSTALL));
  return candidates;
}

const checkOnly = process.argv.includes('--check');
for (const path of candidatePaths()) {
  let source;
  try {
    source = await readFile(path, 'utf8');
  } catch {
    continue;
  }
  if (source.includes(MARKER)) {
    console.log(`already patched: ${path}`);
    process.exit(0);
  }
  if (!source.includes(ORIGINAL)) {
    console.error(`unrecognized expectedFailure block (upgrade changed the shape?) — refusing to patch: ${path}`);
    process.exitCode = 1;
    continue;
  }
  if (checkOnly) {
    console.log(`needs patch: ${path}`);
    process.exit(0);
  }
  await copyFile(path, `${path}.bak-quilt`);
  await writeFile(path, source.replace(ORIGINAL, PATCHED));
  console.log(`patched: ${path}`);
  console.log(`backup:  ${path}.bak-quilt`);
  console.log('restart the harness for the change to take effect.');
  process.exit(0);
}
console.error('dsh-command-compact lib/index.js not found; pass the path as the first argument.');
process.exitCode = 1;

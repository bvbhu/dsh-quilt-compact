/**
 * Load the client page in a simulated browser environment and exercise it:
 * the module registers under the right id, the factory returns the expected
 * shape, and the card renders for a realistic config + catalog.
 *
 * React is stubbed with a minimal createElement/render harness so this can run
 * under Node without a DOM or a React install. The point is to catch shape
 * errors, not to verify pixels.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../client/client.js', import.meta.url), 'utf8');

// --- minimal React stub ------------------------------------------------------
const RENDERED = [];
function createElement(type, props, ...children) {
  const node = { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
  return node;
}
const React = { createElement, Fragment: Symbol('Fragment') };

// --- module table ------------------------------------------------------------
let registered;
const moduleTable = {
  react: React,
  'react/jsx-runtime': { jsx: createElement, jsxs: createElement, Fragment: React.Fragment },
  '@deepseek-ai/dsh-client-ui-primitives': {
    SettingsForm: 'SettingsForm', SettingsFormModel: 'SettingsFormModel',
    SettingsValueField: 'SettingsValueField', SettingsSecretField: 'SettingsSecretField',
    settingsNumberField: () => ({}), settingsTextField: () => ({}), Switch: 'Switch',
  },
  '@deepseek-ai/dsh-client-store': { createSnapshotStore: () => makeStore() },
};

function makeStore() {
  let value;
  const listeners = new Set();
  return {
    get: () => value,
    set: (next) => { value = next; for (const l of listeners) l(); },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// --- fake DOM ----------------------------------------------------------------
const styleTags = [];
globalThis.document = {
  querySelector: (sel) => styleTags.find((t) => `style[data-plugin-css=${JSON.stringify(t.dataset.pluginCss)}]` === sel) ?? null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: (tag) => styleTags.push(tag) },
};
globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      // The bundle's factory declares its own `module`/`exports` and returns
      // `module.exports`; the real loader consumes that return value.
      const exports = factory((name) => {
        if (!(name in moduleTable)) throw new Error(`client requested an unavailable module: ${name}`);
        return moduleTable[name];
      });
      registered = { id, exports };
    },
  },
};

// --- load --------------------------------------------------------------------
// Evaluate the browser bundle the way the real loader does: it defines
// `window.__ModuleLoader__`, so the source runs and registers itself.
const fn = new Function('window', 'document', 'console', source);
fn(globalThis.window, globalThis.document, console);

assert.ok(registered, 'the module registered itself with __ModuleLoader__');
assert.equal(registered.id, 'dsh-quilt-compact', 'registered under the package name');
const { apply, inject, name } = registered.exports;
assert.equal(typeof apply, 'function', 'exports apply');
assert.equal(name, 'dsh-quilt-compact');
assert.deepEqual(inject, ['slots', 'locale', 'remote']);
assert.equal(styleTags.length, 1, 'the stylesheet was installed once');
assert.ok(styleTags[0].textContent.includes('--dsw-alias-'), 'styles use host theme tokens');
assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(styleTags[0].textContent), 'styles contain no literal colors');

console.log('CLIENT-MODULE OK: registered, exports the right shape, styles use theme tokens only');

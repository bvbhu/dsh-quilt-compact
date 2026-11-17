// ESM resolver hook: redirect bare @deepseek-ai/* (and zod) to the running DSH
// installation / profile, so the workspace needs no install. Node's own
// resolver does the exports/subpath work; only the SEARCH ROOT is overridden.
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'

const ROOTS = [
  path.resolve(process.env.DSH_INSTALL_DIR, '..'),
  path.resolve(process.env.DSH_PROFILE_DIR, 'node_modules'),
  path.resolve(process.env.DSH_PROFILE_DIR),
]

const requireFrom = ROOTS.map((root) => createRequire(path.join(root, 'noop.js')))

function isBare(specifier) {
  if (specifier.startsWith('node:')) return false
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes('://')
}

export async function resolve(specifier, context, nextResolve) {
  if (isBare(specifier)) {
    for (const req of requireFrom) {
      try {
        return { url: pathToFileURL(req.resolve(specifier)).href, shortCircuit: true }
      } catch {
        // Try the next root.
      }
    }
  }
  return nextResolve(specifier, context)
}

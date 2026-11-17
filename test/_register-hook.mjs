// Register the resolver hook in the MAIN thread so test/unit files inherit it
// even when --experimental-test-isolation separates execution.
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register('./_resolve-hook.mjs', pathToFileURL(import.meta.filename))

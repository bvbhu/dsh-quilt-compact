/**
 * Settings bridge for the dsh-quilt-compact compaction backend.
 *
 * The web profile runs the backend inside the `standard` agent preset's
 * `compaction` group (an isolate realm), not on the include tree. `dsh-settings`
 * only serves active, uniquely addressed include-tree entries, so its forms
 * cannot see — let alone edit — the preset-group row. The bridge is the page's
 * channel instead: it reads and writes the row through the same profile layer
 * the official editor uses (`configEditor`), with a small HTTP surface
 * (`/api/dsh-quilt-compact/{describe,mutate,status}`).
 *
 * This module is the framework-free core: every dependency (entry lookup,
 * catalog, config read/write) is injected, so the whole contract is unit-testable.
 *
 * @module dsh-quilt-compact/bridge
 */

/**
 * One bridge dependency bundle.
 * @typedef {object} BridgeDeps
 * @property {() => import('../lib/index.js').BridgeTarget | undefined} locate
 *   Resolve the row the page should edit: `{ kind: 'preset', entry, rowConfig }`
 *   when the backend lives inside a preset declaration, or
 *   `{ kind: 'host', entry, rowConfig }` for a plain host plane row.
 * @property {(config: object) => { ok: true, revision: number, value: object } | { ok: false, code: string, message: string }} read
 *   Read the effective config for the target with a fresh revision.
 * @property {(config: object, expectedRevision: number) => Promise<{ ok: true } | { ok: false, code: string, message: string }>} write
 *   Validate and persist the next config for the target.
 * @property {() => Promise<{ groups: unknown[] }>} catalog
 *   The runtime model catalog (providers + models).
 * @property {() => { engineServing: 'preset' | 'host' | 'none', basicDisabled: boolean, presetOverridden: boolean }} status
 *   Diagnostics for the page banner.
 */

/** @param {BridgeDeps} deps */
export function createBridgeHandlers(deps) {
  return {
    /** Full page state: config, model catalog, and status. */
    async describe() {
      const target = deps.locate();
      if (target === undefined) {
        return {
          ok: false,
          code: 'no-target',
          message: 'dsh-quilt-compact is not mounted as the compaction backend in this profile.',
        };
      }
      const readResult = deps.read(target);
      if (!readResult.ok) return readResult;
      const catalog = await deps.catalog().catch(() => ({ ok: false, code: 'catalog-failed', message: 'model catalog unavailable' }));
      return {
        ok: true,
        value: {
          source: target.kind,
          config: readResult.value,
          revision: readResult.revision,
          catalog: catalog.ok ? catalog.value : { groups: [] },
          catalogError: catalog.ok ? undefined : catalog.code,
          status: deps.status(),
        },
      };
    },

    /** Persist the next config, guarded by the revision fence. */
    async mutate(body) {
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return { ok: false, code: 'rejected', message: 'malformed bridge request' };
      }
      const target = deps.locate();
      if (target === undefined) {
        return { ok: false, code: 'no-target', message: 'dsh-quilt-compact is not mounted as the compaction backend in this profile.' };
      }
      return await deps.write(body.config, body.revision);
    },

    /** Configure-less diagnostics for the page banner. */
    async status() {
      return { ok: true, value: deps.status() };
    },
  };
}

/**
 * Simple loopback-only HTTP guard: the page is served by the same host, so
 * every bridge request must come from localhost. Non-POST requests get 405.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {(json: unknown, status?: number) => void} send
 * @returns {boolean} whether to continue processing
 */
export function guardBridgeRequest(req, res, send) {
  const host = req.headers.host ?? '';
  const isLoopback = /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/.test(host.split(':')[0] === '[' ? `[${host.split(']')[0]}]` : host);
  if (!isLoopback) {
    send({ error: 'loopback requests only' }, 403);
    return false;
  }
  if (req.method !== 'POST') {
    send({ error: 'method not allowed: ' + (req.method ?? '') }, 405);
    return false;
  }
  return true;
}

/**
 * Read a JSON request body (bounded).
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit] max bytes, default 256 KiB
 * @returns {Promise<unknown | undefined>} parsed JSON, or undefined on failure
 */
export function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (req.destroyed) { resolve(undefined); return; }
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw === '' ? undefined : JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

/**
 * Write a JSON response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
export function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * Build the exact-route descriptors for the ws server.
 * @param {import('./bridge.js').BridgeDeps} deps
 * @param {string} prefix
 * @param {number} [bodyLimit] max JSON body bytes for mutate (default 256 KiB)
 * @returns {Array<{ kind: 'exact', path: string, handler: (req, res) => Promise<void> }>}
 */
export function createBridgeRoutes(deps, prefix = '/api/dsh-quilt-compact', bodyLimit = 256 * 1024) {
  const handlers = createBridgeHandlers(deps);
  return [
    {
      kind: 'exact',
      path: `${prefix}/describe`,
      handler: async (req, res) => {
        if (!guardBridgeRequest(req, res, (json, status) => writeJson(res, status ?? 200, json))) return;
        writeJson(res, 200, await handlers.describe());
      },
    },
    {
      kind: 'exact',
      path: `${prefix}/mutate`,
      handler: async (req, res) => {
        if (!guardBridgeRequest(req, res, (json, status) => writeJson(res, status ?? 200, json))) return;
        const body = await readJsonBody(req, bodyLimit);
        if (body === undefined) { writeJson(res, 400, { ok: false, code: 'rejected', message: 'malformed JSON body' }); return; }
        writeJson(res, 200, await handlers.mutate(body));
      },
    },
    {
      kind: 'exact',
      path: `${prefix}/status`,
      handler: async (req, res) => {
        if (!guardBridgeRequest(req, res, (json, status) => writeJson(res, status ?? 200, json))) return;
        writeJson(res, 200, await handlers.status());
      },
    },
  ];
}
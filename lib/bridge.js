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

/** Loopback host names a browser can legitimately use for a local server. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Hostname of a `host` header authority (e.g. `127.0.0.1:3080`, `[::1]:3080`),
 * parsed by the platform rather than by hand: an IPv6 literal contains colons
 * INSIDE the host, so `host.split(':')[0]` reads `[::1]:3080` as `"["` and the
 * resulting regex never matches — a legitimate IPv6-loopback browser got a 403.
 * @param authority - the raw header value.
 * @returns the hostname, or `undefined` when it cannot be parsed.
 */
function hostnameOfAuthority(authority) {
  if (typeof authority !== 'string' || authority.length === 0) return undefined;
  try {
    return new URL(`http://${authority}`).hostname;
  } catch {
    return undefined;
  }
}

/** Whether a `host`-style authority names the loopback interface. */
function isLoopbackHost(authority) {
  const hostname = hostnameOfAuthority(authority);
  return hostname !== undefined && LOOPBACK_HOSTNAMES.has(hostname);
}

/** Whether a full URL (an `origin` or `referer` header) is a loopback origin. */
function isLoopbackOrigin(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(url).hostname);
  } catch {
    // Includes the literal 'null' origin a sandboxed frame sends.
    return false;
  }
}

/**
 * Loopback-only HTTP guard for the bridge routes: the page is served by the
 * same host, so every bridge request must come from localhost. Non-POST
 * requests get 405.
 *
 * The Host check alone is NOT a CSRF barrier: `Host: 127.0.0.1:3080` is set by
 * the BROWSER, so a page on any origin can POST to a loopback server and the
 * handler runs (the response is opaque to the attacker, but the config write has
 * already happened). A browser always sends `Origin` on a cross-origin POST —
 * including a `no-cors` fetch and a plain form submission — so a PRESENT but
 * foreign `Origin` (or `Referer`, when `Origin` is absent) is rejected here.
 * A request with NEITHER header is allowed: non-browser callers (curl, the
 * smoke probes, unit tests) are not subject to a browser's cross-site request.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {(json: unknown, status?: number) => void} send
 * @returns {boolean} whether to continue processing
 */
export function guardBridgeRequest(req, res, send) {
  const headers = req.headers ?? {};
  if (!isLoopbackHost(headers.host ?? '')) {
    send({ error: 'loopback requests only' }, 403);
    return false;
  }
  if (req.method !== 'POST') {
    send({ error: 'method not allowed: ' + (req.method ?? '') }, 405);
    return false;
  }
  if (headers.origin !== undefined) {
    if (!isLoopbackOrigin(headers.origin)) {
      send({ error: 'cross-origin requests are not allowed' }, 403);
      return false;
    }
  } else if (headers.referer !== undefined && !isLoopbackOrigin(headers.referer)) {
    send({ error: 'cross-origin requests are not allowed' }, 403);
    return false;
  }
  return true;
}

/**
 * Whether a request declares a JSON body.
 *
 * A cross-origin `fetch` may only send a "simple" request (no preflight) with
 * `text/plain`, `application/x-www-form-urlencoded`, or `multipart/form-data`.
 * Requiring JSON on the write route therefore forces a preflight for any
 * cross-origin attempt, which the loopback server never answers — a second,
 * independent layer behind the Origin check above. The shipped page always
 * sends `application/json`.
 */
export function hasJsonContentType(req) {
  const value = req.headers?.['content-type'];
  if (typeof value !== 'string') return false;
  return /^application\/(?:[\w.+-]+\+)?json\b/i.test(value.trim());
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
        // A cross-origin simple request can only send text/plain or form
        // encodings; requiring JSON forces a preflight the loopback server never
        // grants, so a forged write cannot reach the handler (see
        // {@link hasJsonContentType}).
        if (!hasJsonContentType(req)) {
          writeJson(res, 415, { ok: false, code: 'rejected', message: 'content-type must be application/json' });
          return;
        }
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
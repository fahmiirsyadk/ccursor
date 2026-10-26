/**
 * HTTP/1.1 router.
 *
 * Cursor's extension hosts make their API calls through `http.request` /
 * `https.request`. This module replaces both, so a call can be answered by the
 * local server instead of leaving the machine.
 *
 * The decision is made on the **path**, not the host:
 *
 *   /agent.v1.AgentService/RunSSE          -> local
 *   /aiserver.v1.AiService/AvailableModels -> local
 *   /auth/stripe_profile                   -> local
 *   anything else                          -> untouched
 *
 * Matching on the path means this does not depend on Cursor's hostnames, which
 * change between releases and between services. The path is the one part of the
 * contract the client cannot vary: it is the RPC it is calling.
 *
 * Two properties matter:
 *
 * 1. Only listed paths are diverted. Marketplace, updates and extension downloads
 *    keep working.
 * 2. HTTP/1.1 only. Cursor's transport factory picks HTTP/2 unless
 *    `cursor.general.disableHttp2` is true, and `node:http2` never touches
 *    `http.request`, so an HTTP/2 session bypasses this entirely. That is why the
 *    setting is not optional.
 *
 * The hook is installed once per process and is idempotent.
 */

import http from "node:http";
import https from "node:https";

const GUARD = Symbol.for("cursor-byok.router.installed");

/** Path without query string or fragment. */
export function pathOnly(pathname) {
  const raw = String(pathname ?? "");
  const hash = raw.indexOf("#");
  const withoutHash = hash === -1 ? raw : raw.slice(0, hash);
  const query = withoutHash.indexOf("?");
  return query === -1 ? withoutHash : withoutHash.slice(0, query);
}

/**
 * Decide whether a request should be diverted.
 *
 * `routes` is a list of rules:
 *   "aiserver.v1.AiService/AvailableModels"   one method
 *   "aiserver.v1.AiService"                   whole service
 *   "REST:/auth/stripe_profile"               a plain HTTP path
 */
export function shouldRedirect(pathname, routes) {
  const path = pathOnly(pathname);
  if (!path || path.length < 2) return false;

  for (const rule of routes) {
    if (typeof rule !== "string") continue;
    if (rule.startsWith("REST:")) {
      if (path === rule.slice(5)) return true;
      continue;
    }
    const trimmed = path.startsWith("/") ? path.slice(1) : path;
    if (trimmed === rule) return true;
    // whole-service rule: "pkg.Service" matches "pkg.Service/Method"
    const slash = trimmed.indexOf("/");
    if (slash > 0 && trimmed.slice(0, slash) === rule) return true;
  }
  return false;
}

/** Rewrite an absolute URL to the local base, keeping path and query. */
export function rewriteUrl(originalUrl, localBase) {
  const parsed = new URL(originalUrl);
  return localBase + parsed.pathname + parsed.search;
}

function headersToObject(headers) {
  if (!headers) return {};
  if (Array.isArray(headers)) {
    const out = {};
    if (headers.length && Array.isArray(headers[0])) {
      for (const [k, v] of headers) out[k] = v;
    } else {
      for (let i = 0; i + 1 < headers.length; i += 2) out[headers[i]] = headers[i + 1];
    }
    return out;
  }
  return { ...headers };
}

/** Drop headers that only make sense for the original destination. */
function localHeaders(headers, windowId) {
  const out = {};
  for (const [key, value] of Object.entries(headersToObject(headers))) {
    const lower = key.toLowerCase();
    if (lower === "host" || lower === ":authority") continue;
    out[key] = value;
  }
  if (windowId !== undefined && !("x-client-wid" in out)) out["x-client-wid"] = String(windowId);
  out["x-byok-route-source"] = "router";
  return out;
}

/** Is this request already addressed to the local server? */
function isLocalTarget(parsed, localBase) {
  try {
    const local = new URL(localBase);
    return (
      parsed.hostname === local.hostname &&
      (parsed.port || (parsed.protocol === "https:" ? "443" : "80")) ===
        (local.port || (local.protocol === "https:" ? "443" : "80"))
    );
  } catch {
    return false;
  }
}

/**
 * Install the hook.
 *
 * @param {object} options
 * @param {string} options.localBase e.g. "http://127.0.0.1:39831"
 * @param {string[]} options.routes redirect rules
 * @param {number} [options.windowId] forwarded as x-client-wid
 * @param {(event: object) => void} [options.onEvent] diagnostics
 * @returns {{uninstall: () => void}}
 */
export function install({ localBase, routes, windowId, onEvent } = {}) {
  if (globalThis[GUARD]) return globalThis[GUARD];

  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const originalHttpGet = http.get;
  const originalHttpsGet = https.get;

  const emit = (event) => {
    if (onEvent) {
      try {
        onEvent(event);
      } catch {
        /* diagnostics must never break routing */
      }
    }
  };

  function divert(parsed, options, callback) {
    const rewritten = rewriteUrl(parsed.href, localBase);
    emit({ type: "redirect", from: parsed.href, to: rewritten });

    const target = new URL(rewritten);
    const init = {
      method: options.method ?? "GET",
      headers: localHeaders(options.headers, windowId),
    };

    // Local server is plain HTTP; drop TLS-only options.
    return http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        ...init,
      },
      callback,
    );
  }

  function wrap(original, transport) {
    const owner = transport === "https" ? https : http;

    return function patched(input, options, callback) {
      // Node accepts (url, options, cb) or (options, cb) — never (options, options, cb).
      // Passing three arguments when the first is an object makes Node treat the
      // second as the listener, which throws. Normalise to a single shape.
      let opts = options;
      let cb = callback;
      if (typeof opts === "function") {
        cb = opts;
        opts = {};
      }
      opts ??= {};

      const passthrough = () =>
        typeof input === "object" && !(input instanceof URL)
          ? original.call(owner, input, cb)
          : original.call(owner, input, opts, cb);

      let parsed;
      try {
        if (typeof input === "string") parsed = new URL(input);
        else if (input instanceof URL) parsed = input;
        else if (input && typeof input === "object") {
          const protocol = input.protocol ?? (transport === "https" ? "https:" : "http:");
          const host = input.hostname ?? input.host;
          if (!host) return passthrough();
          // Keep the port: dropping it makes the local server look like a remote
          // host, and a diverted call would be diverted again, forever.
          const port = input.port ? `:${input.port}` : "";
          parsed = new URL(`${protocol}//${host}${port}${input.path ?? input.pathname ?? "/"}`);
        }
      } catch {
        return passthrough();
      }

      if (
        parsed &&
        !isLocalTarget(parsed, localBase) &&
        shouldRedirect(parsed.pathname, routes)
      ) {
        return divert(parsed, opts, cb);
      }

      return passthrough();
    };
  }

  http.request = wrap(originalHttpRequest, "http");
  https.request = wrap(originalHttpsRequest, "https");
  http.get = function patchedGet(input, options, callback) {
    const req = http.request(input, options, callback);
    req.end();
    return req;
  };
  https.get = function patchedGet(input, options, callback) {
    const req = https.request(input, options, callback);
    req.end();
    return req;
  };

  const handle = {
    uninstall() {
      http.request = originalHttpRequest;
      https.request = originalHttpsRequest;
      http.get = originalHttpGet;
      https.get = originalHttpsGet;
      delete globalThis[GUARD];
    },
  };

  globalThis[GUARD] = handle;
  emit({ type: "installed", localBase, rules: routes.length });
  return handle;
}

/** Is the hook currently installed? */
export function isInstalled() {
  return Boolean(globalThis[GUARD]);
}

/**
 * Injecting the router into Cursor's extension hosts.
 *
 * Cursor's extension hosts are CommonJS bundles. `src/router.js` is an ES module so
 * it can be unit-tested; this module turns it into a script that can be prepended to
 * a bundle, which keeps one implementation of the routing rules instead of two.
 *
 * The transform is narrow on purpose: two `import` lines become `require`, and
 * `export` keywords are removed. Everything else is copied byte for byte. A test
 * runs the generated script in a sandbox, so a transform that produces broken
 * JavaScript fails there rather than in a Cursor window.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FOREIGN_ROUTERS, ROUTED_EXTENSIONS, ROUTER_MARKER } from "./paths.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** First line of an injected bundle; `remove` anchors on it. */
export const HEADER = `/* ${ROUTER_MARKER} */`;

const routerSource = () => fs.readFileSync(path.join(here, "router.js"), "utf8");

/**
 * Strip ES module syntax so the file runs as a CommonJS script body.
 *
 * @param {string} source contents of src/router.js
 * @returns {string}
 */
export function toScriptBody(source) {
  return source
    .replace(/^import\s+(\w+)\s+from\s+"node:([\w/]+)";?$/gm, 'const $1 = require("node:$2");')
    .replace(/^export\s+const\s+/gm, "const ")
    .replace(/^export\s+function\s+/gm, "function ")
    .replace(/^export\s+class\s+/gm, "class ")
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, "");
}

/**
 * The bootstrap that reads routes.json and installs the hook.
 *
 * Configuration lives on disk rather than in the script, so the routes can change
 * without rewriting Cursor's bundles again.
 */
function bootstrap(routesPath, label) {
  return `
var ROUTES_PATH = ${JSON.stringify(routesPath)};
var PROCESS_LABEL = ${JSON.stringify(label)};
var _fs = require("node:fs");
var _handle = null;

function readConfig() {
  try {
    var cfg = JSON.parse(_fs.readFileSync(ROUTES_PATH, "utf8"));
    var host = (cfg && cfg.server && cfg.server.host) || "127.0.0.1";
    var port = (cfg && cfg.server && cfg.server.port) || 39831;
    return { localBase: "http://" + host + ":" + port, routes: (cfg && Array.isArray(cfg.redirect)) ? cfg.redirect : [] };
  } catch (error) {
    return { localBase: "http://127.0.0.1:39831", routes: [] };
  }
}

function windowId() {
  var title = String(process.env.VSCODE_PROCESS_TITLE || "");
  var match = title.match(/\\[(\\d+)-\\d+\\]/);
  return match ? Number(match[1]) : undefined;
}

function apply(reason) {
  var cfg = readConfig();
  if (_handle) { _handle.uninstall(); _handle = null; }
  _handle = install({
    localBase: cfg.localBase,
    routes: cfg.routes,
    windowId: windowId(),
    onEvent: function (event) {
      if (event.type === "installed") {
        console.log("[BYOK] " + PROCESS_LABEL + " " + reason + " -> " + event.localBase + " (" + event.rules + " rules)");
      }
    },
  });
}

apply("routes loaded");

try {
  _fs.watchFile(ROUTES_PATH, { interval: 2000, persistent: false }, function () {
    apply("routes reloaded");
  });
} catch (error) {
  console.warn("[BYOK] " + PROCESS_LABEL + " watch failed: " + error.message);
}
`;
}

/**
 * Build the script prepended to an extension host bundle.
 *
 * @param {string} source contents of src/router.js
 * @param {string} routesPath absolute path to routes.json
 * @param {string} [label] process label, for the log line
 * @returns {string}
 */
export function toScript(source, routesPath, label = "extension-host") {
  return `${HEADER}
(function(){
${toScriptBody(source)}
${bootstrap(routesPath, label)}
})();
`;
}

/** Absolute path of one routed extension host. */
export function hostPath(appRoot, entry) {
  return path.join(appRoot, entry.file);
}

/**
 * Remove a router another installer wrote, if there is one.
 *
 * Two hooks in the same process would divert the same call twice, so a foreign
 * router is removed rather than left in place.
 *
 * @returns {boolean} whether anything was removed
 */
export function stripForeign(data) {
  let out = data;
  let removed = false;

  for (const marker of FOREIGN_ROUTERS) {
    let at = out.indexOf(marker.start);
    while (at >= 0) {
      const endAt = out.indexOf(marker.end, at);
      if (endAt < 0) break;
      out = out.slice(0, at) + out.slice(endAt + marker.end.length);
      removed = true;
      at = out.indexOf(marker.start);
    }
  }

  return removed ? out : data;
}

/**
 * Prepend the router to one bundle.
 *
 * @returns {"injected"|"replaced"|"already"|"missing"}
 */
export function injectInto(appRoot, entry, routesPath) {
  const file = hostPath(appRoot, entry);
  if (!fs.existsSync(file)) return "missing";

  const original = fs.readFileSync(file, "utf8");
  if (original.includes(HEADER)) return "already";

  const stripped = stripForeign(original);
  fs.writeFileSync(file, toScript(routerSource(), routesPath, entry.label) + stripped);
  return stripped === original ? "injected" : "replaced";
}

/** Remove a previously injected router, restoring the bundle's own bytes. */
export function removeFrom(appRoot, entry) {
  const file = hostPath(appRoot, entry);
  const data = fs.readFileSync(file, "utf8");

  // Anchor on the header comment, not the bare marker: the marker also appears
  // inside the script, and slicing there would leave a stray "/* " behind.
  const at = data.indexOf(HEADER);
  if (at < 0) return false;

  const end = data.indexOf("})();\n", at);
  if (end < 0) throw new Error(`${path.basename(file)}: injected router is truncated`);

  fs.writeFileSync(file, data.slice(0, at) + data.slice(end + "})();\n".length));
  return true;
}

/**
 * Inject into every routed extension host.
 *
 * @returns {{file: string, label: string, status: string}[]}
 */
export function injectAll(appRoot, routesPath) {
  return ROUTED_EXTENSIONS.map((entry) => ({
    file: entry.file,
    label: entry.label,
    status: injectInto(appRoot, entry, routesPath),
  }));
}

/** Which extension hosts currently carry the router. */
export function injected(appRoot) {
  return ROUTED_EXTENSIONS.map((entry) => {
    try {
      return {
        label: entry.label,
        present: fs.readFileSync(hostPath(appRoot, entry), "utf8").includes(HEADER),
      };
    } catch {
      return { label: entry.label, present: false };
    }
  });
}

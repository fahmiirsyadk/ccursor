/**
 * The BYOK extension.
 *
 * Cursor's own code has no bring-your-own-key support. The feature comes from an
 * extension, and the extension bundle is also where the protobuf schema lives — it
 * is the only place in the install that carries `agent.v1` and `aiserver.v1`.
 *
 * So this module has one job: make sure that extension is present. Installing it is
 * delegated to a pinned upstream installer, because the extension is a large
 * third-party artifact and vendoring it here would mean redistributing it.
 *
 * Everything else about the setup — the router, the hash exemption, the routes, the
 * server, the schema cache — is ours and does not depend on that installer running.
 */

import fs from "node:fs";
import path from "node:path";

import { ROUTER_MARKER } from "./paths.js";
import { detail, ok, warn } from "./ui.js";

export { PINNED as PACKAGE, install } from "./vendor.js";

/** Is the extension installed in this app root? */
export function extensionPresent(appRoot) {
  return fs.existsSync(path.join(appRoot, "extensions", "cursor2plus"));
}

/** Path to the bundle that carries the protobuf schema. */
export function extensionBundle(appRoot) {
  return path.join(appRoot, "extensions", "cursor2plus", "dist", "extension.js");
}

/** Does the bundle exist? */
export function schemaSource(appRoot) {
  const file = extensionBundle(appRoot);
  return fs.existsSync(file) ? file : null;
}

/** [always-local, agent-host] — which extension hosts carry our router. */
export function routersPresent(appRoot) {
  const check = (relative) => {
    const file = path.join(appRoot, relative);
    try {
      return fs.readFileSync(file, "utf8").includes(ROUTER_MARKER);
    } catch {
      return false;
    }
  };
  return [
    check("extensions/cursor-always-local/dist/main.js"),
    check("extensions/cursor-agent-host/dist/main.js"),
  ];
}

/**
 * Make sure the extension is present, installing it when it is not.
 *
 * @param {string} appRoot
 * @returns {Promise<boolean>} true when the bundle is available afterwards
 */
export async function ensureExtension(appRoot) {
  if (extensionPresent(appRoot)) {
    detail("BYOK extension already installed");
    return true;
  }

  warn("BYOK extension missing; installing the pinned release");
  const installed = await install(appRoot);
  if (installed) ok("BYOK extension installed");
  return installed && extensionPresent(appRoot);
}

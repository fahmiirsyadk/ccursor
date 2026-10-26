/**
 * Configuration Cursor and the BYOK extension need in order to cooperate.
 *
 * Two settings decide whether BYOK traffic ever reaches the local server:
 *
 * `cursor.general.disableHttp2`
 *   Cursor's transport factory picks HTTP/2 whenever this is false. The BYOK
 *   router only hooks `http.request`/`https.request`, so an HTTP/2 session
 *   bypasses it and the request goes to Cursor's backend instead -- which is what
 *   produces "Protocol error" or "Server error" on every agent turn. Forcing
 *   HTTP/1.1 keeps the traffic on the hookable path.
 *
 * `routes.json -> server.port`
 *   The extension listens on this port and the router forwards to it. If a stale
 *   override in settings.json disagrees, redirects land on a closed port.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DEFAULT_PORT, providersFile, readJson, settingsFile, writeJson } from "./paths.js";
import * as routes from "./routes.js";
import { detail, ok, warn } from "./ui.js";

export const DISABLE_HTTP2 = "cursor.general.disableHttp2";
const PORT_OVERRIDE = "cursor2plus.server.port";

/** Force HTTP/1.1 and drop any port override that fights routes.json. */
export function ensureSettings() {
  const file = settingsFile();
  let current = readJson(file);

  if (current === null) {
    if (fs.existsSync(file)) {
      warn(`${file} is not valid JSON; leaving it alone`);
      return "invalid";
    }
    current = {};
  }

  let changed = false;
  if (current[DISABLE_HTTP2] !== true) {
    current[DISABLE_HTTP2] = true;
    changed = true;
  }
  if (PORT_OVERRIDE in current) {
    delete current[PORT_OVERRIDE];
    changed = true;
  }

  if (changed) {
    writeJson(file, current);
    ok(`settings.json: ${DISABLE_HTTP2} = true`);
    return "patched";
  }
  detail(`settings.json already correct (${DISABLE_HTTP2})`);
  return "already";
}

/**
 * Write the redirect list.
 *
 * The list is derived from Cursor's schema (see src/routes.js), so a method added in
 * a Cursor release is diverted without a code change. Previously this file was
 * owned by the third-party installer; we own it now, which is what makes the
 * router independent of them.
 *
 * @param {string} extensionJs path to the BYOK extension bundle (the schema source)
 */
export function ensureRoutes(extensionJs) {
  if (!extensionJs) {
    warn("routes.json not written: no schema source");
    return "skipped";
  }

  const result = routes.writeRoutes(extensionJs);

  if (result.changed) {
    ok(`routes.json: ${result.services} services + ${result.rest} REST paths`);
    return "patched";
  }
  detail(`routes.json ok (${result.services} services)`);
  return "already";
}

/** One-line summary of configured providers, for status output. */
export function describeProviders() {
  const data = readJson(providersFile());
  if (!data) return "missing";
  if (!Array.isArray(data.providers)) return "malformed";
  if (data.providers.length === 0) return "empty";
  const names = data.providers.map((p) => p?.id ?? "?");
  return `${names.length} (${names.join(", ")})`;
}

/** The provider/model pairs the picker should offer. */
export function providerCatalog() {
  const data = readJson(providersFile());
  if (!data || !Array.isArray(data.providers)) return [];
  const catalog = [];
  for (const provider of data.providers) {
    if (!Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!model?.id) continue;
      // "default" is Cursor's id for Auto. It is an alias, not a pickable model:
      // including it in the catalog would add a second Auto entry.
      if (model.id === "default") continue;
      catalog.push({
        id: model.id,
        displayName: model.displayName ?? model.id,
        contextTokenLimit: model.contextTokenLimit ?? 200000,
        supportsImages: model.supportsImages !== false,
        thinking: model.thinking === true,
        defaultOn: model.defaultOn === true,
      });
    }
  }
  return catalog;
}

/**
 * True when providers.json maps Cursor's Auto id ("default") to a real model.
 *
 * Cursor sends modelId "default" whenever Auto is selected, and a newly created
 * composer starts on Auto. Without this alias the BYOK server rejects the request
 * with "Model default was not found in providers.json".
 */
export function hasDefaultAlias() {
  const data = readJson(providersFile());
  if (!data || !Array.isArray(data.providers)) return false;
  return data.providers.some(
    (provider) =>
      Array.isArray(provider.models) && provider.models.some((model) => model?.id === "default"),
  );
}

/**
 * Rewrite product.json checksums for bundles we modified.
 *
 * Cursor verifies these on start. Stale entries do not stop the app, but they
 * produce integrity warnings; keeping them current keeps the log clean.
 */
export function refreshChecksums(appRoot, files) {
  const productPath = path.join(appRoot, "product.json");
  const product = readJson(productPath);
  if (!product?.checksums) return 0;

  const outRoot = path.join(appRoot, "out");
  let updated = 0;

  for (const file of files) {
    const key = path.relative(outRoot, file).split(path.sep).join("/");
    if (!(key in product.checksums)) continue;
    const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("base64");
    product.checksums[key] = digest.replace(/=+$/, "");
    updated += 1;
  }

  if (updated) writeJson(productPath, product);
  return updated;
}

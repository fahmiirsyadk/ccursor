/**
 * The redirect list.
 *
 * Built from Cursor's own schema rather than copied from anywhere: every service in
 * the namespaces we answer becomes a whole-service rule. That way a new method
 * added in a Cursor release is diverted automatically instead of silently reaching
 * Cursor's backend.
 *
 * The list is written to `~/.ccursor/routes.json`, which the injected router reads,
 * so the router itself needs no knowledge of service names.
 */

import fs from "node:fs";
import path from "node:path";

import { loadRoot } from "./proto/schema.js";
import { DEFAULT_PORT, ccursorDir, readJson, writeJson } from "./paths.js";
import { SINK_HOSTS } from "./local/telemetry.js";

/** Namespaces the local server answers in full. */
export const OWNED_PACKAGES = ["aiserver.v1", "agent.v1", "anyrun.v1", "internapi.v1"];

/**
 * Endpoints the renderer fetches as plain HTTP rather than as an RPC.
 *
 * These are the account and billing probes the UI makes on startup. They are
 * answered locally so the IDE does not need a reachable account.
 */
export const REST_ROUTES = [
  "/auth/full_stripe_profile",
  "/auth/stripe_profile",
  "/auth/has_valid_payment_method",
  "/auth/poll",
  "/auth/logout",
];

/**
 * Every service in the owned namespaces.
 *
 * @param {import("protobufjs").Root} root
 * @returns {string[]} fully-qualified service names
 */
export function ownedServices(root) {
  const names = [];

  const walk = (namespace) => {
    for (const nested of namespace.nestedArray ?? []) {
      if (nested.methods) {
        const full = nested.fullName.replace(/^\./, "");
        if (OWNED_PACKAGES.some((pkg) => full.startsWith(`${pkg}.`))) names.push(full);
        continue;
      }
      walk(nested);
    }
  };
  walk(root);

  return names.sort();
}

/**
 * Build the routes document.
 *
 * @param {import("protobufjs").Root} root
 * @returns {{$schemaVersion: number, server: object, redirect: string[]}}
 */
export function buildRoutes(root) {
  return {
    $schemaVersion: 1,
    server: { host: "127.0.0.1", port: DEFAULT_PORT },
    redirect: [...ownedServices(root), ...REST_ROUTES.map((route) => `REST:${route}`)],
    sink: [...SINK_HOSTS],
  };
}

/** Path of the routes file the router reads. */
export function routesPath() {
  return path.join(ccursorDir(), "routes.json");
}

/**
 * Write the routes file.
 *
 * @param {{workbench?: string, extension?: string}} sources where to read the schema
 * @returns {{path: string, services: number, rest: number, changed: boolean}}
 */
export function writeRoutes(sources) {
  const root = loadRoot(sources);
  const next = buildRoutes(root);
  const file = routesPath();
  const current = readJson(file);

  const changed =
    !current ||
    JSON.stringify(current.redirect) !== JSON.stringify(next.redirect) ||
    JSON.stringify(current.sink) !== JSON.stringify(next.sink) ||
    current?.server?.port !== next.server.port;

  if (changed) {
    writeJson(file, { ...(current ?? {}), ...next });
  }

  return {
    path: file,
    services: next.redirect.length - REST_ROUTES.length,
    rest: REST_ROUTES.length,
    sinks: next.sink.length,
    changed,
  };
}

/** How many rules the file currently holds, for `status`. */
export function describeRoutes() {
  const file = routesPath();
  if (!fs.existsSync(file)) return { present: false, services: 0, rest: 0 };
  const data = readJson(file);
  const redirect = Array.isArray(data?.redirect) ? data.redirect : [];
  return {
    present: true,
    services: redirect.filter((rule) => !String(rule).startsWith("REST:")).length,
    rest: redirect.filter((rule) => String(rule).startsWith("REST:")).length,
  };
}

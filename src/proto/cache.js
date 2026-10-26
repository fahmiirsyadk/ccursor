/**
 * A local copy of the protobuf schema.
 *
 * One source: Cursor's own client, whose generated code carries the schema it
 * encodes and decodes with. `apply` reads it out of the workbench bundle once and
 * writes the result here, so the server starts in milliseconds instead of parsing
 * 41 MB of JavaScript on every boot.
 *
 * Nothing is taken from a third-party extension: that copy is a separate artifact
 * with a different version, and it is missing methods the client already calls.
 */

import fs from "node:fs";
import path from "node:path";

import { stateDir } from "../paths.js";
import { readClientSchema } from "./client-schema.js";

/** Where the copy lives. */
export const cacheDir = () => path.join(stateDir(), "schema");

const manifestFile = () => path.join(cacheDir(), "manifest.json");
const schemaFile = () => path.join(cacheDir(), "client.json");

/** A stable fingerprint of a file, so an update invalidates the copy. */
function fingerprint(file) {
  const stat = fs.statSync(file);
  return `${stat.size}:${stat.mtimeMs}`;
}

function readManifest() {
  try {
    const data = JSON.parse(fs.readFileSync(manifestFile(), "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/**
 * Read the client schema out of a workbench bundle and store it.
 *
 * @param {string} workbenchBundle path to workbench.desktop.main.js
 * @returns {{source: string, messages: number, enums: number, services: number, methods: number, reused: boolean}}
 */
export function saveFromClient(workbenchBundle) {
  const manifest = readManifest();
  const stamp = fingerprint(workbenchBundle);

  if (
    manifest?.source === "client" &&
    manifest.bundle === workbenchBundle &&
    manifest.fingerprint === stamp &&
    fs.existsSync(schemaFile())
  ) {
    return { source: "client", ...manifest.stats, reused: true };
  }

  const { json, stats } = readClientSchema(workbenchBundle);
  if (stats.messages === 0) throw new Error("no protobuf messages found in the workbench bundle");

  fs.mkdirSync(cacheDir(), { recursive: true });
  fs.writeFileSync(schemaFile(), JSON.stringify(json));

  fs.writeFileSync(
    manifestFile(),
    `${JSON.stringify(
      {
        source: "client",
        bundle: workbenchBundle,
        fingerprint: stamp,
        savedAt: new Date().toISOString(),
        stats,
      },
      null,
      2,
    )}\n`,
  );

  return { source: "client", ...stats, reused: false };
}

/**
 * Load the cached schema.
 *
 * @returns {object|null} the protobufjs JSON tree, or null when there is no copy
 */
export function load() {
  try {
    return JSON.parse(fs.readFileSync(schemaFile(), "utf8"));
  } catch {
    return null;
  }
}

/** Is the copy usable, and does it still match the file it came from? */
export function isFreshFor(bundle) {
  const manifest = readManifest();
  if (!manifest || manifest.bundle !== bundle) return false;
  try {
    return manifest.fingerprint === fingerprint(bundle);
  } catch {
    return false;
  }
}

/** One-line description for `status`. */
export function describe() {
  const manifest = readManifest();
  if (!manifest) return { present: false, source: null, savedAt: null, stats: null };
  return {
    present: true,
    source: manifest.source,
    savedAt: manifest.savedAt,
    stats: manifest.stats ?? null,
  };
}

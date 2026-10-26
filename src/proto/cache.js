/**
 * A local copy of the protobuf schema.
 *
 * Two sources exist, and they are not equally good:
 *
 *   Cursor's own client    generated from the protocol it speaks today
 *   The BYOK extension     a separate, older artifact
 *
 * So the client wins. `apply` reads it out of the workbench bundle once, writes the
 * result here, and the server loads it from disk. That way the server does not need
 * the extension at all, and does not need to re-parse 41 MB of JavaScript to start.
 *
 * The extension's descriptors remain as a fallback for the case where the workbench
 * bundle cannot be read, and as a second opinion during `doctor`.
 */

import fs from "node:fs";
import path from "node:path";

import { stateDir } from "../paths.js";
import { readClientSchema } from "./client-schema.js";
import { readDescriptors } from "./descriptor.js";

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
 * Fall back to the descriptors inside the BYOK extension.
 *
 * Used when the workbench bundle is unreadable. The descriptors are protobuf, so
 * they are stored one file each.
 *
 * @param {string} extensionJs path to the extension bundle
 */
export function saveFromExtension(extensionJs) {
  const manifest = readManifest();
  const stamp = fingerprint(extensionJs);

  if (
    manifest?.source === "extension" &&
    manifest.bundle === extensionJs &&
    manifest.fingerprint === stamp
  ) {
    return { source: "extension", ...manifest.stats, reused: true };
  }

  const descriptors = readDescriptors(extensionJs);
  if (descriptors.length === 0) throw new Error("no protobuf descriptors found in the extension bundle");

  fs.rmSync(cacheDir(), { recursive: true, force: true });
  fs.mkdirSync(cacheDir(), { recursive: true });

  const files = descriptors.map((entry, index) => {
    const name = `descriptor-${index}.bin`;
    fs.writeFileSync(path.join(cacheDir(), name), entry.raw);
    return { name, package: entry.file.package, file: entry.file.name };
  });

  fs.writeFileSync(
    manifestFile(),
    `${JSON.stringify(
      {
        source: "extension",
        bundle: extensionJs,
        fingerprint: stamp,
        savedAt: new Date().toISOString(),
        stats: { messages: descriptors.length, files },
      },
      null,
      2,
    )}\n`,
  );

  return { source: "extension", messages: descriptors.length, reused: false };
}

/**
 * Load the cached schema.
 *
 * @returns {{kind: "client", json: object}|{kind: "extension", raws: Buffer[]}|null}
 */
export function load() {
  const manifest = readManifest();
  if (!manifest) return null;

  if (manifest.source === "client") {
    try {
      return { kind: "client", json: JSON.parse(fs.readFileSync(schemaFile(), "utf8")) };
    } catch {
      return null;
    }
  }

  const files = manifest.stats?.files ?? [];
  const raws = [];
  for (const entry of files) {
    const file = path.join(cacheDir(), entry.name);
    if (!fs.existsSync(file)) return null;
    raws.push(fs.readFileSync(file));
  }
  return raws.length > 0 ? { kind: "extension", raws } : null;
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

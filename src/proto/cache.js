/**
 * A local copy of Cursor's protobuf schema.
 *
 * The descriptors live inside the BYOK extension bundle, which is not part of
 * Cursor itself: it is installed by whatever put it there. Reading them at startup
 * therefore couples the server to a file it does not own.
 *
 * So `apply` extracts them once into our own state directory. The server reads that
 * copy, and only goes back to the bundle when the bundle is newer — which is exactly
 * the case where Cursor's protocol may have changed.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { stateDir } from "../paths.js";
import { readDescriptors } from "./descriptor.js";

/** Where the copy lives. */
export const cacheDir = () => path.join(stateDir(), "schema");

const manifestFile = () => path.join(cacheDir(), "manifest.json");

/** One file per descriptor, named after its package and file. */
function fileName(entry) {
  const safe = `${entry.file.package}/${entry.file.name}`.replace(/[^\w./-]/g, "_");
  return `${safe.replace(/\//g, "__")}.bin`;
}

/** Hash of a bundle, so a Cursor update invalidates the copy. */
function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Copy the descriptors out of a bundle.
 *
 * @param {string} extensionJs path to the BYOK extension bundle
 * @returns {{count: number, dir: string, reused: boolean}}
 */
export function save(extensionJs) {
  const dir = cacheDir();
  const manifest = readManifest();

  if (manifest && manifest.source === extensionJs && manifest.digest === digest(extensionJs)) {
    return { count: manifest.files.length, dir, reused: true };
  }

  const descriptors = readDescriptors(extensionJs);
  if (descriptors.length === 0) throw new Error("no protobuf descriptors found to cache");

  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const files = [];
  for (const entry of descriptors) {
    const name = fileName(entry);
    fs.writeFileSync(path.join(dir, name), entry.raw);
    files.push({
      name,
      package: entry.file.package,
      file: entry.file.name,
      bytes: entry.raw.length,
    });
  }

  fs.writeFileSync(
    manifestFile(),
    `${JSON.stringify(
      { source: extensionJs, digest: digest(extensionJs), savedAt: new Date().toISOString(), files },
      null,
      2,
    )}\n`,
  );

  return { count: files.length, dir, reused: false };
}

/** The manifest, or null when there is no usable copy. */
export function readManifest() {
  try {
    const data = JSON.parse(fs.readFileSync(manifestFile(), "utf8"));
    if (!Array.isArray(data.files) || data.files.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Raw descriptor buffers from the copy.
 *
 * @returns {Buffer[]|null} null when there is no copy on disk
 */
export function load() {
  const manifest = readManifest();
  if (!manifest) return null;

  const dir = cacheDir();
  const out = [];
  for (const entry of manifest.files) {
    const file = path.join(dir, entry.name);
    if (!fs.existsSync(file)) return null;
    out.push(fs.readFileSync(file));
  }
  return out;
}

/** Is the copy usable, and does it still match this bundle? */
export function isFreshFor(extensionJs) {
  const manifest = readManifest();
  if (!manifest) return false;
  try {
    return manifest.source === extensionJs && manifest.digest === digest(extensionJs);
  } catch {
    return false;
  }
}

/** One-line description for `status`. */
export function describe() {
  const manifest = readManifest();
  if (!manifest) return { present: false, count: 0, savedAt: null };
  return { present: true, count: manifest.files.length, savedAt: manifest.savedAt };
}

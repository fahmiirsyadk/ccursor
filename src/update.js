/**
 * Update a patched Cursor install from a fresh AppImage.
 *
 * A Cursor update replaces every file we patched, so the sequence is: extract the
 * new AppImage into a staging directory on the same filesystem, patch the staging
 * copy, verify it, and only then swap it into place. The previous tree is kept so
 * a bad build can be rolled back without re-downloading anything.
 *
 *   ~/Applications/Cursor.AppImage -> extract -> patch -> verify -> swap
 *                                                                  |
 *                                                                  +-- .old kept
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import * as bundles from "./bundles.js";
import * as ccursor from "./ccursor.js";
import * as settings from "./settings.js";
import * as state from "./state.js";
import { defaultAppImage, defaultInstallDir, readJson } from "./paths.js";
import { detail, fail, info, ok, warn } from "./ui.js";

const EXTRACTED = "squashfs-root";
const APP_SUFFIX = "usr/share/cursor/resources/app";

export class UpdateError extends Error {
  constructor(message) {
    super(message);
    this.name = "UpdateError";
  }
}

function appimagePath(explicit) {
  const file = explicit ? path.resolve(explicit) : defaultAppImage();
  if (!fs.existsSync(file)) throw new UpdateError(`AppImage not found: ${file}`);
  return file;
}

/** Run `--appimage-extract` inside `destination`; return the app root. */
function extract(appimage, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const result = spawnSync(appimage, ["--appimage-extract"], {
    cwd: destination,
    encoding: "utf8",
    timeout: 900_000,
  });

  if (result.error) throw new UpdateError(`extraction failed: ${result.error.message}`);
  if (result.status !== 0) {
    const tail = (result.stderr || result.stdout || "").trim().split("\n").pop();
    throw new UpdateError(`extraction failed: ${tail ?? `exit ${result.status}`}`);
  }

  const root = path.join(destination, EXTRACTED, APP_SUFFIX);
  if (!fs.existsSync(path.join(root, "product.json"))) {
    throw new UpdateError(`unexpected layout after extraction: ${root}`);
  }
  return root;
}

/** Apply every patch to a tree, raising on the first problem. */
export function patchTree(appRoot, { installHook = true } = {}) {
  // Baseline first: the upstream installer rewrites these bundles, so capturing
  // after it would make revert restore a hook-injected file instead of the one
  // Cursor shipped.
  for (const file of bundles.bundlePaths(appRoot)) state.captureBaseline(file);

  if (installHook && !ccursor.install(appRoot)) {
    throw new UpdateError("hook installer failed");
  }

  for (const file of bundles.bundlePaths(appRoot)) {
    const outcome = bundles.patchBundle(file);
    if (!outcome.changed && outcome.subscription === "not-found") {
      throw new UpdateError(`${path.basename(file)}: patch anchors not found`);
    }
  }

  settings.refreshChecksums(appRoot, bundles.bundlePaths(appRoot));
  settings.ensureSettings();
  settings.ensureRoutes();
}

/** Fail early rather than swap in a tree that will not start. */
export function verifyTree(appRoot) {
  const node = spawnSync("node", ["--version"], { encoding: "utf8" }).status === 0;

  for (const file of bundles.bundlePaths(appRoot)) {
    const data = fs.readFileSync(file, "utf8");
    if (!bundles.subscriptionPatched(data)) {
      throw new UpdateError(`${path.basename(file)}: subscription patch missing after apply`);
    }
    if (!bundles.adminPolicyPatched(data)) {
      throw new UpdateError(`${path.basename(file)}: admin policy patch missing after apply`);
    }
    if (!node) continue;

    const check = spawnSync("node", ["--check", file], { encoding: "utf8" });
    if (check.status !== 0) {
      const line = (check.stderr || "").split("\n").find(Boolean) ?? "syntax error";
      throw new UpdateError(`${path.basename(file)}: ${line}`);
    }
  }
}

/** Replace `<installDir>/squashfs-root` with the staged tree. */
function swap(installDir, staged) {
  const live = path.join(installDir, EXTRACTED);
  const previous = path.join(installDir, `${EXTRACTED}.old`);

  fs.rmSync(previous, { recursive: true, force: true });
  if (fs.existsSync(live)) fs.renameSync(live, previous);

  try {
    fs.renameSync(staged, live);
  } catch (error) {
    if (fs.existsSync(previous)) fs.renameSync(previous, live);
    throw error;
  }
  return previous;
}

export function rollback(installDir = defaultInstallDir()) {
  const live = path.join(installDir, EXTRACTED);
  const previous = path.join(installDir, `${EXTRACTED}.old`);
  if (!fs.existsSync(previous)) return false;
  fs.rmSync(live, { recursive: true, force: true });
  fs.renameSync(previous, live);
  return true;
}

export function run({ appimage, installDir, keepOld = true } = {}) {
  const target = installDir ? path.resolve(installDir) : defaultInstallDir();

  let source;
  try {
    source = appimagePath(appimage);
  } catch (error) {
    fail(error.message);
    return 1;
  }

  info(`source: ${source}`);
  info(`target: ${path.join(target, EXTRACTED)}`);

  // Stage on the same filesystem as the target: rename() cannot cross devices,
  // and a 1+ GB tree does not belong in tmpfs.
  fs.mkdirSync(target, { recursive: true });
  const staging = fs.mkdtempSync(path.join(target, ".cursor-byok-staging-"));

  try {
    info("extracting");
    const appRoot = extract(source, staging);
    const version = readJson(path.join(appRoot, "product.json"))?.version ?? null;
    detail(`version ${version}`);

    info("patching staged tree");
    patchTree(appRoot);
    verifyTree(appRoot);
    ok("staged tree verified");

    const previous = swap(target, path.join(staging, EXTRACTED));
    detail(`previous tree kept at ${previous}`);

    const liveRoot = path.join(target, EXTRACTED, APP_SUFFIX);
    state.writeMarker(liveRoot, bundles.bundlePaths(liveRoot), version);

    if (!keepOld) fs.rmSync(previous, { recursive: true, force: true });

    console.log();
    ok(`updated to ${version ?? "unknown"}`);
    detail("roll back with: cursor-byok update --rollback");
    return 0;
  } catch (error) {
    fail(error.message);
    warn("nothing was swapped; the existing install is untouched");
    return 1;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

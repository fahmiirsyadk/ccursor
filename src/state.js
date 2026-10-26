/**
 * Baselines, snapshots and the marker that detects a Cursor update.
 *
 * Three pieces of local state live under `~/.cursor-byok-patch`:
 *
 * `baselines/`
 *   Copy of each bundle as Cursor shipped it, captured before anything rewrites
 *   it -- including the upstream hook installer. `revert` restores from here, so
 *   it works even after several patch cycles.
 *
 * `backups/`
 *   Copy taken immediately before each write. Useful when a baseline predates the
 *   current Cursor version and revert would otherwise downgrade it.
 *
 * `applied.json`
 *   The bundle mtimes at the moment patching finished. If a bundle's mtime later
 *   changes, Cursor was updated and the patch is gone -- which is exactly what
 *   `run` uses to decide whether to re-apply before launching.
 */

import fs from "node:fs";
import path from "node:path";

import { backupDir, baselineDir, markerFile, readJson, writeJson } from "./paths.js";
import { detail } from "./ui.js";

const stamp = () => {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Copy a bundle once, before anything modifies it. Never overwritten. */
export function captureBaseline(file) {
  fs.mkdirSync(baselineDir(), { recursive: true });
  const target = path.join(baselineDir(), path.basename(file));
  if (!fs.existsSync(target)) {
    fs.copyFileSync(file, target);
    detail(`baseline ${target}`);
  }
  return target;
}

/** Timestamped copy taken right before a write. */
export function snapshot(file) {
  fs.mkdirSync(backupDir(), { recursive: true });
  const target = path.join(backupDir(), `${path.basename(file)}.${stamp()}`);
  fs.copyFileSync(file, target);
  detail(`backup ${path.basename(target)}`);
  return target;
}

export function restoreBaseline(file) {
  const source = path.join(baselineDir(), path.basename(file));
  if (!fs.existsSync(source)) return false;
  fs.copyFileSync(source, file);
  return true;
}

export function writeMarker(appRoot, files, version) {
  const bundles = {};
  for (const file of files) bundles[path.basename(file)] = fs.statSync(file).mtimeMs;
  writeJson(markerFile(), {
    appRoot,
    version,
    appliedAt: Date.now(),
    bundles,
  });
}

/** True when the recorded state still matches what is on disk. */
export function markerIsFresh(appRoot, files) {
  const data = readJson(markerFile());
  if (!data || data.appRoot !== appRoot || !data.bundles) return false;
  for (const file of files) {
    const recorded = data.bundles[path.basename(file)];
    if (recorded !== fs.statSync(file).mtimeMs) return false;
  }
  return true;
}

export function readMarker() {
  return readJson(markerFile()) ?? {};
}

export function describeMarker() {
  const data = readMarker();
  if (!data.appliedAt) return "no marker (never applied here)";
  const when = new Date(data.appliedAt).toLocaleString();
  return `applied ${when} against ${data.version ?? "?"}`;
}

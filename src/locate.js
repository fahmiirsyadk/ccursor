/**
 * Find the Cursor installation to patch.
 *
 * Cursor ships as an AppImage, a .deb, a .rpm, or an extracted directory. In every
 * case the JavaScript we patch lives under `resources/app`. This module resolves
 * that directory and reports enough detail for `doctor` to explain a failure.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultInstallDir, readJson } from "./paths.js";

/** Directories checked, in order, before any filesystem scan. */
export const STATIC_CANDIDATES = [
  "/opt/Cursor/resources/app",
  "/opt/cursor/resources/app",
  "/usr/share/cursor/resources/app",
  "/usr/lib/cursor/resources/app",
  "~/.local/share/cursor/resources/app",
  "~/Applications/squashfs-root/usr/share/cursor/resources/app",
];

/** Roots scanned for `*\/squashfs-root/usr/share/cursor/resources/app`. */
export const SCAN_ROOTS = ["~", "/tmp", "/opt"];

const home = () => process.env.HOME || os.homedir();

const expand = (raw) => (raw.startsWith("~") ? path.join(home(), raw.slice(2)) : raw);

const isAppRoot = (dir) =>
  fs.existsSync(path.join(dir, "product.json")) &&
  fs.existsSync(path.join(dir, "out", "vs", "workbench", "workbench.desktop.main.js"));

/** All plausible `resources/app` directories, most likely first. */
export function candidatePaths() {
  const seen = new Set();
  const ordered = [];

  const push = (dir) => {
    let resolved;
    try {
      resolved = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (!seen.has(resolved)) {
      seen.add(resolved);
      ordered.push(resolved);
    }
  };

  if (process.env.CURSOR_APP_ROOT) push(process.env.CURSOR_APP_ROOT);

  const install = defaultInstallDir();
  if (fs.existsSync(install)) {
    push(path.join(install, "squashfs-root/usr/share/cursor/resources/app"));
  }

  for (const raw of STATIC_CANDIDATES) push(expand(raw));

  for (const raw of SCAN_ROOTS) {
    const root = expand(raw);
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      push(path.join(root, entry, "squashfs-root/usr/share/cursor/resources/app"));
    }
  }

  return ordered;
}

/**
 * Locate a patchable Cursor install.
 *
 * @returns {{appRoot: string|null, version: string|null, candidates: {path: string, status: string}[], hint: string|null}}
 */
export function discover() {
  const result = { appRoot: null, version: null, candidates: [], hint: null };
  let partial = null;

  for (const dir of candidatePaths()) {
    if (!fs.existsSync(path.join(dir, "product.json"))) {
      result.candidates.push({ path: dir, status: "missing" });
      continue;
    }
    if (isAppRoot(dir)) {
      result.candidates.push({ path: dir, status: "ok" });
      result.appRoot = dir;
      result.version = readVersion(dir);
      return result;
    }
    result.candidates.push({ path: dir, status: "partial" });
    partial ??= dir;
  }

  result.hint = partial
    ? `found an install at ${partial} but workbench.desktop.main.js is missing; ` +
      "the layout may have changed or the extraction is incomplete"
    : "no Cursor install found. Set CURSOR_APP_ROOT to the resources/app directory, " +
      "e.g. CURSOR_APP_ROOT=~/Applications/CursorByok/squashfs-root/usr/share/cursor/resources/app";

  return result;
}

function readVersion(appRoot) {
  const product = readJson(path.join(appRoot, "product.json"));
  return typeof product?.version === "string" ? product.version : null;
}

/** The launcher that sits beside `resources/`. */
export function cursorBinary(appRoot) {
  const candidates = [
    path.join(appRoot, "..", "..", "cursor"),
    path.join(appRoot, "..", "cursor"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

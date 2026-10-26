/**
 * Filesystem layout of the project and of the files it touches.
 *
 * Paths are derived by factories rather than captured at import time, so tests
 * (and a HOME override) can point the whole tool at a temporary tree.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Port the BYOK server listens on; must match routes.json. */
export const DEFAULT_PORT = 39831;

/** Workbench bundles we patch, in order. */
export const BUNDLES = ["workbench.desktop.main.js", "workbench.glass.main.js"];

/** Sentinel written by the ccursor installer when it injects the hook. */
export const HOOK_MARKER = "CURSOR-BYOK-HOOK-START";

/** Marker the router patch writes into the extension hosts. */
export const ROUTER_MARKER = "BYOK-HTTP11-ROUTER-V2";

const home = () => process.env.HOME || os.homedir();

/** Our own state: baselines, snapshots, catalog cache and the update marker. */
export const stateDir = () =>
  process.env.CURSOR_BYOK_STATE || path.join(home(), ".cursor-byok-patch");

export const baselineDir = () => path.join(stateDir(), "baselines");
export const backupDir = () => path.join(stateDir(), "backups");
export const markerFile = () => path.join(stateDir(), "applied.json");
export const catalogCache = () => path.join(stateDir(), "catalog.json");

/** Configuration owned by the upstream @cometix/ccursor extension. */
export const ccursorDir = () => path.join(home(), ".ccursor");
export const routesFile = () => path.join(ccursorDir(), "routes.json");
export const providersFile = () => path.join(ccursorDir(), "providers.json");

/** Cursor's own settings and persisted renderer state. */
export const settingsFile = () =>
  path.join(home(), ".config", "Cursor", "User", "settings.json");

export const stateDbFile = () =>
  path.join(
    home(),
    ".config",
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb",
  );

/** Where a patched Cursor install lives. */
export const defaultInstallDir = () =>
  path.join(home(), "Applications", "CursorByok");

export const defaultAppImage = () =>
  path.join(home(), "Applications", "Cursor.AppImage");

/** Key holding the whole renderer user state in Cursor's SQLite store. */
export const USER_STATE_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";

/** The BYOK toggle key. Bracketed by design; assembled to avoid editor mangling. */
export const USE_KEY_FIELD = "use" + "[OI]" + "Key";

/** Read JSON, returning null when the file is missing or malformed. */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Write JSON atomically so a crash cannot truncate the target. */
export function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

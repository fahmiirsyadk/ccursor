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

/**
 * Marker our injector writes into the extension hosts.
 *
 * Deliberately not the name a third-party installer uses: if the two markers were
 * equal, "already injected" would be true for *their* router and ours would never be
 * installed.
 */
export const ROUTER_MARKER = "CURSOR-BYOK-ROUTER-3";

/**
 * Markers a third-party installer leaves behind, with the terminator it writes.
 *
 * `apply` replaces those blocks with ours rather than stacking a second router on
 * top: two hooks would divert the same call twice.
 */
export const FOREIGN_ROUTERS = [
  { start: "/* BYOK-HTTP11-ROUTER-V2 */", end: "/* BYOK-HTTP11-ROUTER-V2-END */" },
];

/**
 * Extensions whose files we rewrite, and which Cursor therefore cannot verify.
 *
 * Only `cursor-always-local` is in Cursor's expected-hash table; `cursor-agent-host`
 * is not, so it needs no exemption. Listed anyway, because the injector patches both
 * and a future Cursor may start verifying the second.
 */
export const EXEMPT_EXTENSIONS = [
  "anysphere.cursor-always-local",
  "anysphere.cursor-agent-host",
];

/** Extension hosts that receive the router, relative to the app root. */
export const ROUTED_EXTENSIONS = [
  { label: "always-local", file: "extensions/cursor-always-local/dist/main.js" },
  { label: "agent-host", file: "extensions/cursor-agent-host/dist/main.js" },
];

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

/**
 * The BYOK toggle field in Cursor's persisted user state.
 *
 * Assembled from parts on purpose: the field name contains a vendor token that some
 * tooling rewrites in logs and transcripts. Building it at runtime keeps the source
 * unambiguous and the value exact.
 *
 * Verified against state.vscdb: 12 bytes, "use" + "Open" + "AI" + "Key".
 * A literal "[" + "OI" + "]" here would produce a DIFFERENT, bogus field.
 */
export const USE_KEY_FIELD = "use" + "Open" + "AI" + "Key";

/**
 * A bogus field earlier versions of this tool wrote by mistaking the display
 * rendering for the real name. Removed during seeding so the state stays clean.
 */
export const BOGUS_KEY_FIELD = "use" + "[" + "OI" + "]" + "Key";

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

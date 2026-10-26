/**
 * Seed Cursor's persisted model catalog before it boots.
 *
 * The problem this solves:
 *
 *   Cursor starts -> renderer requests AvailableModels immediately
 *                 -> the BYOK extension needs ~8s to start listening
 *                 -> that first request reaches Cursor's real backend
 *                 -> it returns the full 46-model catalog
 *                 -> Cursor persists it, and your models are gone from the picker
 *
 *   Once the extension is up, later requests return only your models, but the
 *   renderer is busy with whatever it was doing and the correction may never be
 *   written back. The result is a picker that shows only Auto.
 *
 * Writing the catalog into state.vscdb before launching removes the race: the
 * first render already has the right models.
 *
 * Only catalog-shaped keys are touched. The BYOK toggle is left alone -- it is
 * already on, and the guards prevent it from flipping off.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  BOGUS_KEY_FIELD,
  USER_STATE_KEY,
  USE_KEY_FIELD,
  catalogCache,
  readJson,
  stateDbFile,
  writeJson,
} from "./paths.js";
import { detail, fail, ok, warn } from "./ui.js";
import { providerCatalog } from "./settings.js";

const CATALOG_FIELD = "availableDefaultModels2";

/** Cursor's model entry shape, filled with what we know about each model. */
function toModelEntry(model) {
  return {
    name: model.id,
    defaultOn: model.defaultOn,
    supportsAgent: true,
    supportsThinking: model.thinking,
    supportsImages: model.supportsImages,
    supportsAutoContext: true,
    autoContextMaxTokens: model.contextTokenLimit,
    autoContextExtendedMaxTokens: model.contextTokenLimit,
    supportsMaxMode: false,
    contextTokenLimit: model.contextTokenLimit,
    contextTokenLimitForMaxMode: model.contextTokenLimit,
    clientDisplayName: model.displayName,
    serverModelName: model.id,
    supportsNonMaxMode: true,
    supportsPlanMode: true,
    isUserAdded: false,
    supportsCmdK: true,
    supportsSandboxing: false,
    degradationStatus: "DEGRADATION_STATUS_UNSPECIFIED",
  };
}

function loadSqlite() {
  try {
    // node:sqlite is stable from Node 22.5 and needs no native build step.
    return createRequire(import.meta.url)("node:sqlite");
  } catch {
    return null;
  }
}

/**
 * A running Cursor holds the whole user state in memory and rewrites the row on
 * every persist, so a seed would be overwritten within seconds. Writing anyway
 * also risks a conflicting write against a live SQLite connection.
 */
export function cursorRunning() {
  try {
    const out = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" });
    return out
      .split("\n")
      .some((line) => /(^|\/)cursor\s+--(inspect|type=)/.test(line) || /\/cursor$/.test(line.trim()));
  } catch {
    return false;
  }
}

/**
 * Write the catalog into Cursor's state database.
 *
 * @param {{dryRun?: boolean, force?: boolean}} options
 * @returns {{status: string, count: number, models: string[]}}
 */
export function seedCatalog({ dryRun = false, force = false } = {}) {
  const catalog = providerCatalog();
  if (catalog.length === 0) {
    return { status: "no-providers", count: 0, models: [] };
  }

  const dbFile = stateDbFile();
  if (!fs.existsSync(dbFile)) {
    return { status: "no-state-db", count: 0, models: [] };
  }

  const sqlite = loadSqlite();
  if (!sqlite) {
    return { status: "no-sqlite", count: 0, models: [] };
  }

  // Cache the computed catalog so `run` can seed even when the DB is locked by a
  // starting Cursor.
  writeJson(catalogCache(), { generatedAt: Date.now(), models: catalog });

  if (dryRun) {
    return { status: "dry-run", count: catalog.length, models: catalog.map((m) => m.id) };
  }

  if (!force && cursorRunning()) {
    return { status: "cursor-running", count: catalog.length, models: catalog.map((m) => m.id) };
  }

  let db;
  try {
    db = new sqlite.DatabaseSync(dbFile);
  } catch (error) {
    return { status: `locked: ${error.message}`, count: 0, models: [] };
  }

  try {
    const row = db.prepare("select value from ItemTable where key = ?").get(USER_STATE_KEY);
    if (!row?.value) {
      return { status: "no-user-state", count: 0, models: [] };
    }

    const state = JSON.parse(row.value);
    const ids = catalog.map((m) => m.id);

    state[CATALOG_FIELD] = catalog.map(toModelEntry);

    // Turn the BYOK toggle on. Without this, Cursor treats the account as not using
    // a key, and its next settings reconcile prunes the models seeded above.
    state[USE_KEY_FIELD] = true;

    // Clean up a bogus field written by earlier versions of this tool, which
    // mistook the display rendering of the key for the key itself.
    delete state[BOGUS_KEY_FIELD];

    const ai = (state.aiSettings ??= {});
    ai.userAddedModels = ids;

    // Keep the enabled list in sync without inventing entries for models Cursor
    // does not know about.
    const enabled = Array.isArray(ai.modelOverrideEnabled) ? ai.modelOverrideEnabled : [];
    ai.modelOverrideEnabled = [...new Set([...enabled, ...ids])];
    ai.modelOverrideDisabled = (ai.modelOverrideDisabled ?? []).filter((id) => !ids.includes(id));

    // Pin every composer mode to the primary model. Without this a newly created
    // composer inherits "default" (Auto), and Cursor then sends modelId "default"
    // to the BYOK server, which has no such model unless an alias is configured.
    const primary = ids[0];
    const configs = (ai.modelConfig ??= {});
    for (const mode of Object.keys(configs)) {
      const entry = configs[mode];
      if (!entry || typeof entry !== "object") continue;
      entry.modelName = primary;
      entry.selectedModels = [{ modelId: primary, parameters: [] }];
    }

    db.prepare("update ItemTable set value = ? where key = ?").run(
      JSON.stringify(state),
      USER_STATE_KEY,
    );

    return { status: "seeded", count: catalog.length, models: ids };
  } catch (error) {
    return { status: `error: ${error.message}`, count: 0, models: [] };
  } finally {
    db.close();
  }
}

/** Read the catalog cache, used as a fallback when the DB cannot be opened. */
export function cachedCatalog() {
  return readJson(catalogCache());
}

export function reportSeed(result) {
  switch (result.status) {
    case "seeded":
      ok(`catalog seeded: ${result.count} model(s) — ${result.models.join(", ")}`);
      break;
    case "dry-run":
      ok(`would seed ${result.count} model(s) — ${result.models.join(", ")}`);
      break;
    case "no-providers":
      detail("no providers.json; models come from Cursor's own settings");
      break;
    case "no-state-db":
      warn("Cursor has never run here (no state.vscdb); skipping seed");
      break;
    case "no-sqlite":
      warn("node:sqlite unavailable; needs Node 22.5+ for catalog seeding");
      break;
    case "no-user-state":
      warn("state.vscdb has no user state yet; skipping seed");
      break;
    case "cursor-running":
      warn("Cursor is running; it would overwrite the catalog. Quit Cursor, then seed.");
      detail("run 'cursor-byok run' to seed and launch in one step");
      break;
    default:
      if (String(result.status).startsWith("locked")) {
        warn(`state.vscdb is locked (Cursor is running); seed skipped`);
      } else {
        fail(`seed failed: ${result.status}`);
      }
  }
}

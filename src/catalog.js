/**
 * Build an AvailableModels response from providers.json.
 *
 * The one RPC that needs no agent protocol: it returns a list of models and the
 * picker renders them. Getting this working proves the router, the framing and the
 * server before any agent code exists.
 *
 * When `providers.json` is absent, the catalog comes from Cursor's own settings
 * instead: the models the user added through its "Add Models" dialog. See
 * `catalogFromCursor`.
 */

import { createRequire } from "node:module";

import { lookupType } from "./proto/schema.js";
import { USER_STATE_KEY, providersFile, readJson, stateDbFile } from "./paths.js";

const RESPONSE = "aiserver.v1.AvailableModelsResponse";
const MODEL = "aiserver.v1.AvailableModelsResponse.AvailableModel";

/** `node:sqlite` is built in from Node 22.5; older versions do not have it. */
function loadSqlite() {
  try {
    return createRequire(import.meta.url)("node:sqlite");
  } catch {
    return null;
  }
}

/** Models from providers.json, in picker order. */
export function catalogFromProviders() {
  const data = readJson(providersFile());
  const out = [];
  if (!data || !Array.isArray(data.providers)) return out;

  for (const provider of data.providers) {
    for (const model of provider.models ?? []) {
      if (!model?.id) continue;
      out.push({
        id: model.id,
        displayName: model.displayName ?? model.id,
        contextTokenLimit: model.contextTokenLimit ?? 200000,
        supportsImages: model.supportsImages !== false,
        thinking: model.thinking === true,
        defaultOn: model.defaultOn === true,
      });
    }
  }
  return out;
}

/**
 * Models Cursor itself has stored.
 *
 * Two lists matter. `availableAPIKeyModels` holds what Cursor fetched from the
 * provider after the user added a model and a key; `availableDefaultModels2` is the
 * catalog the picker renders on boot. Both are plain JSON in Cursor's state
 * database, so reading them needs no key and no decryption.
 *
 * Read-only, and tolerant of a missing or locked database: an empty list is a
 * picker with nothing in it, which `doctor` can explain, not a crash.
 *
 * @returns {Array} the same shape `catalogFromProviders` returns
 */
export function catalogFromCursor() {
  const state = readCursorState();
  if (!state) return [];

  const out = [];
  const seen = new Set();

  for (const list of [state.availableAPIKeyModels, state.availableDefaultModels2]) {
    if (!Array.isArray(list)) continue;
    for (const model of list) {
      const id = typeof model?.name === "string" ? model.name : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        displayName: model.clientDisplayName ?? model.displayName ?? id,
        contextTokenLimit: model.contextTokenLimit ?? 200_000,
        supportsImages: model.supportsImages !== false,
        thinking: model.supportsThinking === true,
        defaultOn: model.defaultOn === true,
      });
    }
  }

  return out;
}

/**
 * What Cursor's own settings say about the endpoint.
 *
 * The base URL is the one the user typed in Cursor's model settings. Read-only, and
 * empty when Cursor has none or the database cannot be opened.
 *
 * @returns {{baseUrl: string}}
 */
export function cursorSettings() {
  const state = readCursorState();
  const baseUrl = typeof state?.openAIBaseUrl === "string" ? state.openAIBaseUrl.trim() : "";
  return { baseUrl };
}

/**
 * The JSON blob Cursor keeps its renderer state in.
 *
 * @returns {object|null} null when the database or the row is unavailable
 */
function readCursorState() {
  const sqlite = loadSqlite();
  if (!sqlite) return null;

  let db;
  try {
    db = new sqlite.DatabaseSync(stateDbFile(), { readOnly: true });
    const row = db.prepare("select value from ItemTable where key = ?").get(USER_STATE_KEY);
    if (!row?.value) return null;
    return JSON.parse(typeof row.value === "string" ? row.value : String(row.value));
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed, or never opened.
    }
  }
}

/**
 * The catalog to serve.
 *
 * `providers.json` wins when it lists anything, because a user who wrote that file
 * asked for exactly those models. Otherwise Cursor's own settings are used, so
 * adding a model in Cursor's UI is enough.
 *
 * @returns {{models: Array, source: "config"|"cursor"|"none"}}
 */
export function catalog() {
  const fromConfig = catalogFromProviders();
  if (fromConfig.length > 0) return { models: fromConfig, source: "config" };

  const fromCursor = catalogFromCursor();
  if (fromCursor.length > 0) return { models: fromCursor, source: "cursor" };

  return { models: [], source: "none" };
}

/**
 * The `default` id is Cursor's name for Auto. It is an alias, not a pickable model,
 * so it is skipped: including it would add a second Auto entry to the picker.
 */
export function pickableModels(catalog) {
  return catalog.filter((model) => model.id !== "default");
}

/**
 * Map one provider model onto AvailableModel fields.
 * Keys are snake_case because the schema is loaded with keepCase.
 */
function toAvailableModel(model) {
  return {
    name: model.id,
    client_display_name: model.displayName,
    server_model_name: model.id,
    default_on: model.defaultOn,
    supports_agent: true,
    supports_thinking: model.thinking,
    supports_images: model.supportsImages,
    supports_auto_context: true,
    auto_context_max_tokens: model.contextTokenLimit,
    auto_context_extended_max_tokens: model.contextTokenLimit,
    supports_max_mode: false,
    context_token_limit: model.contextTokenLimit,
    context_token_limit_for_max_mode: model.contextTokenLimit,
    supports_non_max_mode: true,
    supports_plan_mode: true,
    is_user_added: false,
    supports_sandboxing: false,
    supports_cmd_k: true,
    named_model_section_index: 0,
    degradation_status: 0,
  };
}

/**
 * Encode an AvailableModelsResponse.
 *
 * Per-mode configs are pinned to the primary model so a new composer does not start
 * on Auto and send modelId "default".
 *
 * @param {import("protobufjs").Root} root
 * @param {Array} catalog from catalogFromProviders()
 * @param {string} [primary] model id to pin the modes to
 * @returns {Buffer}
 */
export function buildAvailableModels(root, catalog, primary) {
  const Response = lookupType(root, RESPONSE);

  const models = pickableModels(catalog);
  const chosen = primary ?? models[0]?.id;

  const message = {
    model_names: models.map((m) => m.id),
    models: models.map(toAvailableModel),
    use_model_parameters: true,
  };

  // Pin every mode to the primary model. protobufjs converts nested objects
  // recursively, so a plain object is enough; pre-encoded Buffers are not
  // accepted for message-typed fields.
  if (chosen && Response.fields.composer_model_config) {
    const config = { default_model: chosen };
    message.composer_model_config = config;
    message.cmd_k_model_config = config;
    message.background_composer_model_config = config;
    message.plan_execution_model_config = config;
    message.spec_model_config = config;
    message.deep_search_model_config = config;
    message.quick_agent_model_config = config;
  }

  return Buffer.from(Response.encode(Response.fromObject(message)).finish());
}

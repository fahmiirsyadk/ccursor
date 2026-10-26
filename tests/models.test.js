/**
 * Where models and credentials come from.
 *
 * Cursor's own model settings are the primary source; `providers.json` is optional
 * and only needed for what the UI cannot express. These tests pin that precedence,
 * and that neither path invents a provider when the request carries nothing.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, beforeEach, describe, it } from "node:test";

import { catalog, catalogFromCursor, catalogFromProviders } from "../src/catalog.js";
import { inferType, providerFromCredentials, requestCredentials } from "../src/agent/credentials.js";
import { resolveForRequest } from "../src/agent/provider.js";
import { USER_STATE_KEY } from "../src/paths.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-byok-models-"));
const savedEnv = { ...process.env };

after(() => {
  process.env = { ...savedEnv };
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** A state directory with no providers.json, and a HOME with a state database. */
function makeInstall({ apiKeyModels = [], defaultModels = [] } = {}) {
  const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
  const state = fs.mkdtempSync(path.join(tmpRoot, "state-"));
  process.env.HOME = home;
  process.env.CURSOR_BYOK_STATE = state;

  const dbFile = path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });

  const db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
    USER_STATE_KEY,
    JSON.stringify({
      availableAPIKeyModels: apiKeyModels,
      availableDefaultModels2: defaultModels,
    }),
  );
  db.close();

  return { home, state };
}

/** Write a providers.json into the current state directory. */
function writeProviders(providers) {
  fs.writeFileSync(
    path.join(process.env.CURSOR_BYOK_STATE, "providers.json"),
    JSON.stringify({ providers }),
  );
}

const requestWith = (credentials) => ({
  requested_model: credentials ? { model_id: "m", api_key_credentials: credentials } : { model_id: "m" },
});

describe("credentials from the request", () => {
  it("reads the key and base URL the client attached", () => {
    const found = requestCredentials(
      requestWith({ api_key: "sk-abc", base_url: "https://api.example.com/v1" }),
    );

    assert.deepEqual(found, { apiKey: "sk-abc", baseUrl: "https://api.example.com/v1" });
  });

  it("falls back to model_details, and prefers requested_model", () => {
    const fromDetails = requestCredentials({
      model_details: { api_key_credentials: { api_key: "from-details" } },
    });
    assert.equal(fromDetails.apiKey, "from-details");

    const both = requestCredentials({
      requested_model: { api_key_credentials: { api_key: "requested" } },
      model_details: { api_key_credentials: { api_key: "details" } },
    });
    assert.equal(both.apiKey, "requested");
  });

  it("returns null rather than an empty provider", () => {
    assert.equal(requestCredentials({}), null);
    assert.equal(requestCredentials({ requested_model: {} }), null);
    assert.equal(requestCredentials(requestWith({ api_key: "   " })), null);
    assert.equal(requestCredentials(requestWith({ base_url: "https://x/v1" })), null, "no key");
  });

  it("infers the API shape from the host", () => {
    assert.equal(inferType("https://api.anthropic.com/v1"), "anthropic");
    assert.equal(inferType("https://api.example.com/v1"), "openai-chat");
    assert.equal(inferType("not a url"), "openai-chat");
  });

  it("builds a provider entry that needs no config file", () => {
    const provider = providerFromCredentials(
      { apiKey: "sk-abc", baseUrl: "https://api.example.com/v1/" },
      "vendor/model",
      { display_name: "Vendor Model" },
    );

    assert.equal(provider.type, "openai-chat");
    assert.equal(provider.baseUrl, "https://api.example.com/v1", "trailing slash dropped");
    assert.equal(provider.auth.value, "sk-abc");
    assert.equal(provider.models[0].id, "vendor/model");
    assert.equal(provider.models[0].displayName, "Vendor Model");
  });

  it("defaults the base URL when the client sent none", () => {
    const provider = providerFromCredentials({ apiKey: "sk-abc", baseUrl: "" }, "m");
    assert.equal(provider.baseUrl, "https://api.openai.com/v1");
  });
});

describe("resolving a provider for a turn", () => {
  beforeEach(() => {
    makeInstall({
      apiKeyModels: [{ name: "cursor-model", clientDisplayName: "Cursor Model" }],
    });
  });

  it("uses providers.json when the model is listed there", () => {
    writeProviders([
      {
        id: "cfg",
        name: "Config",
        type: "openai-chat",
        baseUrl: "https://config.example/v1",
        auth: { kind: "apiKey", value: "from-config" },
        models: [{ id: "m", apiModel: "upstream-m" }],
      },
    ]);

    const resolved = resolveForRequest(requestWith({ api_key: "sk-request" }), [
      {
        id: "cfg",
        name: "Config",
        type: "openai-chat",
        baseUrl: "https://config.example/v1",
        auth: { kind: "apiKey", value: "from-config" },
        models: [{ id: "m", apiModel: "upstream-m" }],
      },
    ], "m");

    assert.equal(resolved.source, "config");
    assert.equal(resolved.apiModel, "upstream-m", "config can rename the model");
  });

  it("falls back to the credentials in the request", () => {
    const resolved = resolveForRequest(
      requestWith({ api_key: "sk-request", base_url: "https://request.example/v1" }),
      [],
      "cursor-model",
    );

    assert.equal(resolved.source, "cursor");
    assert.equal(resolved.provider.baseUrl, "https://request.example/v1");
    assert.equal(resolved.apiModel, "cursor-model");
  });

  it("resolves Auto to the first model Cursor lists, with no alias file", () => {
    const resolved = resolveForRequest(
      requestWith({ api_key: "sk-request", base_url: "https://request.example/v1" }),
      [],
      "default",
    );

    assert.equal(resolved.apiModel, "cursor-model");
  });

  it("returns null when there is neither config nor credentials", () => {
    assert.equal(resolveForRequest({}, [], "m"), null);
  });
});

describe("catalog source", () => {
  it("reads the models Cursor itself stored", () => {
    makeInstall({
      apiKeyModels: [
        { name: "added", clientDisplayName: "Added Model", contextTokenLimit: 12345, supportsImages: false },
      ],
      defaultModels: [{ name: "booted", clientDisplayName: "Booted Model" }],
    });

    const models = catalogFromCursor();
    assert.deepEqual(models.map((m) => m.id), ["added", "booted"]);
    assert.equal(models[0].contextTokenLimit, 12345);
    assert.equal(models[0].supportsImages, false);
  });

  it("prefers providers.json, and uses Cursor's list only when it is absent", () => {
    makeInstall({ apiKeyModels: [{ name: "cursor-model" }] });

    assert.equal(catalog().source, "cursor");
    assert.deepEqual(catalog().models.map((m) => m.id), ["cursor-model"]);

    writeProviders([
      { id: "p", type: "openai-chat", baseUrl: "https://x/v1", models: [{ id: "configured" }] },
    ]);

    assert.equal(catalog().source, "config");
    assert.deepEqual(catalog().models.map((m) => m.id), ["configured"]);
    assert.deepEqual(catalogFromProviders().map((m) => m.id), ["configured"]);
  });

  it("reports none when neither source has anything", () => {
    makeInstall();
    assert.equal(catalog().source, "none");
    assert.deepEqual(catalog().models, []);
  });

  it("survives a missing state database", () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, "empty-home-"));
    process.env.HOME = home;
    process.env.CURSOR_BYOK_STATE = fs.mkdtempSync(path.join(tmpRoot, "empty-state-"));

    assert.deepEqual(catalogFromCursor(), []);
    assert.equal(catalog().source, "none");
  });
});

describe("a stored key, for when the client sends none", () => {
  it("uses the one-line key file with the base URL from Cursor's settings", async () => {
    const { state } = makeInstall({
      apiKeyModels: [{ name: "cursor-model" }],
      defaultModels: [],
    });

    // Cursor's base URL lives beside the model list.
    const dbFile = path.join(process.env.HOME, ".config/Cursor/User/globalStorage/state.vscdb");
    const db = new DatabaseSync(dbFile);
    db.prepare("UPDATE ItemTable SET value = ? WHERE key = ?").run(
      JSON.stringify({
        availableAPIKeyModels: [{ name: "cursor-model" }],
        openAIBaseUrl: "https://cursor-configured.example/v1",
      }),
      USER_STATE_KEY,
    );
    db.close();

    fs.writeFileSync(path.join(state, "apiKey"), "sk-from-file\n");

    const resolved = resolveForRequest({}, [], "cursor-model");
    assert.equal(resolved.source, "stored-key");
    assert.equal(resolved.provider.auth.value, "sk-from-file");
    assert.equal(resolved.provider.baseUrl, "https://cursor-configured.example/v1");
  });

  it("is ignored when the request already carries a key", () => {
    const { state } = makeInstall({ apiKeyModels: [{ name: "cursor-model" }] });
    fs.writeFileSync(path.join(state, "apiKey"), "sk-from-file");

    const resolved = resolveForRequest(
      requestWith({ api_key: "sk-request", base_url: "https://request.example/v1" }),
      [],
      "cursor-model",
    );

    assert.equal(resolved.source, "cursor");
    assert.equal(resolved.provider.auth.value, "sk-request");
  });
});

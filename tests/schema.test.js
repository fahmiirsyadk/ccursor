/**
 * Schema loading and AvailableModels encoding.
 *
 * These run against a real Cursor install when one is present, and skip otherwise,
 * because the whole point is that the schema is read from the app rather than
 * vendored.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { discover } from "../src/locate.js";
import { readDescriptors } from "../src/proto/descriptor.js";
import { clearCache, loadRoot, lookupType } from "../src/proto/schema.js";
import { buildAvailableModels, catalogFromProviders, pickableModels } from "../src/catalog.js";

function extensionJs() {
  const found = discover();
  if (!found.appRoot) return null;
  const file = path.join(found.appRoot, "extensions", "cursor2plus", "dist", "extension.js");
  return fs.existsSync(file) ? file : null;
}

/** Path to the workbench bundle, the primary schema source. */
function workbenchBundle() {
  const found = discover();
  if (!found.appRoot) return null;
  const file = path.join(found.appRoot, "out/vs/workbench/workbench.desktop.main.js");
  return fs.existsSync(file) ? file : null;
}

const bundle = extensionJs();
const skip = bundle ? false : "no Cursor install with the BYOK extension on this machine";

describe("descriptor discovery", { skip }, () => {
  it("finds every embedded schema", () => {
    const found = readDescriptors(bundle);
    const packages = new Set(found.map((d) => d.file.package));

    assert.ok(found.length >= 5, `expected several descriptors, got ${found.length}`);
    assert.ok(packages.has("agent.v1"), "agent.v1 present");
    assert.ok(packages.has("aiserver.v1"), "aiserver.v1 present");
  });

  it("dedupes identical blobs", () => {
    const found = readDescriptors(bundle);
    const keys = found.map((d) => `${d.file.package}/${d.file.name}`);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe("schema root", { skip }, () => {
  it("resolves the messages we depend on", () => {
    clearCache();
    const root = loadRoot({ workbench: workbenchBundle(), extension: bundle });

    for (const name of [
      "aiserver.v1.AvailableModelsResponse",
      "aiserver.v1.AvailableModelsResponse.AvailableModel",
      "agent.v1.AgentRunRequest",
      "agent.v1.AgentServerMessage",
      "agent.v1.InteractionUpdate",
    ]) {
      const type = lookupType(root, name);
      assert.ok(Object.keys(type.fields).length > 0, `${name} has fields`);
    }
  });

  it("caches per bundle path", () => {
    clearCache();
    assert.equal(loadRoot({ workbench: workbenchBundle(), extension: bundle }), loadRoot({ workbench: workbenchBundle(), extension: bundle }));
  });
});

describe("catalog", () => {
  it("skips the default alias so the picker has one Auto", () => {
    const catalog = [
      { id: "vendor/m" },
      { id: "default" },
    ];
    assert.deepEqual(pickableModels(catalog).map((m) => m.id), ["vendor/m"]);
  });

  it("reads models from the providers file", () => {
    const catalog = catalogFromProviders();
    // The file may be empty on a fresh machine; only shape is asserted here.
    assert.ok(Array.isArray(catalog));
    for (const model of catalog) assert.equal(typeof model.id, "string");
  });
});

describe("AvailableModels encoding", { skip }, () => {
  it("round-trips through the real schema", () => {
    const root = loadRoot({ workbench: workbenchBundle(), extension: bundle });
    const catalog = [
      {
        id: "vendor/test-model",
        displayName: "Test Model",
        contextTokenLimit: 128000,
        supportsImages: false,
        thinking: true,
        defaultOn: true,
      },
    ];

    const buf = buildAvailableModels(root, catalog);
    const decoded = root.lookupType("aiserver.v1.AvailableModelsResponse").decode(buf);

    assert.deepEqual(decoded.model_names, ["vendor/test-model"]);
    assert.equal(decoded.models.length, 1);
    assert.equal(decoded.models[0].name, "vendor/test-model");
    assert.equal(decoded.models[0].client_display_name, "Test Model");
    assert.equal(decoded.models[0].context_token_limit, 128000);
    assert.equal(decoded.models[0].supports_images, false);
    assert.equal(decoded.models[0].supports_thinking, true);
  });

  it("pins every per-mode config to the primary model", () => {
    const root = loadRoot({ workbench: workbenchBundle(), extension: bundle });
    const buf = buildAvailableModels(root, [{ id: "vendor/only", displayName: "Only" }]);
    const decoded = root.lookupType("aiserver.v1.AvailableModelsResponse").decode(buf);

    for (const mode of [
      "composer_model_config",
      "cmd_k_model_config",
      "background_composer_model_config",
      "plan_execution_model_config",
      "spec_model_config",
      "deep_search_model_config",
      "quick_agent_model_config",
    ]) {
      assert.equal(decoded[mode]?.default_model, "vendor/only", mode);
    }
  });

  it("omits the default alias from the response", () => {
    const root = loadRoot({ workbench: workbenchBundle(), extension: bundle });
    const buf = buildAvailableModels(root, [{ id: "vendor/m" }, { id: "default" }]);
    const decoded = root.lookupType("aiserver.v1.AvailableModelsResponse").decode(buf);

    assert.deepEqual(decoded.model_names, ["vendor/m"]);
  });
});

describe("client schema", { skip }, () => {
  it("reads the schema Cursor's own client is generated from", async () => {
    const { readClientSchema } = await import("../src/proto/client-schema.js");
    const { stats } = readClientSchema(workbenchBundle());

    assert.ok(stats.messages > 8000, `messages: ${stats.messages}`);
    assert.ok(stats.services > 50, `services: ${stats.services}`);
    assert.ok(stats.methods > 1000, `methods: ${stats.methods}`);
    assert.equal(stats.droppedFields, 0, "no field was silently dropped");
    assert.deepEqual(stats.unresolved, {}, "every type reference resolved");
  });

  it("is newer than the extension's copy", async () => {
    const protobuf = (await import("protobufjs")).default;
    const { readClientSchema } = await import("../src/proto/client-schema.js");

    const { rootFromExtension } = await import("../src/proto/schema.js");
    const client = protobuf.Root.fromJSON(readClientSchema(workbenchBundle()).json);
    const extension = rootFromExtension(bundle);

    // A method the client calls that the extension has never heard of is the whole
    // reason the client is preferred.
    const clientMethods = new Set();
    const walk = (ns, prefix) => {
      for (const nested of ns.nestedArray ?? []) {
        const name = prefix ? `${prefix}.${nested.name}` : nested.name;
        if (nested.methods) for (const method of Object.keys(nested.methods)) clientMethods.add(`${name}/${method}`);
        walk(nested, name);
      }
    };
    walk(client, "");

    let onlyInClient = 0;
    for (const route of clientMethods) {
      const [service, method] = route.split("/");
      let type = null;
      try {
        type = extension.lookup(service);
      } catch {
        type = null;
      }
      if (!type?.methods?.[method]) onlyInClient += 1;
    }

    assert.ok(onlyInClient > 0, `client knows ${onlyInClient} methods the extension does not`);
  });

  it("resolves every message it declares", async () => {
    const protobuf = (await import("protobufjs")).default;
    const { readClientSchema } = await import("../src/proto/client-schema.js");

    const root = protobuf.Root.fromJSON(readClientSchema(workbenchBundle()).json);
    assert.doesNotThrow(() => root.resolveAll());
  });
});

/**
 * The Auto alias and catalog seeding.
 *
 * Cursor sends modelId "default" whenever Auto is selected, and a fresh composer
 * starts on Auto. Without an entry with that id the BYOK server rejects the turn
 * outright, so the alias is not optional in practice.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { cmdAlias } from "../src/cli.js";
import * as settings from "../src/settings.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-byok-alias-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const savedHome = process.env.HOME;

function withProviders(payload, name) {
  const home = path.join(tmpRoot, name);
  const dir = path.join(home, ".cursor-byok-patch");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "providers.json");
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  process.env.HOME = home;
  return file;
}

const BASE = {
  $schemaVersion: 1,
  providers: [
    {
      id: "gw",
      type: "openai-chat",
      baseUrl: "https://example.test/v1",
      auth: { kind: "apiKey", value: "k" },
      models: [
        {
          id: "vendor/primary",
          apiModel: "vendor/primary",
          displayName: "Primary",
          contextTokenLimit: 100000,
        },
      ],
    },
  ],
};

after(() => {
  process.env.HOME = savedHome;
});

describe("alias", () => {
  it("adds a default alias pointing at the primary model", () => {
    const file = withProviders(structuredClone(BASE), "add");

    assert.equal(cmdAlias({}), 0);

    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    const models = written.providers[0].models;
    const alias = models.find((m) => m.id === "default");

    assert.ok(alias, "alias entry exists");
    assert.equal(alias.apiModel, "vendor/primary");
    assert.equal(alias.defaultOn, false);
    assert.equal(models.length, 2);
  });

  it("is idempotent", () => {
    const file = withProviders(structuredClone(BASE), "twice");

    cmdAlias({});
    const first = fs.readFileSync(file, "utf8");
    cmdAlias({});

    assert.equal(fs.readFileSync(file, "utf8"), first);
  });

  it("dry run writes nothing", () => {
    const file = withProviders(structuredClone(BASE), "dry");
    const before = fs.readFileSync(file, "utf8");

    assert.equal(cmdAlias({ dryRun: true }), 0);

    assert.equal(fs.readFileSync(file, "utf8"), before);
  });

  it("fails when there is no provider", () => {
    withProviders({ $schemaVersion: 1, providers: [] }, "empty");
    assert.equal(cmdAlias({}), 1);
  });
});

describe("hasDefaultAlias", () => {
  it("detects presence and absence", () => {
    withProviders(structuredClone(BASE), "detect-none");
    assert.equal(settings.hasDefaultAlias(), false);

    withProviders(structuredClone(BASE), "detect-some");
    cmdAlias({});
    assert.equal(settings.hasDefaultAlias(), true);
  });
});

describe("providerCatalog", () => {
  it("skips the alias so the picker shows one Auto", () => {
    withProviders(structuredClone(BASE), "catalog");
    cmdAlias({});

    const catalog = settings.providerCatalog();

    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].id, "vendor/primary");
  });
});

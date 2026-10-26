/**
 * Seeding must set the real BYOK toggle field.
 *
 * The field name contains a vendor token that some tooling rewrites in logs, so it
 * is assembled from parts in paths.js. An earlier version assembled it from the
 * wrong parts and wrote a bogus, similarly-named field while leaving the real toggle
 * false. These tests pin the exact bytes so that cannot happen again.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { BOGUS_KEY_FIELD, USE_KEY_FIELD } from "../src/paths.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-byok-toggle-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const hex = (s) => s.split("").map((c) => c.charCodeAt(0).toString(16)).join("");

describe("toggle field name", () => {
  it("is the 12-byte field Cursor actually persists", () => {
    assert.equal(USE_KEY_FIELD.length, 12);
    assert.equal(hex(USE_KEY_FIELD), "7573654f70656e41494b6579");
  });

  it("is not the bracketed lookalike", () => {
    assert.notEqual(USE_KEY_FIELD, BOGUS_KEY_FIELD);
    assert.equal(hex(BOGUS_KEY_FIELD), "7573655b4f495d4b6579");
    assert.ok(BOGUS_KEY_FIELD.includes("["));
    assert.ok(!USE_KEY_FIELD.includes("["));
  });
});

describe("seeding the toggle", () => {
  it("sets the real field and removes the bogus one", async () => {
    // Build a minimal state.vscdb that seed.js can open.
    const home = path.join(tmpRoot, "home");
    const dbDir = path.join(home, ".config/Cursor/User/globalStorage");
    const cfgDir = path.join(home, ".cursor-byok-patch");
    fs.mkdirSync(dbDir, { recursive: true });
    fs.mkdirSync(cfgDir, { recursive: true });

    fs.writeFileSync(
      path.join(cfgDir, "providers.json"),
      JSON.stringify({
        $schemaVersion: 1,
        providers: [
          {
            id: "gw",
            type: "openai-chat",
            baseUrl: "https://example.test/v1",
            auth: { kind: "apiKey", value: "k" },
            models: [{ id: "vendor/m", displayName: "M", contextTokenLimit: 1000 }],
          },
        ],
      }),
    );

    const { DatabaseSync } = await import("node:sqlite");
    const dbFile = path.join(dbDir, "state.vscdb");
    const db = new DatabaseSync(dbFile);
    db.exec("create table ItemTable (key text primary key, value text)");

    const stateKey =
      "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";
    const initial = {
      [USE_KEY_FIELD]: false,
      [BOGUS_KEY_FIELD]: true,
      availableDefaultModels2: [{ name: "default" }],
      aiSettings: { userAddedModels: [], modelConfig: {} },
    };
    db.prepare("insert into ItemTable (key, value) values (?, ?)").run(
      stateKey,
      JSON.stringify(initial),
    );
    db.close();

    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const seed = await import(`../src/seed.js?home=${Date.now()}`);
      const result = seed.seedCatalog({ force: true });
      assert.equal(result.status, "seeded");
    } finally {
      process.env.HOME = savedHome;
    }

    const check = new DatabaseSync(dbFile, { readOnly: true });
    const row = check.prepare("select value from ItemTable where key = ?").get(stateKey);
    check.close();
    const after = JSON.parse(row.value);

    assert.equal(after[USE_KEY_FIELD], true, "real toggle is on");
    assert.equal(BOGUS_KEY_FIELD in after, false, "bogus field removed");
    assert.equal(after.availableDefaultModels2.length, 1);
    assert.deepEqual(after.aiSettings.userAddedModels, ["vendor/m"]);
  });
});

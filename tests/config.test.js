/**
 * Discovery and configuration behaviour, using temporary directories.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";

import * as locate from "../src/locate.js";
import * as settings from "../src/settings.js";
import * as routes from "../src/routes.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-byok-cfg-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

function makeAppRoot(base) {
  const root = path.join(base, "usr/share/cursor/resources/app");
  fs.mkdirSync(path.join(root, "out/vs/workbench"), { recursive: true });
  fs.writeFileSync(path.join(root, "product.json"), JSON.stringify({ version: "9.9.9" }));
  fs.writeFileSync(path.join(root, "out/vs/workbench/workbench.desktop.main.js"), "// bundle");
  return root;
}

describe("discovery", () => {
  it("honours CURSOR_APP_ROOT", () => {
    const root = makeAppRoot(tmpRoot);
    process.env.CURSOR_APP_ROOT = root;

    const found = locate.discover();

    assert.ok(found.appRoot);
    assert.equal(fs.realpathSync(found.appRoot), fs.realpathSync(root));
    assert.equal(found.version, "9.9.9");
  });

  it("reports a hint when nothing is found", () => {
    process.env.CURSOR_APP_ROOT = path.join(tmpRoot, "nope");
    process.env.HOME = path.join(tmpRoot, "home");
    // isolate from any real install on the machine running the tests
    locate.STATIC_CANDIDATES.length = 0;
    locate.SCAN_ROOTS.length = 0;

    const found = locate.discover();

    assert.equal(found.appRoot, null);
    assert.ok(found.hint);
  });
});

describe("settings", () => {
  it("forces HTTP/1.1", () => {
    const file = path.join(tmpRoot, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ "cursor.general.disableHttp2": false }));
    process.env.HOME = path.join(tmpRoot, "h1");
    fs.mkdirSync(path.join(tmpRoot, "h1/.config/Cursor/User"), { recursive: true });
    fs.copyFileSync(file, path.join(tmpRoot, "h1/.config/Cursor/User/settings.json"));

    assert.equal(settings.ensureSettings(), "patched");

    const written = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, "h1/.config/Cursor/User/settings.json"), "utf8"),
    );
    assert.equal(written["cursor.general.disableHttp2"], true);

    assert.equal(settings.ensureSettings(), "already");
  });

  it("drops a stale port override", () => {
    const home = path.join(tmpRoot, "h2");
    const dir = path.join(home, ".config/Cursor/User");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ "cursor2plus.server.port": 39999 }));
    process.env.HOME = home;

    settings.ensureSettings();

    const written = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    assert.equal("cursor2plus.server.port" in written, false);
  });
});

describe("routes", () => {
  // The routes file is ours now: it is derived from Cursor's schema, not written by
  // a third-party installer. These tests pin the derivation, not a hand-written list.
  function fakeRoot(services) {
    const nested = services.map((full) => {
      const name = full.split(".").pop();
      return { fullName: `.${full}`, methods: { Ping: {} }, name };
    });
    return { nestedArray: nested };
  }

  it("builds one whole-service rule per owned service", () => {
    const root = fakeRoot([
      "aiserver.v1.AiService",
      "aiserver.v1.DashboardService",
      "agent.v1.AgentService",
    ]);

    const built = routes.buildRoutes(root);
    assert.deepEqual(
      built.redirect.filter((rule) => !rule.startsWith("REST:")),
      ["agent.v1.AgentService", "aiserver.v1.AiService", "aiserver.v1.DashboardService"],
    );
  });

  it("leaves services outside the owned namespaces alone", () => {
    const root = fakeRoot(["aiserver.v1.AiService", "other.v1.Thing"]);
    const built = routes.buildRoutes(root);

    assert.equal(built.redirect.includes("other.v1.Thing"), false);
  });

  it("includes the REST endpoints the renderer fetches directly", () => {
    const built = routes.buildRoutes(fakeRoot([]));
    assert.ok(built.redirect.includes("REST:/auth/stripe_profile"));
    assert.ok(built.redirect.includes("REST:/auth/poll"));
  });

  it("points at the local server", () => {
    const built = routes.buildRoutes(fakeRoot([]));
    assert.equal(built.server.host, "127.0.0.1");
    assert.equal(built.server.port, 39831);
  });
});

describe("checksums", () => {
  it("refreshes the entry for a patched bundle", () => {
    const appRoot = path.join(tmpRoot, "app-ck");
    const dir = path.join(appRoot, "out/vs/workbench");
    fs.mkdirSync(dir, { recursive: true });
    const bundle = path.join(dir, "workbench.desktop.main.js");
    fs.writeFileSync(bundle, "patched");
    fs.writeFileSync(
      path.join(appRoot, "product.json"),
      JSON.stringify({ checksums: { "vs/workbench/workbench.desktop.main.js": "stale" } }),
    );

    assert.equal(settings.refreshChecksums(appRoot, [bundle]), 1);

    const written = JSON.parse(fs.readFileSync(path.join(appRoot, "product.json"), "utf8"));
    assert.notEqual(written.checksums["vs/workbench/workbench.desktop.main.js"], "stale");
  });
});

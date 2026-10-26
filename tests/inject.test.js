/**
 * The injected router and the extension-verification exemption.
 *
 * The router is tested twice: as a module (router.test.js) and as the script that
 * actually lands in Cursor's bundle. The second test matters most, because a
 * transform that produces invalid JavaScript breaks the extension host at startup,
 * which is hard to notice from the outside.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { after, describe, it } from "node:test";

import * as inject from "../src/inject.js";
import { HEADER, toScript, toScriptBody } from "../src/inject.js";
import * as router from "../src/router.js";
import { EXEMPT_EXTENSIONS, ROUTED_EXTENSIONS, ROUTER_MARKER } from "../src/paths.js";
import * as host from "../src/extensionHost.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-byok-inject-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const routerSource = fs.readFileSync(new URL("../src/router.js", import.meta.url), "utf8");

describe("router transform", () => {
  it("drops every export keyword", () => {
    const body = toScriptBody(routerSource);
    assert.equal(/^export\s/m.test(body), false, "no export left behind");
  });

  it("turns node imports into require calls", () => {
    const body = toScriptBody(routerSource);
    assert.match(body, /const http = require\("node:http"\);/);
    assert.match(body, /const https = require\("node:https"\);/);
    assert.equal(/^import\s/m.test(body), false);
  });

  it("produces a script that parses", () => {
    const script = toScript(routerSource, "/tmp/routes.json");
    assert.doesNotThrow(() => new vm.Script(script));
  });

  it("carries the marker so injection is idempotent", () => {
    assert.ok(toScript(routerSource, "/tmp/routes.json").includes(ROUTER_MARKER));
  });
});

describe("router transform keeps behaviour", () => {
  /** Evaluate the transformed body and expose its helpers. */
  function transformedHelpers() {
    const body = `${toScriptBody(routerSource)}
globalThis.__helpers = { pathOnly, shouldRedirect, rewriteUrl, isLocalTarget };
`;
    const context = { console, process: { env: {} }, require: () => ({}), URL };
    vm.createContext(context);
    new vm.Script(body).runInContext(context);
    return context.__helpers;
  }

  const helpers = transformedHelpers();
  const routes = [
    "agent.v1.AgentService/RunSSE",
    "aiserver.v1.AiService/AvailableModels",
    "aiserver.v1.AuthService",
    "REST:/auth/stripe_profile",
  ];

  it("matches the module on every route shape", () => {
    for (const pathname of [
      "/agent.v1.AgentService/RunSSE",
      "/agent.v1.AgentService/RunSSE?x=1",
      "/aiserver.v1.AiService/AvailableModels",
      "/aiserver.v1.AuthService/GetEmail",
      "/auth/stripe_profile",
      "/aiserver.v1.AnalyticsService/Batch",
      "/",
      "",
    ]) {
      assert.equal(
        helpers.shouldRedirect(pathname, routes),
        router.shouldRedirect(pathname, routes),
        pathname,
      );
    }
  });

  it("does not divert a call that is already going to the local server", () => {
    // The router is installed in a process that also talks to the local server.
    // Diverting those calls again would recurse until the stack dies.
    const body = `${toScriptBody(routerSource)}
globalThis.__helpers = { isLocalTarget };
`;
    const context = { console, process: { env: {} }, require: () => ({}), URL };
    vm.createContext(context);
    new vm.Script(body).runInContext(context);

    const { isLocalTarget } = context.__helpers;
    const base = "http://127.0.0.1:39831";
    assert.equal(isLocalTarget(new URL("http://127.0.0.1:39831/agent.v1.AgentService/RunSSE"), base), true);
    assert.equal(isLocalTarget(new URL("https://api2.cursor.sh/agent.v1.AgentService/RunSSE"), base), false);
  });

  it("matches the module when rewriting a URL", () => {
    assert.equal(
      helpers.rewriteUrl("https://api2.cursor.sh/a/b?c=1", "http://127.0.0.1:39831"),
      router.rewriteUrl("https://api2.cursor.sh/a/b?c=1", "http://127.0.0.1:39831"),
    );
  });
});

describe("injection", () => {
  /** A fake app root with both extension hosts. */
  function makeApp(body = "// original bundle\nmodule.exports = {};\n") {
    const appRoot = fs.mkdtempSync(path.join(tmpRoot, "app-inj-"));
    for (const entry of ROUTED_EXTENSIONS) {
      const file = path.join(appRoot, entry.file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    }
    return appRoot;
  }

  const routesPath = "/tmp/routes.json";

  it("prepends the script and keeps the original bytes", () => {
    const appRoot = makeApp();
    const file = path.join(appRoot, ROUTED_EXTENSIONS[0].file);
    const before = fs.readFileSync(file, "utf8");

    const result = inject.injectAll(appRoot, routesPath);
    assert.deepEqual(result.map((entry) => entry.status), ["injected", "injected"]);

    const after = fs.readFileSync(file, "utf8");
    assert.ok(after.startsWith(HEADER));
    assert.ok(after.endsWith(before), "original bundle is intact");
  });

  it("is idempotent", () => {
    const appRoot = makeApp();
    inject.injectAll(appRoot, routesPath);

    const again = inject.injectAll(appRoot, routesPath);
    assert.deepEqual(again.map((entry) => entry.status), ["already", "already"]);

    const file = path.join(appRoot, ROUTED_EXTENSIONS[0].file);
    assert.equal(fs.readFileSync(file, "utf8").split(HEADER).length - 1, 1);
  });

  it("removes exactly what it added", () => {
    const appRoot = makeApp();
    const file = path.join(appRoot, ROUTED_EXTENSIONS[0].file);
    const before = fs.readFileSync(file, "utf8");

    inject.injectAll(appRoot, routesPath);
    assert.equal(inject.removeFrom(appRoot, ROUTED_EXTENSIONS[0]), true);

    assert.equal(fs.readFileSync(file, "utf8"), before);
  });

  it("produces a bundle that still parses", () => {
    const appRoot = makeApp();
    inject.injectAll(appRoot, routesPath);

    const file = path.join(appRoot, ROUTED_EXTENSIONS[0].file);
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(file, "utf8")));
  });

  it("reports which hosts carry the router", () => {
    const appRoot = makeApp();
    assert.deepEqual(
      inject.injected(appRoot).map((entry) => entry.present),
      [false, false],
    );

    inject.injectAll(appRoot, routesPath);
    assert.deepEqual(
      inject.injected(appRoot).map((entry) => entry.present),
      [true, true],
    );
  });

  it("replaces a router another installer wrote", () => {
    const foreign = `/* BYOK-HTTP11-ROUTER-V2 */
(function(){ var theirs = true; })();
/* BYOK-HTTP11-ROUTER-V2-END */
// original bundle
`;
    const appRoot = makeApp(foreign);
    const file = path.join(appRoot, ROUTED_EXTENSIONS[0].file);

    const result = inject.injectAll(appRoot, routesPath);
    assert.deepEqual(result.map((entry) => entry.status), ["replaced", "replaced"]);

    const after = fs.readFileSync(file, "utf8");
    assert.equal(after.includes("BYOK-HTTP11-ROUTER-V2"), false, "theirs is gone");
    assert.equal(after.includes("theirs"), false);
    assert.ok(after.includes(HEADER));
    assert.ok(after.endsWith("// original bundle\n"), "original bytes kept");
  });

  it("reports a missing extension host instead of throwing", () => {
    const appRoot = fs.mkdtempSync(path.join(tmpRoot, "app-empty-"));
    const result = inject.injectAll(appRoot, routesPath);
    assert.deepEqual(result.map((entry) => entry.status), ["missing", "missing"]);
  });
});

describe("extension verification", () => {
  /** A miniature of the real table: one exempt entry plus two others. */
  const fixture = `var i_e={"anysphere.cursor-always-local":{dist:{"main.js":"aaa"}},"anysphere.cursor-mcp":{dist:{"main.js":"bbb"}},"anysphere.cursor-retrieval":{dist:{"main.js":"ccc"}}};function f(o){const m=this._verifyExtensionFiles(l,i);if(!1)throw this._logService.error(\`Extension verification failed for \${o}: \${m.error}\`)}`;

  function makeApp(body = fixture) {
    const appRoot = fs.mkdtempSync(path.join(tmpRoot, "app-"));
    const file = host.hostProcessPath(appRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return appRoot;
  }

  it("exempts the extension we modify", () => {
    const appRoot = makeApp();
    const result = host.patchVerification(appRoot);

    assert.deepEqual(result.exempted, ["anysphere.cursor-always-local"]);

    const source = fs.readFileSync(host.hostProcessPath(appRoot), "utf8");
    assert.equal(source.includes('"anysphere.cursor-always-local":{dist:'), false);
    assert.equal(source.includes('"anysphere.cursor-mcp":{dist:'), true, "others kept");
  });

  it("restores the check for everything else", () => {
    const appRoot = makeApp();
    const result = host.patchVerification(appRoot);

    assert.equal(result.restored, true);
    const source = fs.readFileSync(host.hostProcessPath(appRoot), "utf8");
    assert.equal(source.includes("if(!1)throw"), false);
    assert.equal(source.includes("if(!m.valid)throw"), true);
  });

  it("is idempotent", () => {
    const appRoot = makeApp();
    host.patchVerification(appRoot);
    const second = host.patchVerification(appRoot);

    assert.equal(second.changed, false);
    assert.deepEqual(second.exempted, []);
  });

  it("leaves the table parseable", () => {
    const appRoot = makeApp();
    host.patchVerification(appRoot);

    const source = fs.readFileSync(host.hostProcessPath(appRoot), "utf8");
    const start = source.indexOf("var i_e=");
    const literal = source.slice(start + "var i_e=".length, source.indexOf(";function f"));

    const table = vm.runInNewContext(`(${literal})`);
    assert.deepEqual(Object.keys(table).sort(), [
      "anysphere.cursor-mcp",
      "anysphere.cursor-retrieval",
    ]);
  });

  it("reports what is verified and what is exempt", () => {
    const appRoot = makeApp();
    host.patchVerification(appRoot);

    const state = host.describe(appRoot);
    assert.equal(state.table, true);
    assert.equal(state.disabled, false);
    assert.equal(state.verified, 2);
    assert.ok(state.exempt.includes("anysphere.cursor-always-local"));
    assert.deepEqual(
      EXEMPT_EXTENSIONS.filter((name) => name === "anysphere.cursor-agent-host"),
      ["anysphere.cursor-agent-host"],
    );
  });

  it("refuses a bundle whose table is gone", () => {
    const appRoot = makeApp("// nothing here");
    assert.throws(() => host.patchVerification(appRoot), /table not found/);
  });
});

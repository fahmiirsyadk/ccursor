/**
 * Everything else Cursor asks for.
 *
 * The router redirects a fixed set of RPCs. None of them may error: an error is a
 * red toast in the IDE, and the goal is a client that never notices it is talking to
 * a local server. These tests walk the redirect list and assert each one answers.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { discover } from "../src/locate.js";
import { loadRoot } from "../src/proto/schema.js";
import { stream, unary } from "./helpers/rpc.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-byok-local-"));
const savedEnv = { ...process.env };

after(() => {
  process.env = { ...savedEnv };
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

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

/** The redirect set, as routes.json lists it. */
const ROUTES = [
  "aiserver.v1.AiService/ServerTime",
  "aiserver.v1.AiService/GetDefaultModel",
  "aiserver.v1.AiService/GetDefaultModelNudgeData",
  "aiserver.v1.AiService/KnowledgeBaseList",
  "aiserver.v1.AiService/KnowledgeBaseAdd",
  "aiserver.v1.AiService/KnowledgeBaseUpdate",
  "aiserver.v1.AiService/KnowledgeBaseRemove",
  "aiserver.v1.DashboardService/GetPlanInfo",
  "aiserver.v1.DashboardService/GetCurrentPeriodUsage",
  "aiserver.v1.DashboardService/GetTeams",
  "aiserver.v1.DashboardService/GetUserPrivacyMode",
  "aiserver.v1.DashboardService/GetUsageLimitStatusAndActiveGrants",
  "aiserver.v1.DashboardService/GetEffectiveUserPlugins",
  "aiserver.v1.DashboardService/IsOnNewPricing",
  "aiserver.v1.DashboardService/GetManagedSkills",
  "aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam",
  "aiserver.v1.DashboardService/GetTeamReposOrEmptyIfNotInTeam",
  "aiserver.v1.DashboardService/GetTeamAdminSettings",
  "aiserver.v1.DashboardService/GetTeamBackgroundAgentSettings",
  "aiserver.v1.DashboardService/GetTeamRepos",
  "aiserver.v1.DashboardService/GetGlobalCommands",
  "aiserver.v1.DashboardService/GetTeamCommands",
  "aiserver.v1.DashboardService/GetSlackInstallUrl",
  "aiserver.v1.DashboardService/ShareCanvas",
  "aiserver.v1.DashboardService/LookupSharedCanvasByKey",
  "aiserver.v1.AnalyticsService/Batch",
  "aiserver.v1.ChatService/GetConversationSummary",
  "aiserver.v1.ChatService/StreamSpeculativeSummaries",
  "aiserver.v1.BackgroundComposerService/ListBackgroundComposers",
  "aiserver.v1.BackgroundComposerService/GetBackgroundComposerUserSettings",
  "aiserver.v1.BackgroundComposerService/ListTeamEnvironments",
  "aiserver.v1.BackgroundComposerService/ListPersonalEnvironments",
  "aiserver.v1.InAppAdService/GetAllAdPreviews",
  "aiserver.v1.HealthService/Ping",
  "aiserver.v1.ServerConfigService/GetServerConfig",
  "aiserver.v1.NetworkService/GetPublicIp",
  "aiserver.v1.NetworkService/IsConnected",
  "aiserver.v1.AuthService/GetEmail",
  "aiserver.v1.AuthService/GetUserMeta",
  "aiserver.v1.DashboardService/GetMe",
  "aiserver.v1.DashboardService/GetUserOrganizations",
];

/** Endpoints the renderer fetches as plain HTTP. */
const REST_ROUTES = [
  "/auth/full_stripe_profile",
  "/auth/stripe_profile",
  "/auth/has_valid_payment_method",
  "/auth/logout",
  "/auth/poll",
];

describe("local RPC surface", { skip }, () => {
  let instance;
  let root;
  let base;

  before(async () => {
    root = loadRoot({ workbench: workbenchBundle(), extension: bundle });

    const home = path.join(tmpRoot, "home");
    fs.mkdirSync(path.join(home, ".ccursor"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".ccursor", "providers.json"),
      JSON.stringify({
        providers: [
          {
            id: "stub",
            name: "Stub",
            type: "openai-chat",
            baseUrl: "http://127.0.0.1:1/v1",
            auth: { kind: "apiKey", value: "k" },
            models: [{ id: "vendor/model", apiModel: "vendor-model" }],
          },
        ],
      }),
    );

    process.env.HOME = home;
    process.env.CURSOR_BYOK_STATE = path.join(tmpRoot, "state");

    const { createServer } = await import("../src/server.js");
    instance = createServer({ extensionJs: bundle, port: 0 });
    const address = await instance.listen();
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await instance?.close();
  });

  it("answers every redirected RPC without an error", async () => {
    for (const route of ROUTES) {
      const method = methodFor(root, route);
      // Streaming RPCs get a framed request, unary ones a plain body, exactly as
      // the client sends them.
      const response = method?.responseStream
        ? await stream(base, route, Buffer.alloc(0))
        : await unary(base, route, Buffer.alloc(0));

      assert.equal(response.status, 200, route);

      const type = response.headers.get("content-type") ?? "";
      assert.ok(
        type === "application/proto" || type === "application/connect+proto",
        `${route} answered as ${type}`,
      );

      const body = Buffer.from(await response.arrayBuffer());
      if (type === "application/proto") {
        // A real message of the declared type, not an error object.
        assert.ok(method, `${route} exists in the schema`);
        assert.doesNotThrow(() => {
          root.lookupType(String(method.responseType).replace(/^\./, "")).decode(body);
        }, `${route} decoded as its response type`);
      } else {
        assert.ok(body.length >= 5, `${route} streamed a frame`);
      }
    }
  });

  it("reports a plausible clock", async () => {
    const response = await unary(base, "aiserver.v1.AiService/ServerTime", Buffer.alloc(0));
    const body = Buffer.from(await response.arrayBuffer());
    const decoded = root.lookupType("aiserver.v1.ServerTimeResponse").decode(body);

    const seconds = Number(decoded.receive_timestamp);
    assert.ok(Math.abs(seconds - Date.now() / 1000) < 60, "clock is current");
  });

  it("names the configured model as the default", async () => {
    const response = await unary(base, "aiserver.v1.AiService/GetDefaultModel", Buffer.alloc(0));
    const body = Buffer.from(await response.arrayBuffer());
    const decoded = root.lookupType("aiserver.v1.GetDefaultModelResponse").decode(body);

    assert.equal(decoded.model, "vendor/model");
  });

  it("reports a plan that needs no upgrade", async () => {
    const response = await unary(base, "aiserver.v1.DashboardService/GetPlanInfo", Buffer.alloc(0));
    const body = Buffer.from(await response.arrayBuffer());
    const decoded = root.lookupType("aiserver.v1.GetPlanInfoResponse").decode(body);

    assert.equal(decoded.plan_info?.plan_name, "BYOK");
  });

  it("reports no storage as the privacy mode", async () => {
    const response = await unary(
      base,
      "aiserver.v1.DashboardService/GetUserPrivacyMode",
      Buffer.alloc(0),
    );
    const body = Buffer.from(await response.arrayBuffer());
    const decoded = root.lookupType("aiserver.v1.GetUserPrivacyModeResponse").decode(body);

    assert.equal(decoded.privacy_mode, 1);
  });

  it("accepts and drops analytics", async () => {
    const response = await unary(base, "aiserver.v1.AnalyticsService/Batch", Buffer.alloc(0));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/proto");
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  });

  it("answers the auth endpoints the renderer calls directly", async () => {
    for (const route of REST_ROUTES) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 200, route);
      const body = await response.json();
      assert.equal(typeof body, "object", route);
    }
  });

  it("answers an unknown service with an empty message rather than an error", async () => {
    // A client newer than our schema calls methods we have never seen. Failing the
    // call surfaces a toast; an empty body decodes as an empty message.
    const response = await fetch(`${base}/aiserver.v1.NopeService/Nope`, {
      method: "POST",
      body: "",
    });

    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  });
});

/** Find a method descriptor by route. */
function methodFor(root, route) {
  const [service, name] = route.split("/");
  try {
    return root.lookup(service).methods[name];
  } catch {
    return null;
  }
}

describe("telemetry sink", { skip }, () => {
  let instance;
  let base;

  before(async () => {
    process.env.HOME = path.join(tmpRoot, "home-sink");
    process.env.CURSOR_BYOK_STATE = path.join(tmpRoot, "state-sink");
    const { createServer } = await import("../src/server.js");
    instance = createServer({ extensionJs: bundle, port: 0 });
    const address = await instance.listen();
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await instance?.close();
  });

  it("accepts a report with no body", async () => {
    const response = await fetch(`${base}/byok/sink`, {
      method: "POST",
      body: "{}",
    });

    assert.equal(response.status, 204);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  });

  it("answers a route the cached schema does not know with an empty message", async () => {
    // Cursor's client is newer than the extension bundle that carries the schema, so
    // this happens in practice. An error would be a red toast; an empty message is a
    // valid encoding of any response type.
    const response = await fetch(`${base}/aiserver.v1.AiService/SomeFutureMethod`, {
      method: "POST",
      headers: { "content-type": "application/proto" },
      body: Buffer.alloc(0),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/proto");
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  });

  it("keeps the events channel open", async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/byok/events`, { signal: controller.signal });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    controller.abort();
  });
});

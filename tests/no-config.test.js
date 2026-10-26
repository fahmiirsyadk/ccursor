/**
 * A turn with no providers.json.
 *
 * The point of this file: adding a model in Cursor's own settings is enough. The
 * server must take the endpoint and the key from the turn itself, and answer
 * AvailableModels from what Cursor has stored.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";

import { discover } from "../src/locate.js";
import { loadRoot } from "../src/proto/schema.js";
import { FrameReader } from "../src/proto/connect.js";
import { USER_STATE_KEY } from "../src/paths.js";
import { bidiAppendBody, stream, unary } from "./helpers/rpc.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-byok-noconfig-"));
const savedEnv = { ...process.env };

after(() => {
  process.env = { ...savedEnv };
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function workbenchBundle() {
  const found = discover();
  if (!found.appRoot) return null;
  const file = path.join(found.appRoot, "out/vs/workbench/workbench.desktop.main.js");
  return fs.existsSync(file) ? file : null;
}

const WORKBENCH = workbenchBundle();
const skip = WORKBENCH ? false : "no Cursor install on this machine";

/** A provider that records what it was asked and answers with one text turn. */
function startStub() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (piece) => (body += piece));
    req.on("end", () => {
      server.requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  server.requests = [];
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

describe("a turn with no providers.json", { skip }, () => {
  let stub;
  let instance;
  let root;
  let base;

  before(async () => {
    root = loadRoot({ workbench: WORKBENCH });
    stub = await startStub();

    const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
    const state = fs.mkdtempSync(path.join(tmpRoot, "state-"));
    fs.mkdirSync(path.join(home, ".config/Cursor/User/globalStorage"), { recursive: true });

    // Cursor's own settings: one model, added through its UI. No providers.json.
    const db = new DatabaseSync(
      path.join(home, ".config/Cursor/User/globalStorage/state.vscdb"),
    );
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      USER_STATE_KEY,
      JSON.stringify({
        availableAPIKeyModels: [{ name: "from-cursor-ui", clientDisplayName: "From Cursor UI" }],
        openAIBaseUrl: "https://ignored.example/v1",
      }),
    );
    db.close();

    process.env.HOME = home;
    process.env.CURSOR_BYOK_STATE = state;

    const { createServer } = await import("../src/server.js");
    instance = createServer({ workbench: WORKBENCH, port: 0 });
    const address = await instance.listen();
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await instance?.close();
    if (stub) await new Promise((resolve) => stub.close(resolve));
  });

  it("serves the model list Cursor stored", async () => {
    const response = await unary(base, "aiserver.v1.AiService/AvailableModels", Buffer.alloc(0));
    assert.equal(response.status, 200);

    const bytes = Buffer.from(await response.arrayBuffer());
    const Models = root.lookupType("aiserver.v1.AvailableModelsResponse");
    const decoded = Models.decode(bytes);

    assert.ok(decoded.model_names.includes("from-cursor-ui"), "the model Cursor added is offered");
  });

  it("takes the endpoint and key from the turn, and calls the provider", async () => {
    const requestId = "no-config-turn";
    const port = stub.address().port;

    const appended = await unary(
      base,
      "aiserver.v1.BidiService/BidiAppend",
      bidiAppendBody(root, requestId, {
        run_request: {
          conversation_id: "conv",
          requested_model: {
            model_id: "from-cursor-ui",
            api_key_credentials: {
              api_key: "sk-from-cursor",
              base_url: `http://127.0.0.1:${port}/v1`,
            },
          },
          action: { user_message_action: { user_message: { text: "hi" } } },
          conversation_state: { mode: 1 },
        },
      }),
    );
    assert.equal(appended.status, 200);

    const Id = root.lookupType("aiserver.v1.BidiRequestId");
    const response = await stream(
      base,
      "agent.v1.AgentService/RunSSE",
      Id.encode(Id.fromObject({ request_id: requestId })).finish(),
    );
    assert.equal(response.status, 200);

    const Server = root.lookupType("agent.v1.AgentServerMessage");
    const reader = new FrameReader();
    let text = "";

    for await (const chunk of response.body) {
      for (const item of reader.push(Buffer.from(chunk))) {
        if (item.flags & 2) continue;
        const message = Server.decode(item.payload);
        const delta = message.interaction_update?.text_delta?.text;
        if (delta) text += delta;
      }
    }

    assert.equal(text, "ok");
    assert.equal(stub.requests.length, 1, "the provider was called once");
    assert.equal(stub.requests[0].auth, "Bearer sk-from-cursor", "the key from the turn was used");
    assert.equal(stub.requests[0].url, "/v1/chat/completions");
    assert.equal(stub.requests[0].body.model, "from-cursor-ui");
  });
});

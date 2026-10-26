/**
 * The agent path: run request in, streamed answer out.
 *
 * These tests stand up the real server, point providers.json at a stub endpoint, and
 * drive it the way Cursor does — a BidiAppend carrying the run request, then a
 * RunSSE that consumes framed messages. Nothing here touches a real provider.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { discover } from "../src/locate.js";
import { loadRoot } from "../src/proto/schema.js";
import { FrameReader } from "../src/proto/connect.js";
import { readStream, stream, unary } from "./helpers/rpc.js";
import { clearBlobs, getBlob, makeBlob, readBlobJson } from "../src/agent/blobs.js";
import { clearSessions, closeSession, deliver, next, openSession, sessionCount } from "../src/agent/session.js";
import { conversation, modelId, userText } from "../src/agent/request.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-byok-agent-"));
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

const bundle = extensionJs();
const skip = bundle ? false : "no Cursor install with the BYOK extension on this machine";

describe("blob store", () => {
  it("round-trips a value through the content address", () => {
    process.env.CURSOR_BYOK_STATE = path.join(tmpRoot, "state");
    clearBlobs();

    const blob = makeBlob({ role: "user", content: "hello" });
    assert.deepEqual(readBlobJson(blob.id), { role: "user", content: "hello" });
    assert.equal(getBlob("not-a-real-id"), null);
  });

  it("survives a process restart by falling back to disk", () => {
    process.env.CURSOR_BYOK_STATE = path.join(tmpRoot, "state");
    const blob = makeBlob({ role: "user", content: "persisted" });

    clearBlobs(); // drop the in-memory copy only

    assert.deepEqual(readBlobJson(blob.id), { role: "user", content: "persisted" });
  });
});

describe("run sessions", () => {
  it("hands a message to a waiter that arrived first", async () => {
    clearSessions();
    openSession("r1");

    const waiting = next("r1");
    deliver("r1", { run_request: { conversation_id: "c1" } });

    const message = await waiting;
    assert.equal(message.run_request.conversation_id, "c1");
  });

  it("queues a message when nobody is waiting yet", async () => {
    clearSessions();
    deliver("r2", { a: 1 });

    assert.deepEqual(await next("r2"), { a: 1 });
    assert.equal(sessionCount(), 1);
  });

  it("releases waiters when the session closes", async () => {
    clearSessions();
    openSession("r3");

    const waiting = next("r3");
    closeSession("r3");

    assert.equal(await waiting, null);
  });

  it("times out rather than hanging forever", async () => {
    clearSessions();
    openSession("r4");

    assert.equal(await next("r4", 20), null);
  });
});

describe("run request parsing", () => {
  it("reads the user's text", () => {
    assert.equal(
      userText({ action: { user_message_action: { user_message: { text: "hi" } } } }),
      "hi",
    );
  });

  it("falls back to the queued text when the run request has none", () => {
    assert.equal(userText({ action: { resume_action: {} } }, "queued"), "queued");
  });

  it("prefers requested_model over model_details", () => {
    assert.equal(
      modelId({ requested_model: { model_id: "a" }, model_details: { model_name: "b" } }),
      "a",
    );
  });

  it("converts protobuf history into provider messages", () => {
    const runRequest = {
      action: {
        user_message_action: {
          user_message: { text: "second" },
          conversation_history: {
            messages: [
              { user: { content: [{ text: { text: "first" } }] } },
              { assistant: { content: [{ text: { text: "answer" } }] } },
            ],
          },
        },
      },
    };

    assert.deepEqual(conversation(runRequest), [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" },
    ]);
  });

  it("converts assistant tool calls into blocks", () => {
    const runRequest = {
      action: {
        user_message_action: {
          conversation_history: {
            messages: [
              {
                assistant: {
                  content: [
                    { text: { text: "checking" } },
                    { tool_call: { tool_call_id: "c1", tool_name: "Read", args_json: '{"path":"a"}' } },
                  ],
                },
              },
              { tool: { tool_call_id: "c1", tool_name: "Read", content: [{ text: { text: "body" } }] } },
            ],
          },
        },
      },
    };

    const messages = conversation(runRequest);
    assert.equal(messages[0].role, "assistant");
    assert.ok(Array.isArray(messages[0].content));
    assert.deepEqual(messages[0].content[1], {
      type: "tool_use",
      id: "c1",
      name: "Read",
      input: { path: "a" },
    });
    assert.equal(messages[1].role, "tool");
    assert.equal(messages[1].content, "body");
  });

  it("reads history stored as blobs", () => {
    process.env.CURSOR_BYOK_STATE = path.join(tmpRoot, "state");
    const blob = makeBlob({ role: "user", content: "from a blob" });

    const runRequest = {
      conversation_state: {
        root_prompt_messages_json: [Buffer.from(blob.id, "utf8")],
      },
    };

    assert.deepEqual(conversation(runRequest), [{ role: "user", content: "from a blob" }]);
  });

  it("does not add the user message twice", () => {
    const runRequest = {
      action: {
        user_message_action: {
          user_message: { text: "same" },
          conversation_history: { messages: [{ user: { content: [{ text: { text: "same" } }] } }] },
        },
      },
    };

    assert.equal(conversation(runRequest).length, 1);
  });
});

// ---------------------------------------------------------------- end to end

/** A provider that streams a fixed answer, so the test never hits the network. */
function startStubProvider(chunks) {
  const server = http.createServer((req, res) => {
    if (!req.url.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }

    let body = "";
    req.on("data", (piece) => (body += piece));
    req.on("end", () => {
      const request = JSON.parse(body);
      server.lastRequest = request;

      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function textChunk(text) {
  return {
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

function doneChunk() {
  return {
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 3 },
  };
}

/** Encode a client message the way Cursor does. */
function encodeRun(root, runRequest) {
  const Type = root.lookupType("agent.v1.AgentClientMessage");
  return Buffer.from(Type.encode(Type.fromObject({ run_request: runRequest })).finish());
}

/** Read every frame of a RunSSE response. */
async function readFrames(root, response) {
  const Type = root.lookupType("agent.v1.AgentServerMessage");
  const reader = new FrameReader();
  const frames = [];
  let trailer = null;

  for await (const chunk of response.body) {
    for (const item of reader.push(Buffer.from(chunk))) {
      if (item.flags === 2) {
        trailer = item.payload.toString("utf8");
        continue;
      }
      frames.push(Type.decode(item.payload));
    }
  }

  return { frames, trailer };
}

describe("agent turn", { skip }, () => {
  let stub;
  let instance;
  let root;
  let base;

  before(async () => {
    root = loadRoot(bundle);
    stub = await startStubProvider([textChunk("Hello"), textChunk(" there"), doneChunk()]);

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
            baseUrl: `http://127.0.0.1:${stub.address().port}/v1`,
            auth: { kind: "apiKey", value: "test-key" },
            models: [{ id: "stub/model", apiModel: "stub-model", displayName: "Stub Model" }],
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
    await new Promise((resolve) => stub.close(resolve));
  });

  it("streams the answer back as interaction updates", async () => {
    const append = root.lookupType("aiserver.v1.BidiAppendRequest");
    const appendBody = append.encode(
      append.fromObject({
        request_id: { request_id: "run-1" },
        data_binary: encodeRun(root, {
          conversation_id: "conv-1",
          requested_model: { model_id: "stub/model" },
          action: { user_message_action: { user_message: { text: "hello" } } },
          conversation_state: { mode: 2 },
        }),
      }),
    ).finish();

    const appended = await unary(base, "aiserver.v1.BidiService/BidiAppend", appendBody);
    assert.equal(appended.status, 200);

    const requestId = root.lookupType("aiserver.v1.BidiRequestId");
    const sseBody = requestId.encode(requestId.fromObject({ request_id: "run-1" })).finish();

    const response = await stream(base, "agent.v1.AgentService/RunSSE", sseBody);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/connect+proto");

    const { frames, trailer } = await readFrames(root, response);
    assert.equal(trailer, "{}");

    const text = frames
      .map((frame) => frame.interaction_update?.text_delta?.text)
      .filter(Boolean)
      .join("");
    assert.equal(text, "Hello there");

    const ended = frames.find((frame) => frame.interaction_update?.turn_ended);
    assert.ok(ended, "turn ended");
    assert.equal(Number(ended.interaction_update.turn_ended.output_tokens), 3);

    // The provider received what we think it did.
    assert.equal(stub.lastRequest.model, "stub-model");
    assert.equal(stub.lastRequest.messages.at(-1).content, "hello");
    assert.equal(stub.lastRequest.messages[0].role, "system");
  });

  it("explains itself when the model is not configured", async () => {
    const append = root.lookupType("aiserver.v1.BidiAppendRequest");
    const appendBody = append.encode(
      append.fromObject({
        request_id: { request_id: "run-2" },
        data_binary: encodeRun(root, {
          requested_model: { model_id: "nobody/nothing" },
          action: { user_message_action: { user_message: { text: "hello" } } },
        }),
      }),
    ).finish();

    await unary(base, "aiserver.v1.BidiService/BidiAppend", appendBody);

    const requestId = root.lookupType("aiserver.v1.BidiRequestId");
    const response = await stream(
      base,
      "agent.v1.AgentService/RunSSE",
      requestId.encode(requestId.fromObject({ request_id: "run-2" })).finish(),
    );

    const { frames } = await readFrames(root, response);
    const text = frames
      .map((frame) => frame.interaction_update?.text_delta?.text)
      .filter(Boolean)
      .join("");

    assert.match(text, /No provider is configured/);
  });

  it("accepts uploaded history blobs", async () => {
    const blob = makeBlob({ role: "user", content: "uploaded" });
    const Type = root.lookupType("agent.v1.UploadConversationBlobsRequest");
    const body = Type.encode(
      Type.fromObject({
        conversation_id: "conv-2",
        blobs: [{ id: Buffer.from(blob.id, "utf8"), value: Buffer.from(blob.data, "base64") }],
      }),
    ).finish();

    const response = await unary(base, "agent.v1.AgentService/UploadConversationBlobs", body);

    assert.equal(response.status, 200);
    assert.deepEqual(readBlobJson(blob.id), { role: "user", content: "uploaded" });
  });

  it("answers known RPCs it does not implement with an empty response", async () => {
    // NameAgent exists in Cursor's schema, so it gets a valid empty message
    // rather than an error: the client should not see a failure for a call we
    // simply have nothing to say about.
    const response = await unary(base, "agent.v1.AgentService/NameAgent", Buffer.alloc(0));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/proto");
  });

  it("reports a service that does not exist as unimplemented", async () => {
    const response = await fetch(`${base}/agent.v1.NoSuchService/Nope`, {
      method: "POST",
      body: "",
    });
    const body = await response.json();
    assert.equal(body.code, 12);
  });
});

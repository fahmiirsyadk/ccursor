/**
 * The tool loop.
 *
 * Agent mode is a loop: the model asks for a tool, the editor runs it, the result
 * goes back to the model. This drives that loop end to end with a stub provider and
 * a client that answers exec requests the way Cursor does.
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
import { bidiAppendBody, stream, unary } from "./helpers/rpc.js";
import {
  EXEC_CASES,
  TOOL_TYPES,
  findTool,
  providerTools,
  renderResult,
  toolNames,
} from "../src/agent/tools.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-byok-tools-"));
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

describe("tool catalog", () => {
  it("maps every tool to a Cursor tool type and an exec case", () => {
    for (const tool of providerTools()) {
      assert.ok(TOOL_TYPES[tool.name], `${tool.name} has a tool type`);
      assert.ok(EXEC_CASES[tool.name], `${tool.name} has an exec case`);
    }
  });

  it("resolves the aliases Cursor's Anthropic profile uses", () => {
    assert.equal(findTool("ReadFile")?.name, "Read");
    assert.equal(findTool("rg")?.name, "Grep");
    assert.equal(findTool("Nope"), null);
  });

  it("builds Read arguments", () => {
    const args = findTool("Read").buildArgs({ path: "/a", offset: 2, limit: 10 }, "c1");
    assert.deepEqual(args, { path: "/a", tool_call_id: "c1", offset: 2, limit: 10 });
  });

  it("normalises line endings before a write", () => {
    const args = findTool("Write").buildArgs({ path: "/a", contents: "a\r\nb\rc" }, "c1");
    assert.equal(args.file_text, "a\nb\nc");
    assert.equal(args.stream_content, "a\nb\nc");
    assert.equal(args.encoding_hint, "utf8");
  });

  it("turns a glob into a recursive pattern", () => {
    assert.equal(findTool("Glob").buildArgs({ glob_pattern: "*.ts" }, "c1").pattern, "**/*.ts");
    assert.equal(findTool("Glob").buildArgs({ glob_pattern: "**/*.ts" }, "c1").pattern, "**/*.ts");
  });

  it("renders a read result as its content", () => {
    assert.equal(renderResult("Read", { success: { content: "body" } }), "body");
  });

  it("renders a rejected call so the model stops retrying", () => {
    assert.match(renderResult("Read", { rejected: {} }), /rejected/);
  });

  it("renders a shell failure with the exit code", () => {
    const text = renderResult("Shell", {
      success: { stdout: "out", stderr: "bad", exit_code: 2 },
    });
    assert.match(text, /out/);
    assert.match(text, /bad/);
    assert.match(text, /exit code 2/);
  });

  it("renders glob matches", () => {
    assert.equal(
      renderResult("Glob", { success: { files: ["/a.ts", "/b.ts"] } }),
      "/a.ts\n/b.ts",
    );
  });

  it("renders an empty match set", () => {
    assert.equal(renderResult("Grep", { success: { output_mode: "files_with_matches" } }), "No files matched.");
  });
});

// ---------------------------------------------------------------- the loop

/** A provider that answers with a scripted sequence of chunks per request. */
function startStubProvider(script) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (piece) => (body += piece));
    req.on("end", () => {
      server.requests.push(JSON.parse(body));
      const chunks = script.shift() ?? [];
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  server.requests = [];

  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function toolCallChunks(id, name, args) {
  return [
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id, function: { name, arguments: "" } },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    },
  ];
}

function textChunks(text) {
  return [
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 30, completion_tokens: 4 },
    },
  ];
}

describe("tool loop", { skip }, () => {
  let stub;
  let instance;
  let root;
  let base;

  before(async () => {
    root = loadRoot({ workbench: workbenchBundle(), extension: bundle });
    stub = await startStubProvider([
      toolCallChunks("call-1", "Read", { path: "/tmp/example.txt" }),
      textChunks("The file says hello."),
    ]);

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
            auth: { kind: "apiKey", value: "k" },
            models: [{ id: "stub/model", apiModel: "stub-model" }],
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

  it("asks the editor to run the tool and feeds the result back", async () => {
    const client = root.lookupType("agent.v1.AgentClientMessage");
    const requestId = "tool-run-1";

    const runRequest = {
      conversation_id: "conv-tools",
      requested_model: { model_id: "stub/model" },
      action: { user_message_action: { user_message: { text: "read the file" } } },
      conversation_state: { mode: 1 },
    };

    const appended = await unary(
      base,
      "aiserver.v1.BidiService/BidiAppend",
      bidiAppendBody(root, requestId, { run_request: runRequest }),
    );
    assert.equal(appended.status, 200);

    const idType = root.lookupType("aiserver.v1.BidiRequestId");
    const response = await stream(
      base,
      "agent.v1.AgentService/RunSSE",
      idType.encode(idType.fromObject({ request_id: requestId })).finish(),
    );

    const ServerMessage = root.lookupType("agent.v1.AgentServerMessage");
    const reader = new FrameReader();
    const seen = [];
    let replied = false;

    for await (const chunk of response.body) {
      for (const item of reader.push(Buffer.from(chunk))) {
        if (item.flags === 2) continue;
        const message = ServerMessage.decode(item.payload);
        seen.push(message);

        // Answer the exec request the way the editor would.
        const exec = message.exec_server_message;
        if (exec && !replied) {
          replied = true;
          assert.equal(exec.read_args?.path, "/tmp/example.txt");

          await unary(
            base,
            "aiserver.v1.BidiService/BidiAppend",
            bidiAppendBody(root, requestId, {
              exec_client_message: {
                id: exec.id,
                exec_id: exec.exec_id,
                read_result: {
                  success: { content: "hello", path: "/tmp/example.txt", total_lines: 1 },
                },
              },
            }),
          );
        }
      }
    }

    const kinds = seen.map((message) => Object.keys(message).find((key) => message[key] !== undefined));

    assert.ok(kinds.includes("exec_server_message"), "asked the editor to run the tool");
    assert.ok(
      seen.some((message) => message.interaction_update?.tool_call_started),
      "announced the tool call",
    );
    assert.ok(
      seen.some((message) => message.interaction_update?.tool_call_completed),
      "reported the tool result",
    );

    const completed = seen.find((message) => message.interaction_update?.tool_call_completed);
    const readCall = completed.interaction_update.tool_call_completed.tool_call.read_tool_call;
    assert.equal(readCall.args?.path, "/tmp/example.txt");
    assert.equal(readCall.result?.success?.content, "hello", "the result rides along for the UI");

    const text = seen
      .map((message) => message.interaction_update?.text_delta?.text)
      .filter(Boolean)
      .join("");
    assert.equal(text, "The file says hello.");

    // The second provider request must carry the tool result.
    const second = stub.requests[1];
    const toolMessage = second.messages.find((message) => message.role === "tool");
    assert.ok(toolMessage, "tool result reached the provider");
    assert.equal(toolMessage.content, "hello");
    assert.equal(toolMessage.tool_call_id, "call-1");
    assert.ok(second.tools.some((tool) => tool.function.name === "Read"));
  });
});

describe("tool result mapping", () => {
  it("maps a write result onto the edit result the UI expects", async () => {
    const { toToolResult } = await import("../src/agent/tools.js");
    const mapped = toToolResult("Write", {
      success: { path: "/a", lines_created: 3, file_content_after_write: "body" },
    });

    assert.equal(mapped.success.path, "/a");
    assert.equal(mapped.success.lines_added, 3);
    assert.equal(mapped.success.after_full_file_content, "body");
  });

  it("maps grep file results onto a glob result", async () => {
    const { toToolResult } = await import("../src/agent/tools.js");
    const mapped = toToolResult("Glob", {
      success: { pattern: "**/*.ts", path: "/a", workspace_results: { files: { files: ["/a/x.ts"] } } },
    });

    assert.deepEqual(mapped.success.files, ["/a/x.ts"]);
    assert.equal(mapped.success.total_files, 1);
  });

  it("passes an error through untouched", async () => {
    const { toToolResult } = await import("../src/agent/tools.js");
    assert.deepEqual(toToolResult("Write", { rejected: {} }), { rejected: {} });
  });
});

describe("edit flow", { skip }, () => {
  let stub;
  let instance;
  let root;
  let base;

  before(async () => {
    root = loadRoot({ workbench: workbenchBundle(), extension: bundle });
    stub = await startStubProvider([
      toolCallChunks("edit-1", "Edit", {
        path: "/tmp/edit-me.txt",
        old_string: "beta",
        new_string: "gamma",
      }),
      textChunks("Renamed."),
    ]);

    const home = path.join(tmpRoot, "home-edit");
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
            auth: { kind: "apiKey", value: "k" },
            models: [{ id: "stub/model", apiModel: "stub-model" }],
          },
        ],
      }),
    );

    process.env.HOME = home;
    process.env.CURSOR_BYOK_STATE = path.join(tmpRoot, "state-edit");

    const { createServer } = await import("../src/server.js");
    instance = createServer({ extensionJs: bundle, port: 0 });
    const address = await instance.listen();
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await instance?.close();
    await new Promise((resolve) => stub.close(resolve));
  });

  it("reads the file, computes the replacement, then writes it", async () => {
    const client = root.lookupType("agent.v1.AgentClientMessage");
    const requestId = "edit-run-1";

    await unary(
      base,
      "aiserver.v1.BidiService/BidiAppend",
      bidiAppendBody(root, requestId, {
        run_request: {
          conversation_id: "conv-edit",
          requested_model: { model_id: "stub/model" },
          action: { user_message_action: { user_message: { text: "rename beta" } } },
          conversation_state: { mode: 1 },
        },
      }),
    );

    const idType = root.lookupType("aiserver.v1.BidiRequestId");
    const response = await stream(
      base,
      "agent.v1.AgentService/RunSSE",
      idType.encode(idType.fromObject({ request_id: requestId })).finish(),
    );

    const ServerMessage = root.lookupType("agent.v1.AgentServerMessage");
    const reader = new FrameReader();
    const cases = [];
    let written = null;
    let completed = null;

    for await (const chunk of response.body) {
      for (const item of reader.push(Buffer.from(chunk))) {
        if (item.flags === 2) continue;
        const message = ServerMessage.decode(item.payload);

        if (message.interaction_update?.tool_call_completed) {
          completed = message.interaction_update.tool_call_completed;
        }

        const exec = message.exec_server_message;
        if (!exec) continue;

        if (exec.read_args) {
          cases.push("read");
          await unary(
            base,
            "aiserver.v1.BidiService/BidiAppend",
            bidiAppendBody(root, requestId, {
              exec_client_message: {
                id: exec.id,
                exec_id: exec.exec_id,
                read_result: {
                  success: { path: exec.read_args.path, content: "alpha\nbeta\n", total_lines: 2 },
                },
              },
            }),
          );
        }

        if (exec.write_args) {
          cases.push("write");
          written = exec.write_args.file_text;
          await unary(
            base,
            "aiserver.v1.BidiService/BidiAppend",
            bidiAppendBody(root, requestId, {
              exec_client_message: {
                id: exec.id,
                exec_id: exec.exec_id,
                write_result: {
                  success: { path: exec.write_args.path, lines_created: 2, file_size: 12 },
                },
              },
            }),
          );
        }
      }
    }

    assert.deepEqual(cases, ["read", "write"], "read first, then write");
    assert.equal(written, "alpha\ngamma\n", "the replacement is computed here");

    const edit = completed.tool_call.edit_tool_call;
    assert.equal(edit.args.path, "/tmp/edit-me.txt");
    assert.equal(edit.result.success.after_full_file_content, "alpha\ngamma\n");
    assert.equal(edit.result.success.lines_added, 1);
    assert.equal(edit.result.success.lines_removed, 1);
  });
});

describe("subagents", () => {
  it("marks a run request that is itself a subagent", async () => {
    const { subagentType } = await import("../src/agent/request.js");

    assert.equal(subagentType({ subagent_type_name: "explore" }), "explore");
    assert.equal(subagentType({ subagent_type_name: "Browser-Use" }), "browser_use");
    assert.equal(subagentType({}), "");
    assert.equal(subagentType({ subagent_type_name: "   " }), "");
  });

  it("never offers Task to a subagent", () => {
    // A subagent that is given Task delegates the same work again: one request
    // spawned two subagents doing the same exploration because of this.
    for (const type of ["explore", "debug", "bash", "custom", "whatever"]) {
      const names = toolNames({ subagent: type });
      assert.equal(names.includes("Task"), false, type);
    }
  });

  it("still offers Task to a top-level turn", () => {
    assert.ok(toolNames().includes("Task"));
  });

  it("restricts an explore subagent to reading", () => {
    const names = toolNames({ subagent: "explore" });
    assert.deepEqual(names.sort(), ["Glob", "Grep", "Read"]);
  });

  it("lets a bash subagent change things", () => {
    const names = toolNames({ subagent: "bash" });
    assert.ok(names.includes("Shell"));
    assert.ok(names.includes("Write"));
  });

  it("gives a subagent its own system prompt", async () => {
    const { systemPrompt } = await import("../src/agent/prompt.js");

    assert.match(systemPrompt({}, "explore"), /subagent/i);
    assert.match(systemPrompt({}, "explore"), /cannot delegate/i);
    assert.match(systemPrompt({}, "explore"), /Do not change anything/);
    assert.equal(systemPrompt({}, ""), systemPrompt({}));
  });

  it("still honours a custom prompt inside a subagent", async () => {
    const { systemPrompt } = await import("../src/agent/prompt.js");
    assert.equal(systemPrompt({ custom_system_prompt: "be brief" }, "explore"), "be brief");
  });
});

describe("subagent delegation is refused", { skip }, () => {
  let stub;
  let instance;
  let root;
  let base;

  before(async () => {
    root = loadRoot({ workbench: workbenchBundle(), extension: bundle });

    // The model, running as a subagent, tries to delegate anyway.
    stub = await startStubProvider([
      toolCallChunks("nested-1", "Task", { description: "again", prompt: "explore again" }),
      textChunks("I will do it myself."),
    ]);

    const home = path.join(tmpRoot, "home-nested");
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
            auth: { kind: "apiKey", value: "k" },
            models: [{ id: "stub/model", apiModel: "stub-model" }],
          },
        ],
      }),
    );

    process.env.HOME = home;
    process.env.CURSOR_BYOK_STATE = path.join(tmpRoot, "state-nested");

    const { createServer } = await import("../src/server.js");
    instance = createServer({ extensionJs: bundle, port: 0 });
    const address = await instance.listen();
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await instance?.close();
    await new Promise((resolve) => stub.close(resolve));
  });

  it("does not spawn a nested subagent", async () => {
    const client = root.lookupType("agent.v1.AgentClientMessage");
    const idType = root.lookupType("aiserver.v1.BidiRequestId");
    const requestId = "nested-run-1";

    await unary(
      base,
      "aiserver.v1.BidiService/BidiAppend",
      bidiAppendBody(root, requestId, {
        run_request: {
          conversation_id: "conv-nested",
          requested_model: { model_id: "stub/model" },
          subagent_type_name: "explore",
          action: { user_message_action: { user_message: { text: "map the repo" } } },
          conversation_state: { mode: 1 },
        },
      }),
    );

    const response = await stream(
      base,
      "agent.v1.AgentService/RunSSE",
      idType.encode(idType.fromObject({ request_id: requestId })).finish(),
    );

    const ServerMessage = root.lookupType("agent.v1.AgentServerMessage");
    const reader = new FrameReader();
    const execCases = [];

    for await (const chunk of response.body) {
      for (const item of reader.push(Buffer.from(chunk))) {
        if (item.flags & 2) continue;
        const message = ServerMessage.decode(item.payload);
        const exec = message.exec_server_message;
        if (!exec) continue;
        const caseName = Object.keys(exec).find((key) => key !== "id" && key !== "exec_id" && exec[key]);
        execCases.push(caseName);
      }
    }

    assert.equal(execCases.includes("subagent_args"), false, "no nested subagent was spawned");

    // The provider was told, so the next round can recover instead of retrying.
    const second = stub.requests[1];
    const toolMessage = second.messages.find((message) => message.role === "tool");
    assert.match(toolMessage.content, /already a subagent/);

    // And Task was never offered in the first place.
    assert.equal(
      second.tools?.some((tool) => tool.function.name === "Task") ?? false,
      false,
      "Task is not in the subagent's tool list",
    );
  });
});

# Architecture

How a message travels from the composer to your endpoint, and how tool calls come
back. Everything here is traced from a working install on Cursor 3.27.12; the log
lines are real excerpts.

---

## The three processes

```
┌─────────────────────────────────────────────────────────────────┐
│ Cursor (Electron)                                               │
│                                                                 │
│  renderer            agent host              extension host     │
│  ────────            ──────────              ──────────────     │
│  composer UI   →     RunSSE / BidiAppend  →  cursor2plus        │
│  model picker        (HTTP/1.1 transport)    Fastify :39831     │
│                                              cursor-always-local│
└─────────────────────────────────────────────────────────────────┘
                                                    │
                                                    ↓
                                          your endpoint
                                       (openai-chat / anthropic)
```

Two things make this work: the **router** inside the extension hosts, and the
**server** in the `cursor2plus` extension. This tool installs both, then keeps them
alive across Cursor updates.

---

## Startup: `cursor-byok run`

```
cursor-byok run
  │
  ├─ 1. marker check
  │     applied.json records bundle mtimes at last successful patch.
  │     mtime differs  →  Cursor updated  →  re-apply before continuing.
  │
  ├─ 2. seed the catalog            (Cursor must be closed)
  │     state.vscdb ← availableDefaultModels2   from providers.json
  │                  userAddedModels
  │                  aiSettings.modelConfig.*   pinned to the primary model
  │     Why: the renderer asks for models immediately on boot. Without a seed it
  │     can reach Cursor's backend before the extension binds, and persists
  │     Cursor's own 46-model list. See failure 5 in how-it-works.md.
  │
  └─ 3. spawn Cursor, detached
        │
        └─ Cursor boots
             ├─ renderer reads the seeded catalog  → your model in the picker
             ├─ extension binds 127.0.0.1:39831
             └─ routers load routes.json
```

Verified ordering problem this solves:

```text
14:32:00  Cursor process starts
14:32:08  BYOK extension binds 127.0.0.1:39831      <- 8 second window
```

---

## Runtime: one agent turn

```
composer (renderer)
  │  user message + model id
  ↓
agent host extension
  │  https.request("https://api2.cursor.sh/agent.v1.AgentService/RunSSE")
  ↓
ROUTER  (cursor-agent-host/dist/main.js, injected)
  │  host matches api*.cursor.sh  AND  path is in routes.json redirect set
  │  → rewrite to http://127.0.0.1:39831/agent.v1.AgentService/RunSSE
  ↓
cursor2plus server  (:39831)
  │  1. resolve model id  →  providers.json  →  apiModel
  │  2. build provider request: system prompt, tools, conversation
  │  3. POST https://your-endpoint/v1/chat/completions   (stream)
  ↓
your endpoint
  │  SSE deltas
  ↓
cursor2plus server
  │  map provider events → Cursor event frames
  ↓
agent host  →  renderer  →  UI
```

The router is what makes BYOK possible. It replaces `http.request`/`https.request`
in the extension host, so anything Cursor sends to its own backend can be diverted:

```js
// cursor-agent-host/dist/main.js
function interceptRequest(isHttps) {
  return function (input, options, callback) {
    const parsed = parseRequest(input);
    if (parsed && ((isCursorApiHost(parsed.hostname) && shouldRedirect(parsed.path))
        || isConfiguredLocal(parsed))) return directRequest(parsed, options, callback);
    ...
```

`isCursorApiHost` matches `api2/3/4/5.cursor.sh`, `gcpp.cursor.sh`,
`api.playground.cursor.sh`. `shouldRedirect` consults `routes.json`, which lists
both service-level and method-level rules:

```json
"aiserver.v1.AiService/AvailableModels",
"agent.v1.AgentService/RunSSE",
"aiserver.v1.BidiService/BidiAppend",
"aiserver.v1.DashboardService/GetPlanInfo",
```

That is why the transport must be HTTP/1.1. Cursor's factory picks HTTP/2 when
`cursor.general.disableHttp2` is false, and `node:http2` never touches
`http.request` — the router is bypassed entirely. See failure 1.

### What the two calls carry

`RunSSE` is a server-streaming call: the request goes up, the turn streams down.

`BidiAppend` is a bidirectional stream that carries the actual payload and the
conversation state. From a real turn:

```text
[SVC] BidiAppend {"requestId":"468feb5f-...","dataLen":133622,"seqno":0}
[SESSION] appendMessage {"keys":["runRequest"],"protoBytes":66811}
[SVC] RunSSE first message {"keys":["runRequest"]}
```

66 KB of protobuf on the first frame — the run request, including the pushed request
context (rules, subagents, tracked state, codebase references). Later frames are
small: `clientHeartbeat` (2 bytes) and `kvClientMessage` (4-6 bytes).

---

## The tool loop

Agent mode is not one request. It is a loop, driven by the server:

```
round 0
  │  build prompt:  system + tool catalog + user message
  │  → provider
  │
  ├─ model returns stop_reason = tool_use
  │    tool_use: name + JSON args
  │
  ├─ adapter maps the name to a Cursor tool type
  │    Write          → editToolCall / writeArgs
  │    Edit           → editToolCall / stringReplace
  │    Read           → readToolCall
  │    Shell          → shellToolCall
  │    Glob / Grep    → globToolCall / grepToolCall
  │
  ├─ Cursor executes the tool natively
  │    (the adapter does not reimplement file IO or shell execution)
  │
  ├─ tool result appended as a `tool_results` turn
  │
round 1
  │  build prompt: system + tools + conversation + tool_results
  │  → provider  ...
  │
  └─ model returns stop_reason = end_turn
       no tool calls → stream the answer → done
```

Real trace from a porting task:

```text
[AGENT] built prompt {"promptProvider":"openai-chat","promptStyle":"openai-main"}
[AGENT] → [openai-chat/deepseek/deepseek-v4.1-flash-1017] "port to Node.js" (3 msgs)
[LLM] stream done (0t/0c in 17840ms, stop=tool_use)
[AGENT] tool results pending provider-state flush {"round":0,"toolResults":[...]}
[AGENT] continuing LLM with tool results {"round":1,"messages":7}
[LLM] stream done (0t/0c in 12031ms, stop=tool_use)
[AGENT] continuing LLM with tool results {"round":2,"messages":10}
...
[LLM] stream done (0t/2308c in 16239ms, stop=end_turn)
```

`messages` grows by the number of turns each round adds. The loop ends when the
model stops asking for tools — not when the server decides.

### What tools the model sees

The adapter assembles the catalog per round:

```text
[DYNAMIC-TOOLS] builtin profile resolved {"profile":"final","cursorDynamicToolCount":11,...}
[AGENT] prepared provider conversation {"builtinsCount":22,"runtimeToolsCount":9,"mcpToolsCount":...}
[DYNAMIC-TOOLS] MCP mode resolved {"mcpMode":"dynamic_namespace",
  "namespaces":[{"name":"cursor-origin","tools":33},{"name":"cursor-ide-browser","tools":16}]}
```

So a turn can offer ~22 built-in Cursor tools, plus runtime tools, plus MCP tools
exposed through namespaces. That is a lot of surface, and it is why long agent runs
degrade: the model has many plausible next actions and no built-in stopping point.

Tool names as they reach the model are provider-agnostic (`Write`, `Read`, `Shell`,
`Glob`, `Grep`, `Task`, `AwaitShell`, `ListMcpResources`, ...). Cursor stores the
result under its own internal name, which is what you see in the transcript:

```text
run_terminal_command_v2 · read_file_v2 · glob_file_search · edit_file_v2
```

### Why tool results are not validated

`Write` maps to `editToolCall` with `writeArgs`, and the contents are forwarded
verbatim:

```js
buildExecArgs: (t, e) => {
  const path = Xe(t.path);
  const text = gEe(typeof t.contents === "string" ? t.contents : "");
  return { path, fileText: text, streamContent: text, encodingHint: "utf8", toolCallId: e };
}
```

There is no shape check, so a model that batches two files into one `contents` field
writes both to the same path and the call still reports `completed`. That failure
mode, and the measurements that rule out the transport as its cause, are in
[tool-calling.md](tool-calling.md).

---

## Where the schema comes from

Cursor's protobuf schemas are embedded in its own bundle as base64
`FileDescriptorProto` blobs. They are read from the installed app at runtime and
turned into a `protobufjs` root, so encoding and decoding use a maintained library
and the schema always matches the Cursor version on disk.

```
extensions/cursor2plus/dist/extension.js
  └─ 10 FileDescriptorProto blobs
       ├─ agent.v1        1057 top-level messages, 9 services
       ├─ aiserver.v1     4133 top-level messages, 65 services
       ├─ anyrun.v1, internapi.v1
       └─ google.protobuf timestamp, duration, any, struct · google.rpc status
```

`node tools/extract-schema.js --message AgentRunRequest` prints any message.

## Where the model catalog comes from

Two independent sources, and they can disagree:

| Source | Served by | When |
|---|---|---|
| `AvailableModels` RPC | `cursor2plus`, built from `providers.json` | Every picker refresh |
| `availableDefaultModels2` in `state.vscdb` | Cursor's own persistence | First render after boot |

The RPC is authoritative at runtime; the database row decides what the *first*
render shows. Seeding writes the row; `alias` covers the case where a stale row
makes Cursor send Auto.

---

## What stays on Cursor's servers

Not everything is diverted. From `routes.json`, the redirect set covers model
listing, the agent loop, conversation summaries, knowledge base, plan/usage stubs and
auth. Everything else still goes to Cursor: telemetry, SCM and PR lookups,
marketplace, feature gates, updater, tab completion, cloud agents.

That is why Tab and Cloud Agents keep working on Cursor's own models — and why they
are not billed to your key.

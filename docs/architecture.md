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
│  composer UI   →     RunSSE / BidiAppend  →  cursor-byok server │
│  model picker        (HTTP/1.1 transport)    :39831             │
│                                              cursor-always-local│
└─────────────────────────────────────────────────────────────────┘
                                                    │
                                                    ↓
                                          your endpoint
                                       (openai-chat / anthropic)
```

Two things make this work: the **router** prepended to Cursor's own extension hosts,
and the **server** this repository runs on `127.0.0.1:39831`. The router rewrites a
matching call to that port, so the server has to be listening before Cursor starts —
which is why `cursor-byok run` starts it first.

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
  │     can reach Cursor's backend before the router starts diverting, and persists
  │     Cursor's own 46-model list. See failure 5 in how-it-works.md.
  │
  └─ 3. spawn Cursor, detached
        │
        └─ Cursor boots
             ├─ renderer reads the seeded catalog  → your model in the picker
             ├─ router loads routes.json
             └─ turns go to 127.0.0.1:39831
```

Verified ordering problem this solves:

```text
14:32:00  Cursor process starts
14:32:08  router starts diverting                  <- server must already be up
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
cursor-byok server  (:39831)
  │  1. resolve model id  →  providers.json  →  apiModel
  │  2. build the system message: user_info, then Cursor's prompt,
  │     then the instructions the request carried
  │  3. POST https://your-endpoint/v1/chat/completions   (stream)
  ↓
your endpoint
  │  SSE deltas
  ↓
cursor-byok server
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

One mapping is not one-to-one. Cursor has a `globToolCall` in its tool-call
vocabulary but **no glob exec**: a Glob runs as a Grep whose `pattern` is empty and
whose `glob` is the filter, asking only for file names. Putting the glob in `pattern`
makes ripgrep parse `**/*.md` as a regular expression, which fails. ripgrep also
refuses an empty pattern, so the call is retried once with `pattern: "."` — the same
fallback Cursor's own implementation uses.

Real log excerpt from one turn in this repository:

```text
[>] RunSSE 3f9a1c22 started
    workspace: /home/void/dev/ccursor
    system message: 8499 chars (user_info 185, Cursor prompt 8312, request 2)
    tool Glob [main] {"glob_pattern":"*.md","target_directory":"/home/void/dev/ccursor"}
    BidiAppend 3f9a1c22 seq=1 exec_client_message
    turn done: Glob, 402 chars, 3482in/169out
```

Three things are worth reading off it. `system message` splits the prompt into its
three parts, so a request that carries `AGENTS.md` shows up as a large `request`
number instead of being invisible. `tool Glob` is the call the UI renders; the exec
arguments underneath it are different, which is the paragraph above. `turn done`
reports the tools used, the answer size and the token counts.

`messages` grows by the number of turns each round adds. The loop ends when the
model stops asking for tools — not when the server decides.

### What tools the model sees

The catalog is small and fixed. `src/agent/tools.js` is the only place it is
defined; the loop reads it per round, so adding a tool is one entry:

```text
Read  Write  Edit  Delete  Shell  Grep  Glob  Task
```

That is deliberately much smaller than what Cursor offers its own models. Cursor's
own agent gets a dynamic catalog — built-ins plus runtime tools plus MCP servers
exposed through namespaces, around twenty-two entries and growing. Reproducing that
means reproducing its ranking and its budget, which is where long agent runs go
wrong. Eight tools with short descriptions give the model fewer plausible next
actions and a clearer stopping point.

The names are provider-agnostic; Cursor stores each result under its own internal
name, which is what you see in the transcript:

```text
run_terminal_command_v2 · read_file_v2 · glob_file_search · edit_file_v2
```

A subagent gets a subset. `explore` is read-only (`Read`, `Grep`, `Glob`), while
`debug` and `bash` also get write and shell access. `Task` is never offered to a
subagent, so it cannot re-delegate the same work one level deeper.

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

Two sources exist, and they are not equally good:

| Source | What it is |
|---|---|
| `out/vs/workbench/workbench.desktop.main.js` | the client's own generated code: 9546 messages, 1024 enums, 88 services, 2791 methods |
So the client is the only source. Its schema is not protobuf descriptors, though —
it is protobuf-es generated code:

```js
X=makeMessageType("agent.v1.AgentRunRequest",()=>[{no:1,name:"conversation_state",kind:"message",T:Qbd}])
X=makeEnum("agent.v1.AgentMode",[{no:0,name:"AGENT_MODE_UNSPECIFIED"}])
X={typeName:"agent.v1.AgentService",methods:{runSSE:{name:"RunSSE",I:Vbd,O:Zbd,kind:se.ServerStreaming}}}
```

`src/proto/client-schema.js` parses those literals into a protobufjs JSON tree. It
reads the descriptors rather than evaluating the bundle: running minified
third-party code to learn a schema is a poor trade, and the shapes are regular
enough to scan.

`apply` does this once and writes the result to `~/.cursor-byok-patch/schema/`, so
the server starts in milliseconds. When the workbench bundle is newer than the
cache, the bundle wins.

`node tools/extract-schema.js --message AgentRunRequest` prints any message.

## Where the prompt comes from

The prompt is Cursor's, and it is read from Cursor's own install — not written here,
and not fetched from Cursor's backend.

Cursor's bundled `cursor-agent-exec` extension (publisher `anysphere`) builds the
agent prompt as an element tree:

```js
Kz("section", { title: "general", children: [...] })
```

`src/prompt/bundle.js` evaluates the region that declares those sections, once per
process, and `src/prompt/render.js` turns the tree into text using the same rules as
the renderer beside it. Unknown names resolve to inert stubs, so a helper the region
does not need cannot fail the whole prompt.

Two pieces, both Cursor's:

| Piece | Source | When |
|---|---|---|
| `user_info` | `Z8`, built from the request's `request_context.env` | every turn |
| the agent prompt | `n5`, the general builder | cached by `apply` in `~/.cursor-byok-patch/prompt.txt` |

`user_info` is per turn because everything in it changes per turn:

```text
<user_info>
OS Version: linux 6.8.0
Shell: /bin/bash
Workspace Path: /home/user/repo
Is directory a git repo: Yes, at /home/user/repo
Today's date: 2026-10-26
</user_info>
```

Without it the model has no idea where the repository is. It guesses an absolute
path, and a `Task` call then hands that guess to a subagent, which searches a
directory that does not exist. The block is prepended, in Cursor's own order:
`user_info`, then the prompt, then whatever the request carries (custom
instructions, `AGENTS.md`, rules, a subagent reminder).

`apply` writes the cached prompt; `node tools/extract-prompt.js --print` shows it.

## Where the models come from

Two sources, and the file is the optional one:

| Source | What it gives | When |
|---|---|---|
| Cursor's own model settings | model list, base URL, and the key attached to each turn | whenever `providers.json` does not name that model |
| `providers.json` | an explicit catalog, and an `apiModel` that can differ from the id | when the file lists the model |

Cursor's side is read from its state database, which is plain JSON:

```text
availableAPIKeyModels     what Cursor fetched from the provider after you added a model
availableDefaultModels2   the catalog the picker renders on boot
openAIBaseUrl             the base URL you typed in the settings
```

The key is the one thing not readable there: Cursor stores it encrypted, under
`secret://cursorAuth/openAIKey`. So it comes from the turn instead, where the client
attaches it as `requested_model.api_key_credentials` — the same field that carries
the base URL. When a build does not attach it, a single line in
`~/.cursor-byok-patch/apiKey` stands in.

The precedence is deliberate: a model named in `providers.json` wins, because that
file is an explicit choice and the only way to express an upstream name that differs
from the id. Everything else falls through to Cursor's settings.

`cursor-byok status` prints which source is live:

```text
  models              : 2 (providers.json)
```

## What the local server answers
## What the local server answers

`routes.json` decides what is diverted. Everything in that list is answered here —
nothing is proxied to Cursor:

| Group | Answered with |
|---|---|
| `AvailableModels` | your catalog from `providers.json` |
| `RunSSE`, `BidiAppend` | the agent loop, streaming from your endpoint |
| `UploadConversationBlobs` | a local blob store, so history survives turns |
| `ServerTime`, `GetDefaultModel` | the real clock, your configured model |
| `GetPlanInfo`, usage panels | a plan with nothing to pay for and nothing to upgrade |
| `AnalyticsService/Batch` | accepted and dropped |
| auth endpoints | a local session |
| everything else in the schema | a well-formed empty response of the declared type |
| RPCs newer than our schema | an empty message, recorded in `/byok/debug` |
| telemetry hosts | `204`, and nothing leaves the machine |

The last row is what keeps the IDE quiet. An empty message is something the client
already knows how to render; an error is a red toast. A service that does not exist
in Cursor's own schema still returns a Connect `unimplemented` error, so a typo is
visible rather than silently empty.

## How the router decides

Two different questions, matched on two different things.

**Is this an RPC we answer?** Matched on the **path**. The path is the part of the
contract the client cannot vary — it is the RPC it is calling. Hostnames change
between Cursor releases and between services; method names do not. The list is
derived from Cursor's own schema, so a method added in a release is diverted without
a code change.

**Is this a report we can drop?** Matched on the **host**. Error tracking,
feature-flag assignment and Microsoft's inherited VS Code telemetry carry no answer
the UI renders, so they are answered locally with `204` and never reach the network.
Marketplace and update hosts are deliberately absent: blocking those would break
extension installs and updates.

Everything else — SCM and PR lookups, the marketplace, the updater, tab completion,
cloud agents — still goes to Cursor, because the router only rewrites what it was
told to rewrite. Those features keep working, and they are not billed to your key.

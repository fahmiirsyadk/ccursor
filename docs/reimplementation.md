# Reimplementation plan

Replacing `@cometix/ccursor` with our own code. This document records why, what has
been proven, and what remains.

## Why replace it

The upstream package is an installer plus a 17 MB VSIX containing:

- `extension.js`, 4.4 MB minified
- eight native `.node` binaries, ~4.6 MB each for the platforms it supports

The extension receives your API key and your source code. Minified JavaScript and
compiled binaries cannot be reviewed, and the npm tarball is re-fetched on every
`npx` run. That is an unacceptable trust surface for something that sits on the path
to your provider credentials.

It also patches Cursor's extension-signature check globally — `if(!m.valid)` becomes
`if(!1)` — which disables integrity verification for ten of Cursor's own built-in
extensions, of which we modify one.

## What has been proven

The blocker was always thought to be the protobuf schemas for Cursor's internal
agent API. It turns out they are recoverable:

**The schema is embedded as a base64 `FileDescriptorProto`** inside `extension.js`:

```
... bG9jYWwgUmVzcG9uc2ViBnByb3RvMw",[sb,IR,nm]);var ob=Fe(qe,12)
```

Decoding it yields a standard descriptor: `agent_v1.proto`, package `agent.v1`,
**1119 messages**, 9 services. That is interface data — names, field numbers, types —
the same structure `protoc --decode` consumes. `tools/extract-schema.js` parses it.

So the schema is read **at runtime from the installed Cursor**, not redistributed.
It stays correct across Cursor updates automatically, and no third-party artifact
enters the repository.

The two messages that matter:

```
AgentClientMessage  (1) run_request -> AgentRunRequest
AgentRunRequest     (1) conversation_state, (2) action, (3) model_details,
                    (5) conversation_id, (8) custom_system_prompt, ...
AgentServerMessage  (1) interaction_update, (2) exec_server_message,
                    (3) conversation_checkpoint_update, (4) kv_server_message
InteractionUpdate   (1) text_delta, (2) tool_call_started, (3) tool_call_completed,
                    (4) thinking_delta, (8) token_delta, (15) tool_call_delta
```

That is a complete streaming surface: text, thinking, and the full tool-call
lifecycle.

## What is built

| Piece | Status |
|---|---|
| `src/proto/codec.js` — protobuf wire codec | done, 11 tests |
| `src/proto/descriptor.js` — descriptor parser | done, reads the live app |
| `tools/extract-schema.js` — schema dumper | done |
| Schema extraction from a real install | verified: 1119 messages |

The codec is written from the wire-format specification, not generated, and its
tests assert hand-built byte sequences rather than only round-tripping against
itself.

## What remains

| Piece | Est. | Notes |
|---|---|---|
| HTTP/1.1 router | ~250 lines | Hook `http.request`/`https.request`, match host + path, rewrite. The behaviour is fully observable in the current setup. |
| ConnectRPC framing | ~200 lines | Connect protocol: 5-byte prefix (flags + length), plus unary and server-stream. Small and well specified. |
| HTTP server | ~250 lines | Replace Fastify with `node:http`. |
| Request mapping | ~400 lines | `AgentRunRequest` → provider messages. `conversation_state.root_prompt_messages_json` is JSON blobs, which is easier than nested protobuf. |
| Provider adapters | ~600 lines | `openai-chat` first; `anthropic` and `gemini` later. |
| Tool mapping | ~250 lines | Provider tool names ↔ Cursor `interaction_update` tool frames. |
| Session state | ~200 lines | `BidiAppend` queue, heartbeats, `RunSSE` attach. |

Roughly 2000–2500 lines. All of it readable, none of it binary.

## Order of work

1. **Router + server skeleton, `AvailableModels` only.** Proves the transport and the
   ConnectRPC framing with the smallest possible surface: the model picker works
   without any protobuf at all.
2. **`RunSSE` + `BidiAppend` with `text_delta` only.** Chat mode. No tools.
3. **Tool calls.** `tool_call_started` / `tool_call_delta` / `tool_call_completed`,
   and relaying Cursor's own tool execution results back.
4. **Second provider.** Anthropic, to prove the adapter boundary is real.

Steps 1 and 2 deliver a working chat experience. Step 3 is what makes it an agent.

## Keeping Cursor's signature check honest

Until the reimplementation lands, the installer's global bypass can at least be
narrowed to the one extension we patch:

```js
// instead of: if(!1)
if(!m.valid && o !== "anysphere.cursor-always-local")
```

`i_e` lists ten built-in extensions whose hashes Cursor verifies; we modify exactly
one of them.

## Decision point

The reimplementation is worth doing because it removes an unauditable binary from
the path to your credentials. It is not worth doing if the goal is only to avoid a
`npm install`: the effort is in the thousands of lines, and Cursor's internal API can
change without notice.

If the reimplementation is abandoned partway, the working state to fall back to is
the vendored, hash-pinned installer in `src/vendor.js`, with the signature bypass
narrowed as above.

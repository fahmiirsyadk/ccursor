# How it works

Five independent mechanisms break a bring-your-own-key setup in Cursor. They fail
in a specific order, which is why the errors look unrelated.

Findings below come from Cursor 3.27.12 on Linux x86_64.

---

## 1. The agent turn never reaches the local server

**Symptom**

```
Server error
An unexpected error occurred on our servers.
```

or, when the base URL has been forced:

```
[internal] Protocol error
RetriableError: [internal] Protocol error
```

**Evidence**

`renderer.log` records the turn, and the BYOK flag is off even though the key is
configured:

```text
Selected Agent Host turn runtime {"runtime":"connect", ..., "modelId":"..."}
agent.turn.start ... "bring_your_own_key":"false"
```

The transport failure names the real cause:

```text
underlyingConnectError: {"code":13,"codeName":"Internal",
  "cause":{"code":"ERR_HTTP2_ERROR","name":"Error"}}
```

**Cause**

The BYOK router works by replacing `http.request` / `https.request` in the
extension host. Cursor's transport factory chooses its protocol like this:

```js
isHttp2Disabled(){ return workspace.getConfiguration().get("cursor.general.disableHttp2", false) }

agenticComposerTransport: createTransport({ baseUrl: i, useHttp2: !o, ... })  // o = isHttp2Disabled()
```

With HTTP/2 enabled it calls `createHttp2Transport()`, which uses
`node:http2.connect()` with ALPN `h2`. That path never touches `http.request`, so
`agent.v1.AgentService/RunSSE` and `aiserver.v1.BidiService/BidiAppend` bypass the
router and go to `api2.cursor.sh`.

Every other service still looks healthy — `AvailableModels`, `DashboardService`,
`ServerConfigService` — because those use unary HTTP/1.1 and are redirected
correctly. Only the agent loop breaks, which makes the setup look half-working.

**Fix**

```json
{ "cursor.general.disableHttp2": true }
```

The factory falls back to `createHttp1Transport()`, the router sees the request,
and `RunSSE` is forwarded to the local server.

Do not also set `CURSOR_API_BASE_URL`. It rewrites the base URL to a plain HTTP
address while the client still negotiates HTTP/2, which produces the
`ERR_HTTP2_ERROR` above. The router already rewrites URLs itself.

---

## 2. The plan refresh turns the toggle off

**Symptom**

The model vanishes from the picker. Only **Auto** remains. No error, no prompt.

**Evidence**

Persisted state after a refresh:

```text
<useKey> = False
availableDefaultModels2 = 46 entries, none of them yours
userAddedModels = []
```

**Cause**

The AI settings service subscribes to billing changes and clears the toggle when
the plan reads as free:

```js
this.subscriptionChangedListener = (prev, next) => {
  <isNotLocalMode>({ isLocalMode: ... }) && next === FREE && prev !== FREE
    && this.<setKey>(false)
}
```

**Fix**

The guard is replaced with `void 0`, leaving the surrounding comparison intact:

```js
... && next === FREE && prev !== FREE && void 0 }
```

The toggle now stays where the user put it.

---

## 3. Account policy resets the toggle

**Symptom**

Same as above, but it happens again after a restart even with the toggle on.

**Cause**

A settings-application pass resets the key when the account policy reports BYOK as
disabled:

```js
... && <useKey> && (
  log("... action=disable-openai-key byokDisabled=true ..."),
  storage.setApplicationUserPersistentStorage(key, false)
)
```

**Fix**

The whole expression becomes a constant:

```js
... && !1 , useClaudeKey && ...
```

---

## 4. Redirects land on the wrong port

**Symptom**

`status` shows the extension listening on one port and `routes.json` naming
another. Requests reach a closed socket.

**Cause**

A `cursor2plus.server.port` override in `settings.json` takes precedence over the
port the router reads from `routes.json`.

**Fix**

`apply` removes the override and writes `server.port` from a single constant, so
both sides agree.

---

## 5. The first model fetch beats the extension

**Symptom**

The picker shows Cursor's own models — or only **Auto** — even though the BYOK
server is up and `providers.json` is correct. `status` reports everything healthy.
A chat that was already open keeps working with the right model; only new chats
fall back to Auto.

**Evidence**

Startup ordering, from the extension log and process start time:

```text
14:32:00  Cursor process starts
14:32:08  BYOK extension binds 127.0.0.1:39831      <- 8 second gap
```

For those eight seconds the renderer's `AvailableModels` request cannot be
redirected, so it reaches Cursor's backend and returns the full catalog:

```text
catalog         : 46 entries (default, grok-4.7, composer-2.5, ...)
has your model  : False
userAddedModels : []          <- pruned during reconciliation
```

Later requests do return the correct single-model catalog:

```text
[MODEL] availableModels (BYOK only) {"count":1}
```

but the renderer is usually busy by then (an agent loop, a file watcher), and the
corrected catalog is never persisted.

**Fix**

Seed `state.vscdb` **before** launching Cursor, while it is closed:

```bash
cursor-byok run     # seed, then launch
```

`run` writes `availableDefaultModels2`, `aiSettings.userAddedModels`, and the
enabled-model lists from `providers.json`. The first render then already has your
models and there is no race to lose.

The write is refused when Cursor is already running: it holds the state in memory
and rewrites the row on the next persist, so a live seed is overwritten within
seconds. Verified — writing while Cursor runs leaves the catalog unchanged.

---

## 6. Auto is rejected outright

**Symptom**

```
Model default was not found in ~/.cursor/providers.json.
```

**Cause**

Cursor's model id for Auto is the literal string `default`. A composer that starts
on Auto, or any turn where Auto is selected, sends `modelId: "default"` to the BYOK
server. The adapter resolves models by id and throws when the id is absent:

```js
function xN(id) {
  const entry = Lfe(id);
  if (!entry) throw new ModelNotFoundError(id);   // "not found in providers.json"
  return { apiModel: entry.model.apiModel, ... };
}
```

`providers.json` normally lists only real models, so `default` misses.

This becomes visible whenever the persisted catalog reverts to Cursor's own list
(failure 5), because new composers then default to Auto.

**Fix**

Add an alias entry whose `apiModel` points at a real model:

```json
{ "id": "default", "apiModel": "vendor/model-large", "defaultOn": false }
```

`cursor-byok alias` writes it, and the extension hot-reloads within two seconds.
`seed.js` also pins every composer mode to the primary model, so new composers do
not start on Auto in the first place.

The catalog builder skips `default`, so the picker keeps a single Auto entry.

---

## Patch strategy

Both workbench patches are structural rather than exact-string replacements:

1. Anchor on a stable marker (`subscriptionChangedListener=`,
   `action=disable-openai-key`).
2. Search a bounded window for the closing token.
3. Walk back to the nearest `&&`, and bound the span so a wide search cannot
   swallow an unrelated expression.
4. Validate the span — length, no nested calls, expected API name present.
5. Replace, or report `not-found` and write nothing.

A minified bundle has no stable names, so any patch that hard-codes one breaks on
the next point release. Anchoring on structure means a Cursor update either still
matches and patches cleanly, or fails loudly and leaves the file untouched.

`apply` additionally runs `node --check` on every bundle it writes. A patch that
produces invalid JavaScript is rolled back from the pre-write snapshot.

---

## Update detection

`apply` records bundle mtimes in `~/.cursor-byok-patch/applied.json`. Cursor
replaces those files on update, so the mtimes change. `cursor-byok run` compares
recorded against actual before launching and re-applies when they differ. That is
the whole mechanism — no version parsing, no file watching.

---

## What this does not do

- Tab completion, Auto, Cloud Agents, Automations, and the CLI keep using Cursor's
  own models. They are not routed through your key.
- Cursor's built-in models are not unlocked. Selecting one still requires a plan.
- Zero-data-retention guarantees do not apply once your own key is in use.

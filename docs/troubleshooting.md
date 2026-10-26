# Troubleshooting

Start here:

```bash
cursor-byok doctor
```

It checks the install, both guards, the router, the HTTP setting, the port, the
server health, and your provider file. Each failure prints the command that fixes
it.

---

## Model does not appear in the picker

**Only Auto is listed.**

The BYOK toggle is off, or the toggle was cleared after a plan refresh.

1. `cursor-byok status` — check `subscription guard` and `admin policy guard`. Both
   must read `neutralised`. If either says `VULNERABLE`, run `cursor-byok apply`.
2. **Settings → Models → Use API Key** — turn it on. With the guards neutralised it
   now stays on.
3. Restart Cursor if the picker was already open.

**The model is missing from `Add Models`.**

The name must match what your endpoint serves. `AvailableModels` is served by the
local server from `providers.json` in the state directory; if that file is empty or malformed,
the picker has nothing to show. `cursor-byok status` reports the provider count.

---

## "Server error" or "Protocol error" on every agent turn

**Check the transport first.**

```bash
node -e 'const fs=require("fs");const p=process.env.HOME+"/.config/Cursor/User/settings.json";console.log(JSON.parse(fs.readFileSync(p,"utf8"))["cursor.general.disableHttp2"])'
```

Must print `true`. If it prints `undefined` or `false`, run `cursor-byok apply`.

**Then check for a stray base URL override.**

```bash
env | grep CURSOR_API_BASE_URL
```

Unset it. The router rewrites URLs; this variable makes the client speak HTTP/2 to
a plain HTTP server, which yields `ERR_HTTP2_ERROR`.

**Confirm the request actually reached the local server.** Send one message, then
read the server log:

```bash
tail -f ~/.cursor-byok-patch/server.log
```

A working turn prints a `RunSSE ... started` line, then the system message it built,
then `turn done: ...`. If nothing appears, the request never arrived and the
transport is still the problem. `curl -s http://127.0.0.1:39831/byok/debug` shows
request counters, including RPCs the server did not recognise.

---

## Model responds, then loops on tool calls

Not a transport failure. Some models — `deepseek-v4.1-flash` among them — keep
calling tools instead of concluding, and the UI shows "Planning next moves"
repeatedly.

Bound it in the prompt:

> Do the task. At most N tool calls. After that, stop calling tools and write the
> result.

Or put the rule in `AGENTS.md` / `.cursor/rules` so it applies to every session.

---

## Picker shows a model, sending fails with `BAD_MODEL_NAME`

The endpoint rejected the model name. `apiModel` in `providers.json` is what gets
sent upstream; `id` is what Cursor stores. They only need to differ when your
gateway uses a different identifier than the one you want displayed.

Verify against the endpoint directly:

```bash
curl -sS https://your-endpoint/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"your-model","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'
```

---

## BYOK server is down

```bash
curl -s http://127.0.0.1:39831/health
```

Expected: `{"ok":true,"mode":"byok"}`.

If it fails, the server is not running or is on another port. `status` prints the
port from `routes.json`; `serve` prints the port it bound to. They must match.
`apply` synchronises them. Start it with `cursor-byok run`, or in the foreground
with `cursor-byok serve`.

---

## Everything worked, then stopped after a Cursor update

Expected. Cursor replaces the patched files.

```bash
cursor-byok apply
```

Or point your launcher at `cursor-byok run`, which detects the update and re-applies
before starting. See the README.

---

## `apply` says the patch anchors were not found

Cursor changed the shape of the code the patch targets. Nothing was written, so the
install is still intact.

1. Check the version: `cursor-byok status`.
2. Confirm the guards still exist in this build:

```bash
node -e '
const fs = require("fs");
const root = process.env.CURSOR_APP_ROOT ||
  process.env.HOME + "/Applications/CursorByok/squashfs-root/usr/share/cursor/resources/app";
const data = fs.readFileSync(root + "/out/vs/workbench/workbench.desktop.main.js", "utf8");
for (const needle of ["subscriptionChangedListener=", "action=disable-openai-key"]) {
  console.log(needle, "->", data.indexOf(needle));
}'
```

3. If the markers are gone, the guard moved. Open an issue with the version and the
   surrounding ~200 bytes, and use `cursor-byok revert` until the anchors are updated.

---

## "Model default was not found in providers.json"

Cursor selected **Auto**, which it sends as `modelId: "default"`. Your provider file
has no model with that id, so the request is rejected before it reaches your
endpoint.

```bash
cursor-byok alias          # maps "default" to your primary model
```

The server reads `providers.json` on every turn, so no restart is needed. If you
are already on a named model, switching away from Auto also avoids it — but the
alias is the durable fix, because new composers start on Auto.

Why it can appear even though you picked a named model: the catalog Cursor persisted
can revert to its own 46-model list if a model fetch lands before the local server
is listening. When that happens a new composer defaults to Auto. See failure 5 in
`docs/how-it-works.md`.

---

## Picker shows only Auto, but the server is healthy

The startup race. Cursor's first model fetch beats the local server by a few
seconds, and the resulting catalog gets persisted.

```bash
cursor-byok run     # quit Cursor first: seeds, then launches
```

Seeding is refused while Cursor is running, because Cursor holds the state in
memory and rewrites the row within seconds. Quit it first.

Details: `docs/how-it-works.md`, failure 5.

---

## Reverting

```bash
cursor-byok revert          # restore baselines, restart Cursor
rm -rf ~/.cursor-byok-patch # drop all local state
```

`revert` needs a baseline, which is captured before the first write. If you applied
the patch before this tool existed, use `cursor-byok update` to extract a fresh tree
instead — that path always starts from pristine files.

# Troubleshooting

Start here:

```bash
cursor-byok doctor
```

It checks the install, both guards, the router, the extension, the HTTP setting,
the port, the server health, and your provider file. Each failure prints the
command that fixes it.

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
local server from `~/.ccursor/providers.json`; if that file is empty or malformed,
the picker has nothing to show. `cursor-byok status` reports the provider count.

---

## "Server error" or "Protocol error" on every agent turn

**Check the transport first.**

```bash
python3 -c "import json,pathlib;print(json.loads(pathlib.Path.home()/'.config/Cursor/User/settings.json').read_text().get('cursor.general.disableHttp2'))"
```

Must print `True`. If it prints `None` or `False`, run `cursor-byok apply`.

**Then check for a stray base URL override.**

```bash
env | grep CURSOR_API_BASE_URL
```

Unset it. The router rewrites URLs; this variable makes the client speak HTTP/2 to
a plain HTTP server, which yields `ERR_HTTP2_ERROR`.

**Confirm the request actually reached the local server.** Enable the extension log
stream and send one message:

```bash
curl -sN "http://127.0.0.1:39831/byok/log-stream?windowId=1"
```

A working turn logs `[AGENT] → [openai-chat/<model>] ... "your prompt"`. If nothing
appears, the request never arrived and the transport is still the problem.

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

If it fails, the extension is not running or is on another port. `status` prints
the port from `routes.json`; the extension log prints the port it bound to. They
must match. `apply` synchronises them.

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
python3 - <<'EOF'
import pathlib, os
root = pathlib.Path(os.environ.get("CURSOR_APP_ROOT", pathlib.Path.home()/"Applications/CursorByok/squashfs-root/usr/share/cursor/resources/app"))
data = (root/"out/vs/workbench/workbench.desktop.main.js").read_bytes()
for needle in (b"subscriptionChangedListener=", b"action=disable-openai-key"):
    print(needle.decode(), "->", data.find(needle))
EOF
```

3. If the markers are gone, the guard moved. Open an issue with the version and the
   surrounding ~200 bytes, and use `cursor-byok revert` until the anchors are updated.

---

## Reverting

```bash
cursor-byok revert          # restore baselines, restart Cursor
rm -rf ~/.cursor-byok-patch # drop all local state
```

`revert` needs a baseline, which is captured before the first write. If you applied
the patch before this tool existed, use `cursor-byok update` to extract a fresh tree
instead — that path always starts from pristine files.

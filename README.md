# ccursor

Keep **bring-your-own-key** working in the Cursor IDE across updates.

Cursor lets you point its chat and agent at your own OpenAI-compatible endpoint.
In practice that setup breaks in four separate places, and each one fails with a
different, unhelpful error. This tool fixes all four, verifies the result, and
re-applies itself when Cursor updates and wipes the patches.

It does **not** unlock Cursor's paid models. You still bring your own API key and
pay your own provider.

```
cursor-byok status
```

```text
[>] app root: ~/Applications/CursorByok/squashfs-root/usr/share/cursor/resources/app
    version 3.27.12

workbench.desktop.main.js
  hook injected       : yes
  subscription guard  : neutralised
  admin policy guard  : neutralised

transport
  BYOK extension      : installed
  router always-local : yes
  router agent-host   : yes

configuration
  disableHttp2        : True
  routes.json port    : 39831
  providers           : 1 (blink)
  BYOK server         : up
```

---

## The four failures

| # | Failure | Symptom |
|---|---|---|
| 1 | Transport uses HTTP/2, router only hooks `http.request` | `Protocol error`, `Server error` on every agent turn |
| 2 | Plan refresh reads as `free` and turns the BYOK toggle off | Model disappears from the picker, only Auto left |
| 3 | Account policy reports BYOK disabled and resets the toggle | Same as above, silently, on restart |
| 4 | Port in `routes.json` disagrees with the extension | Requests reach a closed port, nothing responds |

Each is described with evidence in [docs/how-it-works.md](docs/how-it-works.md).

---

## Requirements

- Linux with an extracted Cursor install (AppImage, `.deb`, `.rpm` — anything with
  a `resources/app` directory)
- Python 3.9+
- Node.js 18+ (used by the upstream hook installer and to syntax-check patched bundles)
- An OpenAI-compatible endpoint and key

macOS and Windows are not covered by the update and launcher helpers. The patching
logic itself is platform-independent; `CURSOR_APP_ROOT` lets you point it anywhere.

## Install

```bash
git clone https://github.com/fahmiirsyadk/ccursor ~/dev/ccursor
cd ~/dev/ccursor
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/cursor-byok apply
```

Or run it straight from the tree without installing:

```bash
PYTHONPATH=src python3 -m cursor_byok.cli apply
```

If Cursor lives somewhere unusual:

```bash
CURSOR_APP_ROOT=/path/to/resources/app cursor-byok apply
```

## Configure a provider

`~/.ccursor/providers.json` lists the endpoints and models you want in the picker:

```json
{
  "$schemaVersion": 1,
  "providers": [
    {
      "id": "my-gateway",
      "name": "My Gateway",
      "type": "openai-chat",
      "baseUrl": "https://api.example.com/v1",
      "auth": { "kind": "apiKey", "value": "sk-..." },
      "models": [
        {
          "id": "vendor/model-name",
          "apiModel": "vendor/model-name",
          "displayName": "Model Name",
          "contextTokenLimit": 200000,
          "maxOutputTokens": 16384,
          "supportsImages": false,
          "supportsAgent": true,
          "supportsCmdK": true,
          "thinking": false,
          "defaultOn": true
        }
      ]
    }
  ]
}
```

Then in Cursor: **Settings → Models**, enable *Use API Key*, and pick the model.
Full field reference: [docs/provider-setup.md](docs/provider-setup.md).

## Commands

| Command | Purpose |
|---|---|
| `apply` | Patch an install. Idempotent. `--dry-run` to preview, `--skip-installer` to skip the upstream hook. |
| `status` | What is currently in effect, including a live server health check. |
| `doctor` | Explain why something is broken, and print the next step. |
| `revert` | Restore the bundles Cursor shipped with. |
| `run` | Re-apply if an update wiped the patches, then launch Cursor. |
| `update` | Extract a new AppImage into a staging tree, patch it, verify, swap. |
| `update --rollback` | Go back to the previous tree. |

### Point your launcher at `run`

`run` compares bundle mtimes against a marker file. If Cursor updated itself, the
patches are gone, the marker no longer matches, and `run` re-applies before
starting. Wire it into your desktop entry once:

```ini
[Desktop Entry]
Name=Cursor
Exec=/home/you/dev/ccursor/.venv/bin/cursor-byok run %U
Type=Application
StartupWMClass=Cursor
```

### Updating Cursor

Do not launch the raw AppImage — it will replace the patched tree with a clean one.
Use the staging flow instead:

```bash
cursor-byok update --appimage ~/Applications/Cursor.AppImage
```

The new version is extracted to a temp directory, patched, syntax-checked, and only
then swapped in. The previous tree stays at `squashfs-root.old` until the next update.

---

## What gets modified

| Target | Change |
|---|---|
| `out/vs/workbench/workbench.{desktop,glass}.main.js` | Two one-line guards neutralised |
| `extensions/cursor-{agent-host,always-local}/dist/main.js` | HTTP/1.1 router (upstream installer) |
| `out/vs/workbench/api/node/extensionHostProcess.js` | Hook bootstrap (upstream installer) |
| `~/.config/Cursor/User/settings.json` | `cursor.general.disableHttp2 = true` |
| `~/.ccursor/routes.json` | `server.port` synchronised |
| `product.json` | Checksums refreshed for patched bundles |

Local state lives in `~/.cursor-byok-patch`:

```
baselines/   pristine bundles, captured before the first write
backups/     timestamped copy before each write
applied.json bundle mtimes at last successful patch
```

`revert` restores from `baselines/`. Delete the directory to start clean.

## Before you start

- **Your keys, your bill.** Requests go straight to the endpoint you configure.
- **Third-party modification.** This patches Cursor's application bundle. Cursor's
  terms may prohibit it, and updates can break it at any time. Use it on your own
  machine, on your own account, at your own risk.
- **Verify against your build.** Patches anchor on surrounding code and refuse to
  apply when the shape changed. `doctor` tells you when that happens instead of
  writing something broken.
- **No affiliation.** Not affiliated with Cursor or Anysphere. The hook and router
  come from [@cometix/ccursor](https://www.npmjs.com/package/@cometix/ccursor),
  which this tool drives and pins.

## Development

```bash
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
PYTHONPATH=src .venv/bin/python -m pytest -q
```

The patch tests build synthetic bundles that reproduce the shape of Cursor's
minified output, so a change in Cursor's structure fails a test rather than
silently producing a broken bundle.

## License

MIT. See [LICENSE](LICENSE).

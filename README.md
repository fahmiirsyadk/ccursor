# ccursor

Keep **bring-your-own-key** working in the Cursor IDE across updates.

Cursor lets you point its chat and agent at your own [OI]-compatible endpoint.
In practice that setup breaks in six separate places, each failing with a different,
unhelpful error. This tool fixes all six, verifies the result, and re-applies itself
when Cursor updates and wipes the patches.

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
  disableHttp2        : true
  routes.json port    : 39831
  providers           : 1 (blink)
  BYOK server         : up
```

---

## Is this for you?

You configured your own key in Cursor and it does not work: the picker falls back
to Auto, or every agent turn ends in `Server error`. That is what this fixes.

---

## How it works

Cursor sends every agent turn to its own backend. This tool installs a router that
diverts those calls to a local server, which forwards them to your endpoint.

**Startup** — `cursor-byok run`:

```
1. marker check        bundle mtimes changed? -> Cursor updated -> re-apply
2. seed catalog        state.vscdb <- your models from providers.json
3. launch Cursor       renderer already sees your model in the picker
```

**One agent turn:**

```
composer
  -> agent host          https.request("api2.cursor.sh/.../RunSSE")
  -> router              host + path match routes.json -> rewrite
  -> 127.0.0.1:39831     resolve model id -> apiModel
  -> your endpoint       POST /chat/completions (stream)
  <- SSE deltas          mapped to Cursor frames
  <- renderer
```

**Tool calls** are a loop, not one request:

```
round N   prompt = system + tools + conversation + tool_results
          model returns stop_reason = tool_use
          adapter maps the tool name to a Cursor tool, Cursor executes it natively
          result appended as a tool_results turn
round N+1 ...                                  until stop_reason = end_turn
```

The model decides when to stop, which is why an unbounded run can loop.
[docs/tool-calling.md](docs/tool-calling.md) covers that and the one-file-per-Write
rule.

Full trace with real log lines: [docs/architecture.md](docs/architecture.md).

---

## Requirements

- Linux with an extracted Cursor install (AppImage, `.deb`, `.rpm` — anything with
  a `resources/app` directory)
- Node.js 22.5+ (uses the built-in `node:sqlite`; no native modules, no dependencies)
- An [OI]-compatible endpoint and key

macOS and Windows are not covered by the update and launcher helpers. The patching
logic itself is platform-independent; `CURSOR_APP_ROOT` lets you point it anywhere.

## Install

```bash
git clone https://github.com/fahmiirsyadk/ccursor ~/dev/ccursor
cd ~/dev/ccursor
npm link          # or: node src/cli.js <command>
cursor-byok apply
```

Run straight from the tree without linking:

```bash
node src/cli.js apply
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

Then add the Auto alias and pick a model:

```bash
cursor-byok alias
```

Cursor sends `modelId: "default"` whenever Auto is selected, and new composers start
on Auto, so without the alias those turns are rejected before reaching your
endpoint. Full field reference: [docs/provider-setup.md](docs/provider-setup.md).

## Commands

| Command | Purpose |
|---|---|
| `apply` | Patch an install and seed the catalog. Idempotent. `--dry-run` to preview. |
| `status` | What is currently in effect, including a live server health check. |
| `doctor` | Explain why something is broken, and print the next step. |
| `revert` | Restore the bundles Cursor shipped with. |
| `run` | Seed the catalog, re-apply if needed, then launch Cursor. |
| `update` | Extract a new AppImage into a staging tree, patch it, verify, swap. |
| `update --rollback` | Go back to the previous tree. |
| `alias` | Map Cursor's Auto id (`default`) to your primary model. |
| `rule` | Print the agent rule that keeps multi-file edits sane. |

### Point your launcher at `run`

`run` does three things in order, and the order matters:

1. Re-applies patches if bundle mtimes no longer match the marker (Cursor updated).
2. Seeds the model catalog into `state.vscdb` **while Cursor is closed**, so the
   first `AvailableModels` render already has your models.
3. Launches Cursor detached.

Wire it into your desktop entry once:

```ini
[Desktop Entry]
Name=Cursor
Exec=/home/you/dev/ccursor/src/cli.js run %U
Type=Application
StartupWMClass=Cursor
```

Seeding is skipped with a warning when Cursor is already running, because Cursor
would overwrite the row from memory within seconds.

### Updating Cursor

Do not launch the raw AppImage — it will replace the patched tree with a clean one.
Use the staging flow instead:

```bash
cursor-byok update --appimage ~/Applications/Cursor.AppImage
```

The new version is extracted beside the install (same filesystem, so the swap is a
rename), patched, syntax-checked, and only then swapped in. The previous tree stays
at `squashfs-root.old` until the next update.

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
| `~/.config/Cursor/User/globalStorage/state.vscdb` | Model catalog and composer models seeded (only in `apply`/`run`) |

Local state lives in `~/.cursor-byok-patch`:

```
baselines/   bundles as Cursor shipped them, captured before the first write
backups/     timestamped copy before each write
applied.json bundle mtimes at last successful patch
catalog.json last catalog computed from providers.json
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
  which this tool drives, pins by hash, and vendors rather than re-fetching. That
  package is unauditable (minified JS plus native binaries), which is why replacing
  it is planned — see [docs/reimplementation.md](docs/reimplementation.md).

## Development

```bash
npm test
```

The patch tests build synthetic bundles that reproduce the shape of Cursor's
minified output, so a change in Cursor's structure fails a test rather than
silently producing a broken bundle.

## License

MIT. See [LICENSE](LICENSE).

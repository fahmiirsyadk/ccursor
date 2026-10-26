# cursor-byok

Use your own API key with Cursor's chat and agent, and keep it working when Cursor
updates.

Cursor has a built-in bring-your-own-key (BYOK) mode: you point it at an
OpenAI-compatible endpoint and pay that provider instead of Cursor. In practice the
mode keeps switching itself off, the model picker falls back to Auto, and agent turns
end in `Server error`. This tool fixes those failures and puts a small local server
between Cursor and your endpoint, so every agent turn reaches your model.

It does **not** unlock Cursor's paid models. You still bring your own key and pay
your own provider.

```
$ cursor-byok status
```

```text
[>] app root: ~/Applications/CursorByok/squashfs-root/usr/share/cursor/resources/app
    version 3.27.12

workbench.desktop.main.js
  foreign hook        : none
  subscription guard  : neutralised
  admin policy guard  : neutralised

transport
  router always-local : yes
  router agent-host   : yes
  extension hashes    : 15 verified, 2 ours unverified
  schema cache        : 9546 messages from Cursor's client

configuration
  disableHttp2        : true
  routes.json port    : 39831
  redirect rules      : 91
  providers           : 1
  BYOK server         : running on 39831
```

---

## What it does

Three things, in this order:

1. **Stops Cursor from switching BYOK off.** Cursor has two independent guards that
   quietly turn the setting back off — one when your billing profile refreshes, one
   when the account policy is read. Both are neutralised.
2. **Adds a router inside Cursor.** A small script is prepended to Cursor's own
   extension hosts. It rewrites the calls Cursor would send to its own backend so
   they go to a local server instead.
3. **Answers those calls locally.** `cursor-byok serve` runs a server on
   `127.0.0.1:39831` that speaks Cursor's protocol and forwards each turn to the
   endpoint in your config.

```
Cursor  ──▶  router (inside Cursor)  ──▶  127.0.0.1:39831  ──▶  your endpoint
             rewrites the target           answers Cursor's        streams the
                                           protocol, runs the      answer back
                                           agent + tool loop
```

Nothing is forwarded to Cursor's backend. Model listing, the agent loop, tool
execution, usage panels and analytics are all answered locally, so the account needs
no plan and no seat.

## What it does not do

- No access to Cursor's paid models, quotas, or cloud agents.
- No proxy, no VPN, no account sharing.
- No traffic to Cursor's backend on your behalf. Telemetry hosts are answered
  locally with `204` and dropped. Marketplace and update hosts are deliberately left
  alone, because blocking them would break extension installs and updates.
- No change to your code, your repositories, or your extensions.

## Is this for you?

Yes, if you configured your own key in Cursor and it does not work: the picker falls
back to Auto, the toggle turns itself off, or every agent turn fails.

No, if you are looking for free access to Cursor's models. This is a BYOK fix, not a
subscription bypass.

---

## Requirements

- Linux with an extracted Cursor install (AppImage, `.deb`, `.rpm` — anything that
  has a `resources/app` directory).
- Node.js 22.5 or newer (uses the built-in `node:sqlite`).
- An OpenAI-compatible endpoint and key.

macOS and Windows are not covered by the update and launcher helpers. The patching
logic itself is platform-independent; `CURSOR_APP_ROOT` points it anywhere.

## Install

```bash
git clone https://github.com/fahmiirsyadk/ccursor ~/dev/ccursor
cd ~/dev/ccursor
npm install
npm link            # optional: gives you the `cursor-byok` command
```

Then patch your install:

```bash
cursor-byok apply
```

Or run it straight from the checkout, without linking:

```bash
node src/cli.js apply
```

If Cursor lives somewhere unusual:

```bash
CURSOR_APP_ROOT=/path/to/resources/app cursor-byok apply
```

`apply` is safe to run again. It reports what changed and does nothing if everything
is already in place. Use `--dry-run` to see the plan without writing.

## Configure

Everything lives in `~/.cursor-byok-patch/` (`CURSOR_BYOK_STATE` overrides it).

### 1. `providers.json` — your endpoints and models

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
          "defaultOn": true
        }
      ]
    }
  ]
}
```

`id` is what Cursor shows and stores; `apiModel` is the name sent to your provider
(defaults to `id`). Set `contextTokenLimit` — it drives the context meter and
compaction, and a wrong value causes bad truncation.

Full field reference and worked examples: [docs/provider-setup.md](docs/provider-setup.md).

### 2. `cursor-byok alias` — make Auto work

Cursor sends `modelId: "default"` whenever **Auto** is selected, and new composers
start on Auto. Without an alias those turns are rejected before reaching your
endpoint.

```bash
cursor-byok alias
```

This adds a `default` entry pointing at your primary model. The picker still shows a
single Auto entry.

### 3. `routes.json` — what gets diverted

Written by `apply` from Cursor's own protocol schema, so it covers every RPC the
client can call — currently 86 services plus 5 auth endpoints. You normally do not
edit it.

---

## Use

Point your desktop entry at `run` instead of the Cursor binary:

```ini
[Desktop Entry]
Name=Cursor
Exec=/home/you/dev/ccursor/src/cli.js run %U
Type=Application
StartupWMClass=Cursor
```

`run` does four things, and the order matters:

1. Re-applies the patches if Cursor was updated.
2. Seeds your models into Cursor's state (Cursor must be closed for this).
3. Starts the local server and waits until it answers.
4. Launches Cursor.

Any flags after `run` are passed to Cursor. It also clears `CURSOR_API_BASE_URL` and
`CURSOR_WEBSITE_URL` from the environment, because a stray base URL makes the client
speak HTTP/2 to a plain HTTP server.

The server must own the port before Cursor starts, because the router sends traffic
there from the first turn.

### Commands

| Command | What it does |
|---|---|
| `apply` | Patch the install, cache the schema and prompt, seed the catalog. Idempotent. `--dry-run` previews. |
| `status` | Show what is in effect, plus a live server check. |
| `doctor` | Explain what is broken and print the fix. |
| `revert` | Restore the bundles Cursor shipped with. |
| `run` | Re-apply if needed, seed, start the server, launch Cursor. |
| `serve` | Run the server in the foreground (`--port`, `--app`). |
| `stop` | Stop the background server (`--force` even while Cursor runs). |
| `update` | Extract a new AppImage into a staging tree, patch, verify, swap. |
| `update --rollback` | Go back to the previous tree. |
| `alias` | Map Cursor's Auto id (`default`) to your primary model. |
| `rule` | Print the agent rule that keeps multi-file edits sane (`--write <path>`). |

Environment variables: `CURSOR_APP_ROOT`, `CURSOR_BYOK_STATE`, `NO_COLOR`.

---

## What the model can do

The agent runs with Cursor's own tool vocabulary, and Cursor executes the tools
natively — the local server never touches your files.

| Tool | Purpose |
|---|---|
| `Read` | Read a file, with optional offset and limit. |
| `Write` | Create or replace a file. |
| `Edit` | Replace an exact string in a file. |
| `Delete` | Remove a file. |
| `Shell` | Run a command in a persistent terminal session. |
| `Grep` | Search file contents by regular expression. |
| `Glob` | Find files by pattern. |
| `Task` | Delegate to a subagent. |

Subagents are real: `explore` gets read-only tools (`Read`, `Grep`, `Glob`), while
`debug` and `bash` also get write and shell access. A subagent is never given
`Task`, so it cannot re-delegate the same work forever.

Also working:

- **Streaming.** Text arrives as it is generated, with heartbeats while a long tool
  runs, so Cursor does not report a stalled connection.
- **Images.** Attached screenshots are passed to models that accept them. For a
  text-only model, the text in the image is read locally when OCR is available, and
  the model is told what was attached either way.
- **Cursor's own prompt.** The agent prompt is read from Cursor's installed
  `cursor-agent-exec` extension and rendered from its own element tree. The
  per-turn `user_info` block (OS, shell, workspace path, date) is built the same way.
  Nothing in the prompt is written by this project.
- **Your instructions.** `AGENTS.md`, `.cursor/rules`, custom instructions and a
  subagent reminder are passed through from the request, verbatim.
- **History.** Uploaded conversation blobs are stored locally, so earlier turns
  survive a restart.

---

## Can it break Cursor?

It edits files inside your Cursor installation, so treat it like any patch: it can
break that install, and a Cursor update can undo it.

Most of the change is additive: a router prepended to two of Cursor's extension
hosts, plus a local server that runs as its own process. The edits to Cursor's own
logic are small and specific — two guards replaced with a constant, the extension
hash check narrowed to the two files we touch, and one settings flag.

What protects you:

- **A baseline is captured before the first write**, and a timestamped snapshot
  before every write. `cursor-byok revert` restores the pristine files.
- **Patches are validated.** Each one anchors on surrounding code, checks the span
  it is about to rewrite, and refuses to write when the shape does not match. It
  reports the problem instead of guessing.
- **Updates go through a staging tree.** `update` extracts the new AppImage beside
  the old one, patches it, syntax-checks it, and only then swaps. The previous tree
  stays at `squashfs-root.old` until the next update, and `update --rollback`
  returns to it.
- **The server is separate from Cursor.** If it crashes or is stopped, Cursor still
  runs; agent turns fail until you start it again.

What it changes, and nothing else:

| Target | Change |
|---|---|
| `out/vs/workbench/workbench.{desktop,glass}.main.js` | Two one-line guards neutralised; a hook an earlier installer left behind is removed |
| `extensions/cursor-{agent-host,always-local}/dist/main.js` | Router prepended |
| `out/vs/workbench/api/node/extensionHostProcess.js` | Hash check narrowed to those two files, so everything else is still verified |
| `~/.config/Cursor/User/settings.json` | `cursor.general.disableHttp2 = true` |
| `product.json` | Checksums refreshed for the patched bundles |
| `~/.config/Cursor/User/globalStorage/state.vscdb` | Your models seeded into the picker (only in `apply` / `run`) |

Do not launch the raw AppImage after patching: it will replace the patched tree with
a clean one. Use the staging flow instead:

```bash
cursor-byok update --appimage ~/Applications/Cursor.AppImage
```

`--install-dir` picks a different destination, `--drop-old` deletes the previous
tree after a successful swap, and `--rollback` restores it.

### Local state

```
~/.cursor-byok-patch/
  providers.json   your endpoints and models
  routes.json      what gets diverted (generated)
  prompt.txt       Cursor's agent prompt (extracted by apply)
  schema/          Cursor's protobuf schema (extracted by apply)
  baselines/       bundles as Cursor shipped them, captured before the first write
  backups/         timestamped copy before each write
  applied.json     bundle mtimes at the last successful patch
  catalog.json     last catalog computed from providers.json
  server.log       server output
```

Delete the directory to start clean.

---

## Troubleshooting

Start with:

```bash
cursor-byok doctor
```

It checks the install, both guards, the router, the HTTP setting, the port, the
provider file, and the server, then prints the next step.

| Symptom | Likely cause |
|---|---|
| Picker shows only Auto | The `default` alias is missing, or the catalog was seeded before the server was up. |
| `Server error` on every turn | The server is not listening, or `disableHttp2` is not `true`. |
| Toggle turns itself off | A guard patch is missing — run `apply`. |
| Everything stopped after an update | Cursor replaced the patched tree — run `apply`, or use `update`. |

More: [docs/troubleshooting.md](docs/troubleshooting.md).

## Documentation

| Document | Contents |
|---|---|
| [architecture.md](docs/architecture.md) | How a message travels, with real log lines. |
| [how-it-works.md](docs/how-it-works.md) | The six failure modes this fixes, and the evidence for each. |
| [provider-setup.md](docs/provider-setup.md) | Every `providers.json` field, with examples. |
| [troubleshooting.md](docs/troubleshooting.md) | Symptom → cause → fix. |
| [tool-calling.md](docs/tool-calling.md) | Why one `Write` call per file matters. |

## Before you start

- **Your keys, your bill.** Requests go straight to the endpoint you configure,
  under that provider's terms.
- **Third-party modification.** This patches Cursor's application bundle. Cursor's
  terms may prohibit that, and updates can break it. Use it on your own machine, on
  your own account, at your own risk.
- **No affiliation.** Not affiliated with Cursor or Anysphere. The router, the
  server, the schema reader and the prompt renderer are all in this repository.
- **No third-party code.** The only runtime dependency is
  [`protobufjs`](https://www.npmjs.com/package/protobufjs). Nothing is downloaded at
  run time.

See [SECURITY.md](SECURITY.md) for the full trust model.

## Development

```bash
npm test
```

The patch tests build synthetic bundles that reproduce the shape of Cursor's
minified output, so a change in Cursor's structure fails a test instead of silently
producing a broken bundle.

Useful:

```bash
node tools/extract-schema.js --message AgentRunRequest   # inspect Cursor's protocol
node tools/extract-prompt.js --print                    # read Cursor's agent prompt
```

Contributor notes: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).

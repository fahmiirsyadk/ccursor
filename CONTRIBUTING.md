# Contributing

## Setup

```bash
git clone https://github.com/fahmiirsyadk/ccursor ~/dev/ccursor
cd ~/dev/ccursor
npm install
npm test
```

One runtime dependency (`protobufjs`, for Cursor's protobuf schemas), no build step,
no transpiler. Tests use `node:test`.

## What needs care

**The patch anchors.** `src/bundles.js` is the part that breaks when Cursor
changes. If you touch it:

- Anchor on structure, not on minified names. Names change every release.
- Keep the validation in place. A patch that matches too loosely will corrupt a
  bundle; failing loudly is always better.
- Add a fixture to `tests/bundles.test.js` that reproduces the new shape.

**Bundle writes.** Never write without a baseline and a snapshot first. `revert` is
the only safety net a user has.

**Seeding.** `src/seed.js` writes into Cursor's SQLite state. It must refuse to run
while Cursor is open — Cursor holds that state in memory and overwrites the row
within seconds, so a live seed is silently lost.

**The prompt.** `src/prompt/` reads Cursor's own prompt out of its installed
`cursor-agent-exec` extension and renders it. Do not add prompt text of our own; if
extraction fails, the turn runs without it and says so.

**A tool call is not always a tool exec.** Cursor has a `globToolCall` but no glob
exec — a Glob runs as a Grep with the glob as a filter. Check `ExecServerMessage` in
the schema, then mirror what Cursor's own runtime does (`extensions/cursor-agent-host`).

## Testing against a real install

```bash
node src/cli.js apply --dry-run    # reports, writes nothing
node src/cli.js apply              # writes, keeps snapshots
node src/cli.js doctor             # end-to-end check
node src/cli.js revert             # back to pristine
```

Extract a throwaway tree to test without touching your daily install:

```bash
mkdir -p /tmp/cursor-test && cd /tmp/cursor-test
~/Applications/Cursor.AppImage --appimage-extract
CURSOR_APP_ROOT=/tmp/cursor-test/squashfs-root/usr/share/cursor/resources/app \
  node ~/dev/ccursor/src/cli.js apply
```

## Pull requests

- Keep changes focused; one concern per PR.
- Update the relevant doc when behaviour changes: `README.md`,
  `docs/architecture.md`, `docs/troubleshooting.md`, `docs/tool-calling.md`.
- Tests must pass: `npm test`.
- If your change depends on a specific Cursor build, say which one in the PR
  description.

## Reporting a broken anchor

Open an issue with:

- Cursor version (`cursor-byok status`)
- the output of `cursor-byok doctor`
- for anchor failures, the ~200 bytes around the marker:

```bash
node -e '
const fs = require("fs");
const root = process.env.CURSOR_APP_ROOT;
const data = fs.readFileSync(root + "/out/vs/workbench/workbench.desktop.main.js", "utf8");
for (const needle of ["subscriptionChangedListener=", "action=disable-openai-key"]) {
  const i = data.indexOf(needle);
  console.log(needle, "->", i);
  if (i >= 0) console.log(JSON.stringify(data.slice(Math.max(0, i - 200), i + 200)));
}'
```

# Agent notes

Instructions for anyone — human or agent — making changes in this repository.

## What this repo is

A CLI that keeps bring-your-own-key working in the Cursor IDE: it neutralises the
two guards that disable BYOK, forces the transport onto the path the BYOK router can
intercept, synchronises the port, and seeds the model catalog before launch.

Node.js only. One dependency (`protobufjs`, for Cursor's protobuf schemas), no build
step, no transpiler. `node:test` for tests.

## Layout

| Path | Responsibility |
|---|---|
| `src/bundles.js` | The two workbench patches. **The part that breaks when Cursor changes.** |
| `src/seed.js` | Writes the model catalog into Cursor's `state.vscdb` before launch. |
| `src/settings.js` | HTTP/1.1 flag, routes port, checksums. |
| `src/state.js` | Baselines, snapshots, the update marker. |
| `src/update.js` | AppImage staging, verification, swap, rollback. |
| `src/locate.js` | Finds `resources/app`. |
| `src/inject.js` | Prepends the router to Cursor's own extension hosts. |
| `src/router.js` | The router itself: runs inside Cursor, diverts calls. |
| `src/extensionHost.js` | Narrows the extension hash check to the files we modify. |
| `src/cli.js` | Argument parsing and command dispatch. |
| `src/server.js` | The local BYOK server: Connect RPC surface. |
| `src/daemon.js` | Starting, probing and stopping the background server. |
| `src/prompt/` | Cursor's own prompt: load its builder from the install, render the tree, build the `user_info` block per turn. |
| `src/agent/` | One agent turn: request parsing, provider call, response encoding. |

## Rules for changes

**Never write a bundle without a baseline and a snapshot first.** `revert` is the
only safety net a user has. `state.captureBaseline` runs before anything else
touches a file.

**Keep patch anchors structural.** A minified bundle has no stable names. Anchor on
surrounding text, bound the span, validate it, and report `not-found` rather than
guessing. A patch that matches too loosely corrupts the install; failing loudly is
always better.

**Never write prompt text.** The system prompt is Cursor's: `src/prompt/` reads its
builder from the install and renders it. If extraction fails, the turn runs without
it and says so. A hand-written substitute is a prompt this project invented, and it
drifts from the behaviour the IDE actually has.

**A tool call is not always a tool exec.** Cursor has a `globToolCall` but no glob
exec — a Glob runs as a Grep with the glob as a filter. Check `ExecServerMessage` in
the schema before inventing a case, and mirror what Cursor's own runtime does with it
(`extensions/cursor-agent-host`).

**Refuse to seed while Cursor is running.** Cursor holds that state in memory and
rewrites the row within seconds, so a live seed is silently lost. `seed.js` checks
this; do not add a bypass that skips the check.

**Do not hardcode names you read from logs.** Cursor's toggle field contains a vendor
token that tooling rewrites in transcripts, so a literal copy can be a different
string than the one on disk. Build such names from parts and pin the bytes in a test
(`tests/toggle.test.js`).

**The server must be listening before Cursor starts.** The router inside Cursor's
extension hosts sends traffic to the port, so a server started afterwards arrives to
find every turn already failed.

**Run `npm test` before committing.** The fixtures reproduce the real shape of
Cursor's minified output. If a change makes them fail, the change is wrong or the
fixtures need to describe a new Cursor shape — decide which, deliberately.

## Tool calling: one file per Write

The Write tool replaces a whole file. When several files are written in one turn,
issue one Write call per file. Never put two files' contents into a single
`contents` field.

Symptoms when this is ignored: a manifest ends up containing JavaScript, a source
file ends up containing JSON, and no error is reported because the bytes were
written verbatim. Cursor's `Write` maps to an internal `editToolCall` with
`writeArgs`, which forwards the string unchanged.

Observed cause: long tool-only stretches degrade instruction-following. In one run,
26 consecutive rounds produced no text, and the final round batched two files into
one call. Bounding the turn fixes it — see `docs/tool-calling.md`.

Recovery: if `package.json` fails to parse, or a `.js` file starts with `{`, the two
files were merged. Split them at the boundary.

## Commits

Conventional commits. Explain *why* in the body when the change is not obvious from
the diff — especially for patch-anchor changes, where the reasoning is the valuable
part.

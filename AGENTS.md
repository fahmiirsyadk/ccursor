# Agent notes

Instructions for anyone — human or agent — making changes in this repository.

## What this repo is

A CLI that keeps bring-your-own-key working in the Cursor IDE: it neutralises the
two guards that disable BYOK, forces the transport onto the path the BYOK router can
intercept, synchronises the port, and seeds the model catalog before launch.

Node.js only. No dependencies, no build step, no transpiler. `node:test` for tests.

## Layout

| Path | Responsibility |
|---|---|
| `src/bundles.js` | The two workbench patches. **The part that breaks when Cursor changes.** |
| `src/seed.js` | Writes the model catalog into Cursor's `state.vscdb` before launch. |
| `src/settings.js` | HTTP/1.1 flag, routes port, checksums. |
| `src/state.js` | Baselines, snapshots, the update marker. |
| `src/update.js` | AppImage staging, verification, swap, rollback. |
| `src/locate.js` | Finds `resources/app`. |
| `src/ccursor.js` | Drives the pinned upstream hook installer. |
| `src/cli.js` | Argument parsing and command dispatch. |

## Rules for changes

**Never write a bundle without a baseline and a snapshot first.** `revert` is the
only safety net a user has. `state.captureBaseline` runs before anything else
touches a file, including the upstream installer.

**Keep patch anchors structural.** A minified bundle has no stable names. Anchor on
surrounding text, bound the span, validate it, and report `not-found` rather than
guessing. A patch that matches too loosely corrupts the install; failing loudly is
always better.

**Refuse to seed while Cursor is running.** Cursor holds that state in memory and
rewrites the row within seconds, so a live seed is silently lost. `seed.js` checks
this; do not add a bypass that skips the check.

**Do not hardcode names you read from logs.** Cursor's toggle field contains a vendor
token that tooling rewrites in transcripts, so a literal copy can be a different
string than the one on disk. Build such names from parts and pin the bytes in a test
(`tests/toggle.test.js`).

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

# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Cursor's own agent prompt is used.** It is not written by this project and not
  fetched from Cursor's servers: `apply` reads the prompt out of Cursor's bundled
  `cursor-agent-exec` extension, which builds it as an element tree, and renders it
  with the same rules as the renderer beside it. The result is cached in
  `~/.cursor-byok-patch/prompt.txt`. `tools/extract-prompt.js --print` shows it.
- **`user_info` is built per turn.** Cursor's own component produces the block that
  tells the model its OS, shell, workspace path, git status and today's date, from
  the environment in the request. Without it the model guessed a repository path, and
  a delegated `Task` then searched a directory that did not exist.
- `src/prompt/` holds the loader, the renderer, the cached prompt and the `user_info`
  builder; `src/agent/prompt.js` only composes them with the request's instructions.

### Fixed

- **`revert` did not revert.** It restored the workbench bundles and stopped there,
  leaving the router injected in both extension hosts and their entries missing from
  Cursor's expected-hash table. The router then pointed at a port nothing answered,
  so every turn failed instead of falling back to Cursor's own backend. `revert` now
  removes the router and restores the extension-host file too, which `apply` now
  captures a baseline for.
- **Glob was sent as a regular expression.** Cursor has a `globToolCall` but no glob
  exec: a Glob runs as a Grep with the glob as a filter and an empty pattern.
  Putting `**/*.md` in `pattern` made ripgrep reject it with a parse error. The call
  now matches Cursor's own implementation, including the retry with `pattern: "."`
  that ripgrep requires when the pattern is empty.
- A Glob result is read from `workspace_results.files`, where a grep-shaped result
  puts the file list, instead of from the top level where it never appears.
- The "Cursor worktree" note in `user_info` appeared for every workspace, because the
  module that decides it was a stub. It now uses the real check, so the note only
  appears for a path under `.cursor/worktrees`.

### Changed

- `src/ccursor.js` is gone; `inject.js` reports which extension hosts carry the
  router, next to the code that puts it there.
- `apply` removes a renderer hook that an earlier installer wrote into the workbench
  bundle. It is third-party code that nothing here uses, and `status` reports it as
  `foreign hook` instead of the old `hook injected` line.

### Removed

- The leftover third-party package cache in the state directory is no longer used by
  anything and has been deleted.

## [2.0.0] - 2026-10-26

Ported from Python to Node.js. Zero runtime dependencies, no build step, no
virtualenv — `node:sqlite` replaces the external driver.

### Added

- `alias` command, and a `doctor` check for it. Cursor sends `modelId: "default"`
  for Auto, and a fresh composer starts on Auto, so without an alias every such
  turn fails with "Model default was not found in providers.json". The alias points
  at the primary model through `apiModel`, and the catalog builder skips it so the
  picker keeps a single Auto entry.
- Seeding now pins every composer mode to the primary model, so new composers no
  longer start on Auto. The earlier Python version did this; the port had dropped
  it.
- **Catalog seeding.** Writes `providers.json` models into Cursor's
  `state.vscdb` before launch, which removes the startup race that made the
  picker fall back to Auto. Refuses to run while Cursor is open, because Cursor
  overwrites the row from memory.
- `rule` command, printing or appending the agent rule that keeps multi-file
  `Write` calls from merging two files into one.
- `docs/tool-calling.md`, documenting the merged-file failure with the transport
  evidence that rules it out.
- `doctor` now checks the seeded catalog path and reports a running-Cursor
  conflict.

### Fixed

- The CLI did nothing when invoked through a symlink: the entry-point guard compared
  `process.argv[1]` with the module path using `path.resolve`, which does not follow
  symlinks, so `main()` never ran and the process exited 0. `npm link`, documented in
  the README, hits exactly this. Now compares real paths via `fileURLToPath`.
- The BYOK toggle constant was assembled from the wrong parts and produced a bogus
  field name with literal brackets. Seeding wrote that field while Cursor's real
  toggle stayed `false`, so Cursor kept treating the account as not using a key and
  pruned the seeded models on the next reconcile. Seeding now sets the real field and
  deletes the bogus one; the exact bytes are pinned by a test.
- `run` consumed flags meant for Cursor: `cursor-byok run --appimage x` swallowed
  the argument instead of forwarding it. `run` now takes no options of its own and
  passes every trailing token to the launcher, since Cursor's flag set is not ours
  to enumerate.
- `rule --write` keyed its presence check on the rule's heading, so a project that
  restated the guidance under its own heading got a duplicate appended. The check
  now uses a phrase from the rule body, and the append is verified idempotent.

### Changed

- Patch anchors now bound the span they rewrite, so a wide backward search cannot
  swallow an unrelated expression.
- `revert` keeps baselines, so a later `apply` captures from pristine bytes rather
  than from a hook-injected bundle.
- `run` launches Cursor detached, so a desktop launcher does not linger as its
  parent process.

### Removed

- The Python package, `pyproject.toml`, and the pytest suite.

## [1.0.0] - 2026-10-26

First release, extracted from a working setup on Cursor 3.27.12 (Linux x86_64).

### Added

- `apply` — patches the two workbench guards that disable BYOK, synchronises
  `cursor.general.disableHttp2` and `routes.json`, refreshes bundle checksums.
  Idempotent, with `--dry-run` and `--skip-installer`.
- `status` — reports hook, both guards, router, extension, HTTP setting, port,
  provider count, and live server health.
- `doctor` — diagnoses a broken setup and prints the fixing command.
- `revert` — restores the pristine bundles captured before the first write.
- `run` — detects a Cursor update via bundle mtimes and re-applies before launching.
- `update` — extracts a new AppImage to a staging tree, patches it, syntax-checks it,
  then swaps it in; `--rollback` restores the previous tree.
- Structural patch anchors with validation, so an unexpected bundle shape fails
  loudly instead of corrupting the install.
- Baseline and per-write snapshot storage under `~/.cursor-byok-patch`.

[2.0.0]: https://github.com/fahmiirsyadk/ccursor/releases/tag/v2.0.0
[1.0.0]: https://github.com/fahmiirsyadk/ccursor/releases/tag/v1.0.0

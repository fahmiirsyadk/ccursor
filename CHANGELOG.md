# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Test suite covering both patches, idempotency, anchor misses, discovery, and
  config synchronisation.

### Known limitations

- Update and launcher helpers target Linux AppImage installs; patching itself is
  platform-independent via `CURSOR_APP_ROOT`.
- Models that never stop calling tools need a bounded prompt; this is model
  behaviour, not a transport issue.
- Pinned to `@cometix/ccursor@0.0.15`. Newer upstream releases are untested.

[1.0.0]: https://github.com/fahmiirsyadk/ccursor/releases/tag/v1.0.0

# Contributing

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
make test
```

## What needs care

**The patch anchors.** `src/cursor_byok/bundles.py` is the part that breaks when
Cursor changes. If you touch it:

- Anchor on structure, not on minified names. Names change every release.
- Keep the validation in place. A patch that matches too loosely will corrupt a
  bundle; failing loudly is always better.
- Add a fixture to `tests/test_bundles.py` that reproduces the new shape.

**Bundle writes.** Never write without a baseline and a snapshot first. `revert` is
the only safety net a user has.

## Testing a change against a real install

```bash
cursor-byok apply --dry-run --skip-installer   # reports, writes nothing
cursor-byok apply --skip-installer             # writes, keeps snapshots
cursor-byok doctor                             # end-to-end check
cursor-byok revert                             # back to pristine
```

Extract a throwaway tree to test without touching your daily install:

```bash
mkdir -p /tmp/cursor-test && cd /tmp/cursor-test
~/Applications/Cursor.AppImage --appimage-extract
CURSOR_APP_ROOT=/tmp/cursor-test/squashfs-root/usr/share/cursor/resources/app \
  cursor-byok apply --skip-installer
```

## Pull requests

- Keep changes focused; one concern per PR.
- Update the relevant doc when behaviour changes: `README.md`,
  `docs/how-it-works.md`, `docs/troubleshooting.md`.
- Tests must pass: `make test`.
- If your change depends on a specific Cursor build, say which one in the PR
  description.

## Reporting a broken anchor

Open an issue with:

- Cursor version (`cursor-byok status`)
- the output of `cursor-byok doctor`
- for anchor failures, the ~200 bytes around the marker:

```bash
python3 - <<'EOF'
import pathlib, os
root = pathlib.Path(os.environ["CURSOR_APP_ROOT"])
data = (root/"out/vs/workbench/workbench.desktop.main.js").read_bytes()
for needle in (b"subscriptionChangedListener=", b"action=disable-openai-key"):
    i = data.find(needle)
    print(needle.decode(), "->", i)
    if i >= 0:
        print(data[max(0, i-200):i+200])
EOF
```

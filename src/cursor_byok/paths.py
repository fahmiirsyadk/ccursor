"""Filesystem layout of the project and of the files it touches."""

from __future__ import annotations

import json
import os
from pathlib import Path

HOME = Path.home()

#: our own state: baselines, backups and the update marker
STATE_DIR = Path(os.environ.get("CURSOR_BYOK_STATE", HOME / ".cursor-byok-patch"))
BASELINE_DIR = STATE_DIR / "baselines"
BACKUP_DIR = STATE_DIR / "backups"
MARKER = STATE_DIR / "applied.json"

#: configuration owned by the upstream @cometix/ccursor extension
CCURSOR_DIR = HOME / ".ccursor"
ROUTES = CCURSOR_DIR / "routes.json"
PROVIDERS = CCURSOR_DIR / "providers.json"

#: Cursor's own settings file
SETTINGS = HOME / ".config" / "Cursor" / "User" / "settings.json"

#: where we keep a patched Cursor install
DEFAULT_INSTALL_DIR = HOME / "Applications" / "CursorByok"

#: port the BYOK server listens on; must match routes.json
DEFAULT_PORT = 39831

#: bundles we patch, in order
BUNDLES = ("workbench.desktop.main.js", "workbench.glass.main.js")

#: sentinel written by the ccursor installer when it injects the hook
HOOK_MARKER = b"CURSOR-BYOK-HOOK-START"


def read_json(path: Path):
    """Return parsed JSON, or None when the file is missing or malformed."""
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")

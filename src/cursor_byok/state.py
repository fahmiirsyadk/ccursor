"""Baselines, backups and the marker that detects a Cursor update.

Three pieces of local state live under ``~/.cursor-byok-patch``:

``baselines/``
    Copy of each bundle as Cursor shipped it, captured before anything rewrites it
    -- including the upstream hook installer. ``revert`` restores from here, so it
    works even after several patch cycles.

``backups/``
    Copy taken immediately before each write. Useful when a baseline predates the
    current Cursor version and revert would otherwise downgrade it.

``applied.json``
    The bundle mtimes at the moment patching finished. If a bundle's mtime later
    changes, Cursor was updated and the patch is gone -- which is exactly what
    ``run`` uses to decide whether to re-apply before launching.
"""

from __future__ import annotations

import shutil
import time
from pathlib import Path

from .paths import BACKUP_DIR, BASELINE_DIR, MARKER, read_json, write_json
from .ui import detail


def _stamp() -> str:
    return time.strftime("%Y%m%dT%H%M%S")


def capture_baseline(path: Path) -> Path:
    """Copy a pristine bundle once. Never overwritten afterwards."""
    BASELINE_DIR.mkdir(parents=True, exist_ok=True)
    target = BASELINE_DIR / path.name
    if not target.exists():
        shutil.copy2(path, target)
        detail(f"baseline {target}")
    return target


def snapshot(path: Path) -> Path:
    """Timestamped copy taken right before a write."""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    target = BACKUP_DIR / f"{path.name}.{_stamp()}"
    shutil.copy2(path, target)
    detail(f"backup {target.name}")
    return target


def restore_baseline(path: Path) -> bool:
    source = BASELINE_DIR / path.name
    if not source.exists():
        return False
    shutil.copy2(source, path)
    return True


def latest_snapshot(path: Path) -> Path | None:
    if not BACKUP_DIR.is_dir():
        return None
    matches = sorted(BACKUP_DIR.glob(f"{path.name}.*"), key=lambda p: p.name)
    return matches[-1] if matches else None


def write_marker(app_root: Path, bundles: list[Path], version: str | None) -> None:
    payload = {
        "app_root": str(app_root),
        "version": version,
        "applied_at": time.time(),
        "bundles": {path.name: path.stat().st_mtime for path in bundles},
    }
    write_json(MARKER, payload)


def marker_is_fresh(app_root: Path, bundles: list[Path]) -> bool:
    """True when the recorded state still matches what is on disk."""
    data = read_json(MARKER)
    if not isinstance(data, dict):
        return False
    if data.get("app_root") != str(app_root):
        return False
    recorded = data.get("bundles")
    if not isinstance(recorded, dict):
        return False
    for path in bundles:
        if recorded.get(path.name) != path.stat().st_mtime:
            return False
    return True


def read_marker() -> dict:
    data = read_json(MARKER)
    return data if isinstance(data, dict) else {}


def clear() -> None:
    for directory in (BASELINE_DIR, BACKUP_DIR):
        if directory.is_dir():
            shutil.rmtree(directory, ignore_errors=True)
    if MARKER.exists():
        MARKER.unlink()


def describe_marker() -> str:
    data = read_marker()
    if not data:
        return "no marker (never applied here)"
    applied = data.get("applied_at")
    when = time.strftime("%Y-%m-%d %H:%M", time.localtime(applied)) if applied else "?"
    return f"applied {when} against {data.get('version', '?')}"

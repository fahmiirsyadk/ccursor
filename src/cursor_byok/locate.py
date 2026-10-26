"""Find the Cursor installation to patch.

Cursor ships as an AppImage, a .deb, a .rpm, or an extracted directory. In every
case the JavaScript we patch lives under ``resources/app``. This module resolves
that directory and reports enough detail for ``doctor`` to explain a failure.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


#: directories checked, in order, before any filesystem scan
STATIC_CANDIDATES = (
    "/opt/Cursor/resources/app",
    "/opt/cursor/resources/app",
    "/usr/share/cursor/resources/app",
    "/usr/lib/cursor/resources/app",
    "~/.local/share/cursor/resources/app",
    "~/Applications/CursorByok/squashfs-root/usr/share/cursor/resources/app",
    "~/Applications/squashfs-root/usr/share/cursor/resources/app",
)

#: roots scanned for ``*/squashfs-root/usr/share/cursor/resources/app``
SCAN_ROOTS = ("~", "/tmp", "/opt")


@dataclass
class Candidate:
    path: Path
    status: str  # ok | partial | missing


@dataclass
class Discovery:
    app_root: Path | None = None
    version: str | None = None
    candidates: list[Candidate] = field(default_factory=list)
    hint: str | None = None

    @property
    def found(self) -> bool:
        return self.app_root is not None


def _home() -> Path:
    """Resolved per call so tests and alternate HOMEs behave predictably."""
    return Path.home()


def _expand(raw: str) -> Path:
    if raw.startswith("~"):
        return _home() / raw[2:]
    return Path(raw)


def _is_app_root(path: Path) -> bool:
    return (path / "product.json").is_file() and (
        path / "out/vs/workbench/workbench.desktop.main.js"
    ).is_file()


def candidate_paths() -> list[Path]:
    """All plausible ``resources/app`` directories, most likely first."""
    seen: set[Path] = set()
    ordered: list[Path] = []

    def push(path: Path) -> None:
        try:
            resolved = path.resolve()
        except OSError:
            return
        if resolved not in seen:
            seen.add(resolved)
            ordered.append(resolved)

    override = os.environ.get("CURSOR_APP_ROOT")
    if override:
        push(Path(override))
    install_dir = _home() / "Applications" / "CursorByok"
    if install_dir.exists():
        push(install_dir / "squashfs-root/usr/share/cursor/resources/app")
    for raw in STATIC_CANDIDATES:
        push(_expand(raw))
    for raw in SCAN_ROOTS:
        root = _expand(raw)
        try:
            for match in root.glob("*/squashfs-root/usr/share/cursor/resources/app"):
                push(match)
        except OSError:
            continue
    return ordered


def discover() -> Discovery:
    """Locate a patchable Cursor install and describe every path we tried."""
    result = Discovery()
    partial: Path | None = None

    for path in candidate_paths():
        if not (path / "product.json").is_file():
            result.candidates.append(Candidate(path, "missing"))
            continue
        if _is_app_root(path):
            result.candidates.append(Candidate(path, "ok"))
            result.app_root = path
            result.version = _read_version(path)
            return result
        result.candidates.append(Candidate(path, "partial"))
        partial = partial or path

    if partial is not None:
        result.hint = (
            f"found an install at {partial} but workbench.desktop.main.js is missing; "
            "the layout may have changed or the extraction is incomplete"
        )
    else:
        result.hint = (
            "no Cursor install found. Set CURSOR_APP_ROOT to the resources/app "
            "directory, e.g. CURSOR_APP_ROOT=~/Applications/CursorByok/"
            "squashfs-root/usr/share/cursor/resources/app"
        )
    return result


def _read_version(app_root: Path) -> str | None:
    from .paths import read_json

    product = read_json(app_root / "product.json")
    if isinstance(product, dict):
        version = product.get("version")
        if isinstance(version, str):
            return version
    return None


def cursor_binary(app_root: Path) -> Path | None:
    """The launcher that sits beside ``resources/``."""
    for candidate in (
        app_root.parent.parent / "cursor",
        app_root.parent / "cursor",
    ):
        if candidate.is_file():
            return candidate
    return None

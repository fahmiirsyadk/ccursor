"""Update a patched Cursor install from a fresh AppImage.

A Cursor update replaces every file we patched, so the sequence is: extract the
new AppImage into a staging directory, patch the staging copy, verify it, and only
then swap it into place. The previous tree is kept so a bad build can be rolled
back without re-downloading anything.

    ~/Applications/Cursor.AppImage  ->  extract  ->  patch  ->  verify  ->  swap
                                                                  |
                                                                  +-- .old kept
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

from . import bundles, ccursor, settings, state
from .paths import HOME
from .ui import detail, fail, info, ok, warn

DEFAULT_APPIMAGE = HOME / "Applications" / "Cursor.AppImage"
EXTRACTED = "squashfs-root"
APP_SUFFIX = "usr/share/cursor/resources/app"


class UpdateError(RuntimeError):
    pass


def appimage_path(explicit: str | None) -> Path:
    path = Path(explicit).expanduser() if explicit else DEFAULT_APPIMAGE
    if not path.is_file():
        raise UpdateError(f"AppImage not found: {path}")
    return path


def extract(appimage: Path, destination: Path) -> Path:
    """Run ``--appimage-extract`` inside ``destination``; return the app root."""
    destination.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [str(appimage), "--appimage-extract"],
        cwd=destination,
        capture_output=True,
        text=True,
        timeout=900,
    )
    if result.returncode != 0:
        raise UpdateError(
            "extraction failed: "
            + (result.stderr or result.stdout).strip().splitlines()[-1:][0]
            if (result.stderr or result.stdout).strip()
            else "extraction failed"
        )
    root = destination / EXTRACTED / APP_SUFFIX
    if not (root / "product.json").is_file():
        raise UpdateError(f"unexpected layout after extraction: {root}")
    return root


def patch_tree(app_root: Path, *, install_hook: bool = True) -> None:
    """Apply every patch to a tree, raising on the first problem."""
    # Baseline first: the upstream installer rewrites these bundles, so capturing
    # after it would make revert restore a hook-injected file instead of the one
    # Cursor shipped.
    for path in bundles.bundle_paths(app_root):
        state.capture_baseline(path)

    if install_hook and not ccursor.install(app_root):
        raise UpdateError("hook installer failed")

    for path in bundles.bundle_paths(app_root):
        outcome = bundles.patch_bundle(path)
        if not outcome.changed and outcome.subscription == "not-found":
            raise UpdateError(f"{path.name}: patch anchors not found")

    settings.refresh_checksums(app_root, bundles.bundle_paths(app_root))
    settings.ensure_settings()
    settings.ensure_routes()


def verify_tree(app_root: Path) -> None:
    """Fail early rather than swap in a tree that will not start."""
    node = shutil.which("node")
    for path in bundles.bundle_paths(app_root):
        data = path.read_bytes()
        if not bundles.subscription_patched(data):
            raise UpdateError(f"{path.name}: subscription patch missing after apply")
        if not bundles.admin_policy_patched(data):
            raise UpdateError(f"{path.name}: admin policy patch missing after apply")
        if node is None:
            continue
        check = subprocess.run([node, "--check", str(path)], capture_output=True)
        if check.returncode != 0:
            raise UpdateError(
                f"{path.name}: syntax error after patch: "
                + check.stderr.decode(errors="replace").splitlines()[:2][-1]
            )


def swap(install_dir: Path, staged: Path) -> Path:
    """Replace ``install_dir/squashfs-root`` with the staged tree."""
    live = install_dir / EXTRACTED
    previous = install_dir / (EXTRACTED + ".old")
    if previous.exists():
        shutil.rmtree(previous, ignore_errors=True)
    if live.exists():
        live.rename(previous)
    try:
        staged.rename(live)
    except OSError:
        if previous.exists():
            previous.rename(live)  # put the old tree back
        raise
    return previous


def rollback(install_dir: Path) -> bool:
    live = install_dir / EXTRACTED
    previous = install_dir / (EXTRACTED + ".old")
    if not previous.exists():
        return False
    if live.exists():
        shutil.rmtree(live, ignore_errors=True)
    previous.rename(live)
    return True


def run(appimage: str | None, install_dir: Path, *, keep_old: bool = True) -> int:
    try:
        source = appimage_path(appimage)
    except UpdateError as exc:
        fail(str(exc))
        return 1

    info(f"source: {source}")
    info(f"target: {install_dir / EXTRACTED}")

    # Stage on the same filesystem as the target: rename() cannot cross devices,
    # and a 1+ GB tree does not belong in tmpfs.
    install_dir.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".cursor-byok-staging-", dir=install_dir))
    try:
        info("extracting")
        app_root = extract(source, staging)
        version = None
        try:
            import json

            version = json.loads((app_root / "product.json").read_text()).get("version")
        except Exception:
            pass
        detail(f"version {version}")

        info("patching staged tree")
        patch_tree(app_root)
        verify_tree(app_root)
        ok("staged tree verified")

        previous = swap(install_dir, staging / EXTRACTED)
        detail(f"previous tree kept at {previous}")

        live_root = install_dir / EXTRACTED / APP_SUFFIX
        state.write_marker(live_root, bundles.bundle_paths(live_root), version)

        if not keep_old:
            shutil.rmtree(previous, ignore_errors=True)

        print()
        ok(f"updated to {version}")
        detail("roll back with: cursor-byok update --rollback")
        return 0
    except UpdateError as exc:
        fail(str(exc))
        warn("nothing was swapped; the existing install is untouched")
        return 1
    finally:
        shutil.rmtree(staging, ignore_errors=True)

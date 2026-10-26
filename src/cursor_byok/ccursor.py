"""Run the upstream @cometix/ccursor installer.

That installer does the heavy lifting: it injects the renderer hook, installs the
BYOK extension, and patches the HTTP/1.1 router into ``cursor-agent-host`` and
``cursor-always-local``. We delegate rather than reimplement so upstream fixes
keep flowing in, and we pin the version we have tested against.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from .ui import detail, fail, info, ok

PACKAGE = "@cometix/ccursor@0.0.15"
TIMEOUT_SECONDS = 600


def _runner() -> str | None:
    return shutil.which("npx") or shutil.which("bunx")


def available() -> bool:
    return _runner() is not None


def install(app_root: Path, *, quiet: bool = False) -> bool:
    """Install or repair the hook + router. Returns True on success."""
    runner = _runner()
    if runner is None:
        fail("npx not found; install Node.js 18+ or run the installer yourself")
        return False

    if not quiet:
        info(f"installing {PACKAGE}")

    env = dict(os.environ)
    env["CCURSOR_CURSOR_ROOT"] = str(app_root)

    try:
        result = subprocess.run(
            [runner, "-y", PACKAGE, "install"],
            env=env,
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        fail(f"installer timed out after {TIMEOUT_SECONDS}s")
        return False
    except OSError as exc:
        fail(f"could not start the installer: {exc}")
        return False

    if result.returncode != 0:
        fail("installer failed")
        for line in (result.stderr or result.stdout).splitlines()[-6:]:
            if line.strip():
                detail(line)
        return False

    if not quiet:
        summary = [ln for ln in result.stdout.splitlines() if ln.strip()][-3:]
        for line in summary:
            detail(line)
        ok("hook and router installed")
    return True


def extension_present(app_root: Path) -> bool:
    return (app_root / "extensions" / "cursor2plus").is_dir()


def routers_present(app_root: Path) -> tuple[bool, bool]:
    """(always-local, agent-host) -- both must carry the router marker."""
    marker = b"BYOK-HTTP11-ROUTER-V2"
    always_local = app_root / "extensions/cursor-always-local/dist/main.js"
    agent_host = app_root / "extensions/cursor-agent-host/dist/main.js"

    def has(path: Path) -> bool:
        try:
            return marker in path.read_bytes()
        except OSError:
            return False

    return has(always_local), has(agent_host)

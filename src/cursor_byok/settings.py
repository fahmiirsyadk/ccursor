"""Configuration Cursor and the BYOK extension need in order to cooperate.

Two settings decide whether BYOK traffic ever reaches the local server:

``cursor.general.disableHttp2``
    Cursor's transport factory picks HTTP/2 whenever this is false. The BYOK
    router only hooks ``http.request``/``https.request``, so an HTTP/2 session
    bypasses it and the request goes to Cursor's backend instead -- which is what
    produces "Protocol error" or "Server error" on every agent turn. Forcing
    HTTP/1.1 keeps the traffic on the hookable path.

``routes.json -> server.port``
    The extension listens on this port and the router forwards to it. If a stale
    override in ``settings.json`` disagrees, redirects land on a closed port.
"""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

from .paths import DEFAULT_PORT, PROVIDERS, ROUTES, SETTINGS, read_json, write_json
from .ui import detail, ok, warn

DISABLE_HTTP2 = "cursor.general.disableHttp2"
PORT_OVERRIDE = "cursor2plus.server.port"

#: keys we refuse to invent; Cursor validates this file strictly
_REQUIRED_ROUTE_KEYS = ("redirect", "server")


def ensure_settings() -> str:
    """Force HTTP/1.1 and drop any port override that fights routes.json."""
    current = read_json(SETTINGS)
    if not isinstance(current, dict):
        if SETTINGS.exists():
            warn(f"{SETTINGS} is not valid JSON; leaving it alone")
            return "invalid"
        current = {}

    changed = False
    if current.get(DISABLE_HTTP2) is not True:
        current[DISABLE_HTTP2] = True
        changed = True
    if PORT_OVERRIDE in current:
        current.pop(PORT_OVERRIDE)
        changed = True

    if changed:
        write_json(SETTINGS, current)
        ok(f"settings.json: {DISABLE_HTTP2} = true")
        return "patched"
    detail(f"settings.json already correct ({DISABLE_HTTP2})")
    return "already"


def ensure_routes() -> str:
    """Make routes.json agree with the port the extension actually uses."""
    current = read_json(ROUTES)
    if not isinstance(current, dict):
        warn(f"{ROUTES} missing or unreadable; run 'cursor-byok apply' with the installer")
        return "missing"

    if not all(key in current for key in _REQUIRED_ROUTE_KEYS):
        warn(f"{ROUTES} does not look like a ccursor routes file; skipping")
        return "unexpected"

    server = current.setdefault("server", {})
    if not isinstance(server, dict):
        warn(f"{ROUTES}: 'server' is not an object; skipping")
        return "unexpected"

    changed = False
    if server.get("port") != DEFAULT_PORT:
        server["port"] = DEFAULT_PORT
        changed = True
    if not server.get("host"):
        server["host"] = "127.0.0.1"
        changed = True
    if current.get("byokMode") != 1:
        current["byokMode"] = 1
        changed = True

    if changed:
        write_json(ROUTES, current)
        ok(f"routes.json: server.port -> {DEFAULT_PORT}")
        return "patched"
    detail(f"routes.json ok (port {DEFAULT_PORT})")
    return "already"


def describe_providers() -> str:
    """One-line summary of configured providers, for status output."""
    data = read_json(PROVIDERS)
    if not isinstance(data, dict):
        return "missing"
    providers = data.get("providers")
    if not isinstance(providers, list):
        return "malformed"
    if not providers:
        return "empty"
    names = [str(p.get("id", "?")) for p in providers if isinstance(p, dict)]
    return f"{len(names)} ({', '.join(names)})"


def refresh_checksums(app_root: Path, files: list[Path]) -> int:
    """Rewrite product.json checksums for bundles we modified.

    Cursor verifies these on start. Stale entries do not stop the app, but they
    produce integrity warnings; keeping them current keeps the log clean.
    """
    product_path = app_root / "product.json"
    product = read_json(product_path)
    if not isinstance(product, dict):
        return 0
    checksums = product.get("checksums")
    if not isinstance(checksums, dict):
        return 0

    out_root = app_root / "out"
    updated = 0
    for path in files:
        try:
            key = str(path.relative_to(out_root)).replace("\\", "/")
        except ValueError:
            continue
        if key not in checksums:
            continue
        digest = hashlib.sha256(path.read_bytes()).digest()
        checksums[key] = base64.b64encode(digest).decode().rstrip("=")
        updated += 1

    if updated:
        product_path.write_text(json.dumps(product, indent=2) + "\n")
    return updated

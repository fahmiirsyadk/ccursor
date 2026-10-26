"""Command line interface.

Subcommands are deliberately small and composable:

    apply    patch an existing install (idempotent)
    status   report what is currently in effect
    doctor   explain why something is not working
    revert   restore the bundles Cursor shipped with
    run      re-apply if needed, then launch Cursor
    update   extract, patch and swap in a new AppImage
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from . import __version__, bundles, ccursor, settings, state, update
from .locate import cursor_binary, discover
from .paths import (
    DEFAULT_INSTALL_DIR,
    DEFAULT_PORT,
    HOOK_MARKER,
    PROVIDERS,
    ROUTES,
    SETTINGS,
)
from .ui import detail, fail, heading, info, ok, warn

DISABLE_HTTP2_KEY = settings.DISABLE_HTTP2


# --------------------------------------------------------------------- helpers

def _require_install():
    found = discover()
    if not found.found:
        fail("Cursor installation not found")
        for candidate in found.candidates:
            mark = {"ok": "+", "partial": "~", "missing": "-"}[candidate.status]
            detail(f"{mark} {candidate.path}")
        if found.hint:
            warn(found.hint)
        return None
    return found


def _health(port: int = DEFAULT_PORT) -> str:
    """Ask the local BYOK server whether it is up."""
    try:
        import urllib.request

        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/health", timeout=2
        ) as response:
            return "up" if response.status == 200 else f"http {response.status}"
    except Exception:
        return "down"


# ------------------------------------------------------------------- commands

def cmd_apply(args) -> int:
    found = _require_install()
    if found is None:
        return 1

    app_root = found.app_root
    info(f"app root: {app_root}")
    detail(f"version {found.version or 'unknown'}")

    if not args.skip_installer and not ccursor.install(app_root):
        warn("continuing without the hook installer; transport will not work")

    paths = bundles.bundle_paths(app_root)
    if not paths:
        fail("no workbench bundles found")
        return 1

    changed: list[Path] = []
    try:
        for path in paths:
            data = path.read_bytes()
            already = bundles.subscription_patched(data)

            if args.dry_run:
                _, sub = bundles.patch_subscription(data)
                _, admin = bundles.patch_admin_policy(data)
                outcome = bundles.PatchOutcome(path, sub, admin, False)
            else:
                # A baseline is only useful if it is pristine. Capturing one from
                # an already-patched bundle would make revert a no-op.
                if already:
                    warn(f"{path.name}: already patched, keeping the existing baseline")
                else:
                    state.capture_baseline(path)
                state.snapshot(path)
                outcome = bundles.patch_bundle(path)

            ok(f"{path.name}: subscription={outcome.subscription} admin={outcome.admin_policy}")
            if outcome.changed:
                changed.append(path)
    except bundles.PatchError as exc:
        fail(str(exc))
        return 1

    if args.dry_run:
        detail("dry run: nothing written")
        return 0

    if changed:
        updated = settings.refresh_checksums(app_root, changed)
        if updated:
            detail(f"refreshed {updated} checksum(s)")

    settings.ensure_settings()
    settings.ensure_routes()
    state.write_marker(app_root, paths, found.version)

    heading("result")
    ok("patched — restart Cursor")
    detail(f"then confirm the BYOK toggle is on, and that {PROVIDERS} lists your model")
    detail(f"health check: curl -s http://127.0.0.1:{DEFAULT_PORT}/health")
    return 0


def cmd_status(args) -> int:
    found = _require_install()
    if found is None:
        return 1

    app_root = found.app_root
    info(f"app root: {app_root}")
    detail(f"version {found.version or 'unknown'}")
    detail(state.describe_marker())

    always_local, agent_host = ccursor.routers_present(app_root)
    ext = ccursor.extension_present(app_root)

    for path in bundles.bundle_paths(app_root):
        data = path.read_bytes()
        hook = HOOK_MARKER in data
        heading(path.name)
        print(f"  hook injected       : {'yes' if hook else 'NO'}")
        print(
            "  subscription guard  : "
            + ("neutralised" if bundles.subscription_patched(data) else "VULNERABLE")
        )
        print(
            "  admin policy guard  : "
            + ("neutralised" if bundles.admin_policy_patched(data) else "VULNERABLE")
        )

    heading("transport")
    print(f"  BYOK extension      : {'installed' if ext else 'MISSING'}")
    print(f"  router always-local : {'yes' if always_local else 'NO'}")
    print(f"  router agent-host   : {'yes' if agent_host else 'NO'}")

    heading("configuration")
    cfg = settings.read_json(SETTINGS)
    http2 = cfg.get(DISABLE_HTTP2_KEY) if isinstance(cfg, dict) else None
    print(f"  disableHttp2        : {http2}")
    routes = settings.read_json(ROUTES)
    port = routes.get("server", {}).get("port") if isinstance(routes, dict) else None
    print(f"  routes.json port    : {port}")
    print(f"  providers           : {settings.describe_providers()}")
    print(f"  BYOK server         : {_health(port or DEFAULT_PORT)}")
    return 0


def cmd_doctor(args) -> int:
    found = _require_install()
    if found is None:
        return 1

    app_root = found.app_root
    info(f"app root: {app_root}")
    problems: list[str] = []
    notes: list[str] = []

    for path in bundles.bundle_paths(app_root):
        data = path.read_bytes()
        if HOOK_MARKER not in data:
            problems.append(f"{path.name}: renderer hook missing -> run apply")
        if not bundles.subscription_patched(data):
            problems.append(f"{path.name}: subscription guard active -> BYOK turns itself off")
        if not bundles.admin_policy_patched(data):
            problems.append(f"{path.name}: admin policy guard active -> BYOK reset on policy")

    always_local, agent_host = ccursor.routers_present(app_root)
    if not always_local or not agent_host:
        problems.append("HTTP/1.1 router missing in one or both extension hosts -> run apply")
    if not ccursor.extension_present(app_root):
        problems.append("BYOK extension not installed -> run apply")

    cfg = settings.read_json(SETTINGS)
    if not isinstance(cfg, dict) or cfg.get(DISABLE_HTTP2_KEY) is not True:
        problems.append("cursor.general.disableHttp2 is not true -> agent turns will fail")

    routes = settings.read_json(ROUTES)
    port = routes.get("server", {}).get("port") if isinstance(routes, dict) else None
    if port is None:
        problems.append("routes.json missing -> run apply")
    elif _health(port) != "up":
        problems.append(f"BYOK server not responding on port {port} -> is Cursor running?")

    provider_state = settings.describe_providers()
    if provider_state in ("missing", "empty", "malformed"):
        problems.append(f"{PROVIDERS} has no providers -> add one before sending a message")

    if os.environ.get("CURSOR_API_BASE_URL"):
        notes.append(
            "CURSOR_API_BASE_URL is set; unset it. The router rewrites URLs itself, "
            "and this variable pushes HTTP/2 traffic to a plain HTTP server."
        )

    heading("checks")
    if not problems:
        ok("no problems found")
    for problem in problems:
        fail(problem)
    for note in notes:
        warn(note)
    if problems:
        heading("next step")
        detail("cursor-byok apply")
        return 1
    return 0


def cmd_revert(args) -> int:
    found = _require_install()
    if found is None:
        return 1

    app_root = found.app_root
    restored = 0
    for path in bundles.bundle_paths(app_root):
        if state.restore_baseline(path):
            ok(f"restored {path.name}")
            restored += 1
        else:
            warn(f"no baseline for {path.name}; leaving it as is")
    if restored:
        settings.refresh_checksums(app_root, bundles.bundle_paths(app_root))
        # Keep baselines: a later apply must capture from them, not from whatever
        # the hook installer leaves behind. Remove them explicitly if you want to.
    heading("result")
    ok("reverted — restart Cursor")
    return 0


def cmd_run(args) -> int:
    """Launch Cursor, re-applying patches first if an update wiped them."""
    found = _require_install()
    if found is None:
        return 1

    app_root = found.app_root
    paths = bundles.bundle_paths(app_root)

    stale = not state.marker_is_fresh(app_root, paths)
    if stale:
        info("patch state stale (Cursor was updated?) — re-applying")
        rc = cmd_apply(argparse.Namespace(skip_installer=False, dry_run=False))
        if rc != 0:
            warn("re-apply failed; launching anyway")

    binary = cursor_binary(app_root)
    if binary is None:
        fail(f"cursor launcher not found next to {app_root}")
        return 1

    env = dict(os.environ)
    env.pop("CURSOR_API_BASE_URL", None)
    env.pop("CURSOR_WEBSITE_URL", None)
    os.execve(str(binary), [str(binary), *getattr(args, "forward", [])], env)


def cmd_update(args) -> int:
    install_dir = Path(args.install_dir).expanduser() if args.install_dir else DEFAULT_INSTALL_DIR

    if args.rollback:
        if update.rollback(install_dir):
            ok("rolled back to the previous tree")
            return 0
        fail("no previous tree to roll back to")
        return 1

    return update.run(args.appimage, install_dir, keep_old=not args.drop_old)


# ----------------------------------------------------------------------- parser

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cursor-byok",
        description="Keep bring-your-own-key working in Cursor across updates.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command")

    apply_cmd = sub.add_parser("apply", help="patch an existing install (idempotent)")
    apply_cmd.add_argument("--skip-installer", action="store_true",
                           help="do not run the @cometix/ccursor installer")
    apply_cmd.add_argument("--dry-run", action="store_true",
                           help="report what would change without writing")
    apply_cmd.set_defaults(func=cmd_apply)

    status_cmd = sub.add_parser("status", help="report what is currently in effect")
    status_cmd.set_defaults(func=cmd_status)

    doctor_cmd = sub.add_parser("doctor", help="diagnose a broken setup")
    doctor_cmd.set_defaults(func=cmd_doctor)

    revert_cmd = sub.add_parser("revert", help="restore the bundles Cursor shipped")
    revert_cmd.set_defaults(func=cmd_revert)

    run_cmd = sub.add_parser("run", help="re-apply if needed, then launch Cursor")
    run_cmd.set_defaults(func=cmd_run)

    update_cmd = sub.add_parser("update", help="extract, patch and swap in a new AppImage")
    update_cmd.add_argument("--appimage", help="path to the new AppImage")
    update_cmd.add_argument("--install-dir", help=f"where the patched tree lives "
                                                 f"(default: {DEFAULT_INSTALL_DIR})")
    update_cmd.add_argument("--drop-old", action="store_true",
                            help="delete the previous tree after a successful swap")
    update_cmd.add_argument("--rollback", action="store_true",
                            help="restore the previous tree and exit")
    update_cmd.set_defaults(func=cmd_update)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    # Cursor's own flags (--inspect, --no-sandbox, ...) are not ours to define, so
    # collect them and hand them to the launcher instead of rejecting them.
    args, extras = parser.parse_known_args(argv)
    if not getattr(args, "command", None):
        parser.print_help()
        return 2
    if args.command == "run":
        args.forward = extras
    elif extras:
        parser.error(f"unrecognized arguments: {' '.join(extras)}")
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

"""Discovery and configuration behaviour, using temporary directories."""

from __future__ import annotations

import json
from pathlib import Path

from cursor_byok import locate, settings
from cursor_byok.locate import discover


def make_app_root(base: Path) -> Path:
    root = base / "usr/share/cursor/resources/app"
    (root / "out/vs/workbench").mkdir(parents=True)
    (root / "product.json").write_text(json.dumps({"version": "9.9.9"}))
    (root / "out/vs/workbench/workbench.desktop.main.js").write_text("// bundle")
    return root


def test_discover_honours_env_override(tmp_path, monkeypatch) -> None:
    root = make_app_root(tmp_path)
    monkeypatch.setenv("CURSOR_APP_ROOT", str(root))

    found = discover()

    assert found.found
    assert found.app_root == root.resolve()
    assert found.version == "9.9.9"


def test_discover_reports_missing(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("CURSOR_APP_ROOT", str(tmp_path / "nope"))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    # isolate from any real install on the machine running the tests
    monkeypatch.setattr(locate, "STATIC_CANDIDATES", ())
    monkeypatch.setattr(locate, "SCAN_ROOTS", ())

    found = discover()

    assert not found.found
    assert found.hint


def test_settings_forces_http1(tmp_path, monkeypatch) -> None:
    target = tmp_path / "settings.json"
    target.write_text(json.dumps({"cursor.general.disableHttp2": False}))
    monkeypatch.setattr(settings, "SETTINGS", target)

    assert settings.ensure_settings() == "patched"
    assert json.loads(target.read_text())["cursor.general.disableHttp2"] is True

    assert settings.ensure_settings() == "already"


def test_settings_drops_port_override(tmp_path, monkeypatch) -> None:
    target = tmp_path / "settings.json"
    target.write_text(json.dumps({"cursor2plus.server.port": 39999}))
    monkeypatch.setattr(settings, "SETTINGS", target)

    settings.ensure_settings()

    assert "cursor2plus.server.port" not in json.loads(target.read_text())


def test_routes_port_is_synchronised(tmp_path, monkeypatch) -> None:
    target = tmp_path / "routes.json"
    target.write_text(json.dumps({"byokMode": 0, "server": {"host": "127.0.0.1", "port": 1}, "redirect": []}))
    monkeypatch.setattr(settings, "ROUTES", target)

    assert settings.ensure_routes() == "patched"

    data = json.loads(target.read_text())
    assert data["server"]["port"] == settings.DEFAULT_PORT
    assert data["byokMode"] == 1


def test_routes_missing_is_reported(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(settings, "ROUTES", tmp_path / "absent.json")
    assert settings.ensure_routes() == "missing"


def test_routes_with_unexpected_shape_is_left_alone(tmp_path, monkeypatch) -> None:
    target = tmp_path / "routes.json"
    original = {"something": "else"}
    target.write_text(json.dumps(original))
    monkeypatch.setattr(settings, "ROUTES", target)

    assert settings.ensure_routes() == "unexpected"
    assert json.loads(target.read_text()) == original


def test_checksum_refresh(tmp_path) -> None:
    app_root = tmp_path / "app"
    bundle = app_root / "out/vs/workbench/workbench.desktop.main.js"
    bundle.parent.mkdir(parents=True)
    bundle.write_bytes(b"patched")

    product = {"checksums": {"vs/workbench/workbench.desktop.main.js": "stale"}}
    (app_root / "product.json").write_text(json.dumps(product))

    updated = settings.refresh_checksums(app_root, [bundle])

    assert updated == 1
    refreshed = json.loads((app_root / "product.json").read_text())
    assert refreshed["checksums"]["vs/workbench/workbench.desktop.main.js"] != "stale"

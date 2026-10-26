"""Patch logic is the risky part, so it gets real fixtures.

Each fixture reproduces the shape Cursor's minified bundle actually has around the
guard, including the surrounding code that the anchors rely on. If a future Cursor
release changes that shape, these tests are the first thing to fail.
"""

from __future__ import annotations

import pytest

from cursor_byok import bundles


def make_bundle() -> bytes:
    """A bundle carrying both guards, in the order Cursor emits them."""
    return (
        b'var x={subscriptionChangedListener=(h,p)=>{Iug({isLocalMode:fl.localMode})'
        b"&&p===Yr.FREE&&h!==Yr.FREE&&this.setUseOpenAIKey(!1)}"
        b",migrate:1};"
        b"function GLC({t:e,n:i}){if(i.useClaudeKey)for(const r of o1l)t.removeModel(r);"
        b"}Usp({isLocalMode:mc.localMode})&&i.useOpenAIKey&&(AGo(t,"
        b'"[local-agent][settings] source=admin-policy action=disable-openai-key '
        b'byokDisabled=true previousUseOpenAIKey=true"),'
        b'n.setApplicationUserPersistentStorage("useOpenAIKey",!1)),'
        b"i.useClaudeKey&&n.setApplicationUserPersistentStorage(\"useClaudeKey\",!1);"
    )


def test_patch_neutralises_downgrade_callback() -> None:
    patched, state = bundles.patch_subscription(make_bundle())

    assert state == "patched"
    assert b"&&void 0}" in patched
    assert b"setUseOpenAIKey(!1)" not in patched
    # the surrounding comparison logic must survive untouched
    assert b"p===Yr.FREE&&h!==Yr.FREE" in patched


def test_patch_neutralises_admin_policy_reset() -> None:
    patched, state = bundles.patch_admin_policy(make_bundle())

    assert state == "patched"
    assert b"action=disable-openai-key" not in patched
    assert b"setApplicationUserPersistentStorage" in patched  # claude line survives
    assert b"&&!1" in patched


def test_patch_is_idempotent() -> None:
    once, _ = bundles.patch_subscription(make_bundle())
    twice, state = bundles.patch_subscription(once)

    assert state == "already"
    assert twice == once


def test_admin_patch_is_idempotent() -> None:
    once, _ = bundles.patch_admin_policy(make_bundle())
    twice, state = bundles.patch_admin_policy(once)

    assert state == "already"
    assert twice == once


def test_detection_helpers() -> None:
    original = make_bundle()
    assert not bundles.subscription_patched(original)
    assert not bundles.admin_policy_patched(original)

    patched, _ = bundles.patch_subscription(original)
    patched, _ = bundles.patch_admin_policy(patched)

    assert bundles.subscription_patched(patched)
    assert bundles.admin_policy_patched(patched)


def test_missing_anchor_is_reported_not_silently_ignored() -> None:
    _, state = bundles.patch_subscription(b"var unrelated=1;")
    assert state == "not-found"


def test_admin_marker_without_reset_is_left_alone() -> None:
    """A marker in unrelated code must not trigger a rewrite."""
    data = b'function f(){switch(t){case"admin-policy":return 1}}'
    _, state = bundles.patch_admin_policy(data)
    assert state == "already"


def test_patch_bundle_raises_on_unknown_shape(tmp_path) -> None:
    target = tmp_path / "workbench.desktop.main.js"
    target.write_bytes(b"nothing to patch here")

    with pytest.raises(bundles.PatchError):
        bundles.patch_bundle(target)


def test_patch_bundle_writes_only_when_needed(tmp_path) -> None:
    target = tmp_path / "workbench.desktop.main.js"
    target.write_bytes(make_bundle())

    first = bundles.patch_bundle(target)
    assert first.changed is True

    second = bundles.patch_bundle(target)
    assert second.changed is False
    assert second.subscription == "already"

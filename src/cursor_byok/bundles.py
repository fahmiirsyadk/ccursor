"""Byte-level patches for Cursor's workbench bundles.

Cursor disables bring-your-own-key in two places that are independent of the
transport. Both are one-line guards inside the minified workbench bundle, so the
patch replaces the guard with a constant and leaves everything else untouched.

Patch 1 -- subscription listener
    ``subscriptionChangedListener=(prev,next)=>{ ... &&next===FREE && prev!==FREE
    && this.setUseApiKey(false) }``

    When the billing profile is refreshed and reads as ``free``, this callback
    silently switches the BYOK toggle off. The models then disappear from the
    picker and only Auto remains. Replacing the call with ``void 0`` keeps the
    toggle where the user put it.

Patch 2 -- admin policy
    ``... && useApiKey && ( log("... action=disable-openai-key ..."),
    storage.setApplicationUserPersistentStorage(key, false) )``

    This path runs when the account policy reports BYOK as disabled. Replacing
    the whole expression with ``&& !1`` prevents the reset.

Both patches are structural: they anchor on stable surrounding text, validate
the span they are about to rewrite, and refuse to touch anything that does not
match the expected shape. That is what makes them survive Cursor point
releases instead of relying on brittle exact-string matches.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .paths import BUNDLES

# --- patch 1 anchors -------------------------------------------------------

SUB_ANCHOR = b"subscriptionChangedListener="
SUB_TAIL = b"(!1)}"
SUB_SEARCH_WINDOW = 500
SUB_MAX_CALL_LEN = 60

# --- patch 2 anchors -------------------------------------------------------

ADMIN_MARK = b"action=disable-openai-key"
ADMIN_HEAD = b"&&i.use"
ADMIN_TAIL = b",!1))"
ADMIN_PROOF = b"setApplicationUserPersistentStorage"

PATCHED_SUB = b"&&void 0}"
PATCHED_ADMIN = b"&&!1"


class PatchError(RuntimeError):
    """Raised when a bundle does not have the shape we expect."""


@dataclass
class PatchOutcome:
    path: Path
    subscription: str  # patched | already | not-found
    admin_policy: str  # patched | already | not-found
    changed: bool

    @property
    def ok(self) -> bool:
        return self.subscription != "not-found" and self.admin_policy != "not-found"


def bundle_paths(app_root: Path) -> list[Path]:
    """Existing workbench bundles for this install, in a stable order."""
    found = []
    for name in BUNDLES:
        path = app_root / "out" / "vs" / "workbench" / name
        if path.is_file():
            found.append(path)
    return found


def subscription_patched(data: bytes) -> bool:
    idx = data.find(SUB_ANCHOR)
    if idx < 0:
        return False
    return PATCHED_SUB in data[idx : idx + SUB_SEARCH_WINDOW]


def admin_policy_patched(data: bytes) -> bool:
    return data.find(ADMIN_MARK) < 0


def patch_subscription(data: bytes) -> tuple[bytes, str]:
    """Neutralise the downgrade callback. Returns (data, state)."""
    idx = data.find(SUB_ANCHOR)
    if idx < 0:
        return data, "not-found"
    window = data[idx : idx + SUB_SEARCH_WINDOW]
    if PATCHED_SUB in window:
        return data, "already"

    tail_at = window.find(SUB_TAIL)
    if tail_at < 0:
        return data, "not-found"

    head_at = window.rfind(b"&&", max(0, tail_at - 80), tail_at)
    if head_at < 0:
        return data, "not-found"

    call = window[head_at + 2 : tail_at]
    if len(call) > SUB_MAX_CALL_LEN or b"&&" in call or b"(" in call:
        return data, "not-found"

    start = idx + head_at
    end = idx + tail_at + len(SUB_TAIL)
    return data[:start] + PATCHED_SUB + data[end:], "patched"


def patch_admin_policy(data: bytes) -> tuple[bytes, str]:
    """Neutralise the policy-driven reset. Returns (data, state)."""
    mark_at = data.find(ADMIN_MARK)
    if mark_at < 0:
        return data, "already"

    head = data.rfind(ADMIN_HEAD, 0, mark_at)
    if head < 0:
        return data, "not-found"

    tail = data.find(ADMIN_TAIL, mark_at)
    if tail < 0:
        return data, "not-found"

    end = tail + len(ADMIN_TAIL)
    if ADMIN_PROOF not in data[head:end]:
        return data, "not-found"

    return data[:head] + PATCHED_ADMIN + data[end:], "patched"


def patch_bundle(path: Path) -> PatchOutcome:
    """Apply both patches to one bundle, writing only when something changed."""
    data = path.read_bytes()
    patched, sub_state = patch_subscription(data)
    patched, admin_state = patch_admin_policy(patched)

    if sub_state == "not-found":
        raise PatchError(
            f"{path.name}: could not find the subscription downgrade callback. "
            "This Cursor build may have moved the guard; run 'cursor-byok doctor'."
        )
    if admin_state == "not-found":
        raise PatchError(
            f"{path.name}: found the admin policy marker but could not isolate the "
            "reset expression. Run 'cursor-byok doctor' before retrying."
        )

    changed = patched != data
    if changed:
        path.write_bytes(patched)
    return PatchOutcome(path, sub_state, admin_state, changed)

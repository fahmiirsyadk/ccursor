"""Terminal output helpers.

Colors are disabled automatically when stdout is not a TTY or NO_COLOR is set,
so the same messages read cleanly in CI logs and pipes.
"""

from __future__ import annotations

import os
import sys

_ENABLED = sys.stdout.isatty() and "NO_COLOR" not in os.environ

_CODES = {
    "green": "\033[32m",
    "yellow": "\033[33m",
    "red": "\033[31m",
    "blue": "\033[34m",
    "dim": "\033[2m",
    "reset": "\033[0m",
}


def _paint(text: str, color: str) -> str:
    if not _ENABLED:
        return text
    return f"{_CODES[color]}{text}{_CODES['reset']}"


def ok(message: str) -> None:
    print(f"{_paint('[ok]', 'green')} {message}")


def warn(message: str) -> None:
    print(f"{_paint('[!]', 'yellow')} {message}")


def fail(message: str) -> None:
    print(f"{_paint('[x]', 'red')} {message}")


def info(message: str) -> None:
    print(f"{_paint('[>]', 'blue')} {message}")


def detail(message: str) -> None:
    print(_paint(f"    {message}", "dim"))


def heading(message: str) -> None:
    print(f"\n{message}")


def rule(width: int = 62) -> None:
    print(_paint("-" * width, "dim"))

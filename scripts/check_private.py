#!/usr/bin/env python3
"""Refuse commits that carry personal data: user-folder paths, Steam library paths, save files.

Run as a pre-commit hook (scripts/install-hooks.sh) on the staged files, or with --all on the whole tree (CI).
Extra private words (your name, your game folder) go one per line in `.private-patterns` at the repo root;
that file is gitignored, so the words themselves are never committed. Matching is case-insensitive.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

# Paths that name a person or a machine. Emscripten's virtual home (/home/web_user) is not one.
_PATTERNS = [
    re.compile(r"[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s'\"]+", re.I),
    re.compile(r"/[a-z]/Users/[^/\s'\"]+", re.I),
    re.compile(r"/home/(?!web_user\b)[A-Za-z0-9._-]+"),
    re.compile(r"/Users/[A-Za-z0-9._-]+/", re.I),
    re.compile(r"steamapps[\\/]+common", re.I),
]
_SAVE_SUFFIXES = (".sav", ".srm", ".state")
_BINARY_SUFFIXES = (".wasm", ".png", ".gba", ".nes", ".bin", ".gif", ".jpg")


def scan_text(name: str, text: str, extra: list[str] | None = None) -> list[tuple[str, int, str]]:
    """(file, line number, matched text) for every private match in `text`."""
    words = [w.lower() for w in (extra or []) if w.strip()]
    hits = []
    for n, line in enumerate(text.splitlines(), 1):
        for pat in _PATTERNS:
            m = pat.search(line)
            if m:
                hits.append((name, n, m.group(0)))
        low = line.lower()
        hits.extend((name, n, w) for w in words if w in low)
    return hits


def scan_paths(paths: list[str]) -> list[str]:
    """Paths that must never be committed at all (save files)."""
    return [p for p in paths if p.lower().endswith(_SAVE_SUFFIXES)]


def _extra(root: Path) -> list[str]:
    f = root / ".private-patterns"
    return f.read_text(encoding="utf-8").splitlines() if f.is_file() else []


def scan_repo(root: Path, paths: list[str]) -> list[tuple[str, int, str]]:
    extra = _extra(root)
    hits = [(p, 0, "save file") for p in scan_paths(paths)]
    for p in paths:
        f = root / p
        if p.lower().endswith(_BINARY_SUFFIXES) or not f.is_file():
            continue
        hits.extend(scan_text(p, f.read_text(encoding="utf-8", errors="replace"), extra))
    return hits


def main(argv: list[str]) -> int:
    root = Path(subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True,
                               check=True).stdout.strip())
    cmd = ["git", "ls-files", "-z"] if "--all" in argv else ["git", "diff", "--cached", "--name-only", "-z",
                                                             "--diff-filter=ACMR"]
    out = subprocess.run(cmd, cwd=root, capture_output=True, check=True).stdout.decode("utf-8")
    hits = scan_repo(root, [p for p in out.split("\0") if p])
    for name, line, what in hits:
        # Print where, never the private word itself.
        print(f"private data: {name}:{line} ({'save file' if what == 'save file' else 'matched a private pattern'})")
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

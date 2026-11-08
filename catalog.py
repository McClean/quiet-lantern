"""Find installed emulators and game files on disk. Pure stdlib; safe to import at register() time."""
from __future__ import annotations

import hashlib
import json
import os
import zipfile
from pathlib import Path

SYSTEM_BY_EXT = {
    ".gb": "gb", ".gbc": "gbc", ".gba": "gba",
    ".nes": "nes", ".sfc": "snes", ".smc": "snes",
    ".nds": "nds", ".n64": "n64", ".z64": "n64",
    ".md": "genesis", ".gen": "genesis", ".sms": "sms", ".gg": "gamegear",
}

# exe name (lowercase) -> (kind, systems, driver)
KNOWN_EMULATORS = {
    "mgba.exe": ("mgba", ["gb", "gbc", "gba"], "mgba-lua"),
    "mgba-qt": ("mgba", ["gb", "gbc", "gba"], "mgba-lua"),
    "mgba": ("mgba", ["gb", "gbc", "gba"], "mgba-lua"),
    "retroarch.exe": ("retroarch", ["gb", "gbc", "gba", "nes", "snes", "n64", "genesis", "sms", "gamegear", "nds"],
                      "launch-only"),
    "retroarch": ("retroarch", ["gb", "gbc", "gba", "nes", "snes", "n64", "genesis", "sms", "gamegear", "nds"],
                  "launch-only"),
    "visualboyadvance-m.exe": ("vbam", ["gb", "gbc", "gba"], "launch-only"),
    "melonds.exe": ("melonds", ["nds"], "launch-only"),
    "snes9x-x64.exe": ("snes9x", ["snes"], "launch-only"),
    "snes9x.exe": ("snes9x", ["snes"], "launch-only"),
    "mesen.exe": ("mesen", ["nes", "snes", "gb", "gbc", "gba", "sms", "gamegear"], "launch-only"),
}

MAX_DEPTH = 4


def _walk(root: Path, max_depth: int = MAX_DEPTH):
    root = Path(root)
    if not root.is_dir():
        return
    base = len(root.parts)
    for dirpath, dirnames, filenames in os.walk(root):
        depth = len(Path(dirpath).parts) - base
        if depth >= max_depth:
            dirnames[:] = []
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            yield Path(dirpath) / name


def _supports_script_flag(exe: Path) -> bool:
    """mGBA builds after 0.10.x accept `--script FILE`; the help text is embedded in the binary."""
    try:
        return b"--script" in exe.read_bytes()
    except OSError:
        return False


def scan_emulators(roots) -> list[dict]:
    found, seen = [], set()
    for root in roots:
        for f in _walk(Path(root)):
            spec = KNOWN_EMULATORS.get(f.name.lower())
            if not spec:
                continue
            key = str(f.resolve()).lower()
            if key in seen:
                continue
            seen.add(key)
            kind, systems, driver = spec
            found.append({
                "id": hashlib.sha1(key.encode()).hexdigest()[:8],
                "kind": kind,
                "name": f.parent.name,
                "path": str(f),
                "systems": list(systems),
                "driver": driver,
                "auto_script": driver == "mgba-lua" and _supports_script_flag(f),
            })
    return found


def _system_for(path: Path) -> str | None:
    ext = path.suffix.lower()
    if ext in SYSTEM_BY_EXT:
        return SYSTEM_BY_EXT[ext]
    if ext == ".zip":
        try:
            with zipfile.ZipFile(path) as z:
                for n in z.namelist():
                    s = SYSTEM_BY_EXT.get(Path(n).suffix.lower())
                    if s:
                        return s
        except (OSError, zipfile.BadZipFile):
            return None
    return None


def scan_games(roots) -> list[dict]:
    games, seen = [], set()
    for root in roots:
        for f in _walk(Path(root)):
            system = _system_for(f)
            if not system:
                continue
            key = str(f.resolve()).lower()
            if key in seen:
                continue
            seen.add(key)
            games.append({
                "id": hashlib.sha1(key.encode()).hexdigest()[:8],
                "name": f.stem,
                "system": system,
                "path": str(f),
            })
    return sorted(games, key=lambda g: g["name"].lower())


def pick_emulator(emulators: list[dict], system: str) -> dict | None:
    def rank(e):
        return (e["driver"] != "launch-only", bool(e.get("auto_script")))
    candidates = [e for e in emulators if system in e["systems"]]
    return max(candidates, key=rank) if candidates else None


def find_game(games: list[dict], query: str) -> dict | None:
    q = (query or "").strip().lower()
    if not q:
        return None
    for g in games:
        if g["id"] == q:
            return g
    for g in games:
        if q in g["name"].lower():
            return g
    return None


class Store:
    """User-configured folders, persisted as JSON in the plugin's data dir."""

    def __init__(self, data_dir: Path):
        self.path = Path(data_dir) / "catalog.json"

    def load(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        data.setdefault("game_dirs", [])
        data.setdefault("emulator_dirs", [])
        return data

    def save(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        tmp.replace(self.path)

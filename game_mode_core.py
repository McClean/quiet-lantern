"""Game mode backend core: profile binding, ROM serving, mailbox, frame HTML. Pure stdlib.

Used by dashboard/plugin_api.py (routes) and __init__.py (agent tool). Never writes the ROM.
"""
from __future__ import annotations

import base64
import json
import time
import uuid
import zipfile
from pathlib import Path

try:
    from . import catalog
except ImportError:  # loaded as a top-level module by dashboard/plugin_api.py
    import catalog

PLUGIN_NAME = "emulator-catalog"
VERSION = "0.1.0"
CHUNK = 2 * 1024 * 1024
ROM_EXTS = (".gba", ".gbc", ".gb")
_ROM_CACHE: dict[tuple[str, int], bytes] = {}


def bound_profile(home: Path) -> str:
    """Profile name a HERMES_HOME belongs to: <root>/profiles/<name> -> <name>, else 'default'."""
    home = Path(home)
    return home.name if home.parent.name == "profiles" else "default"


def health(home: Path) -> dict:
    return {"ok": True, "profile": bound_profile(home), "plugin": PLUGIN_NAME, "version": VERSION}


# ---------- ROM (allow-listed, read in memory, never written) ----------

def _zip_game_entry(z: zipfile.ZipFile) -> str | None:
    """Name of the GB/GBC/GBA file inside an open archive, or None."""
    return next((n for n in z.namelist() if n.lower().endswith(ROM_EXTS) and not n.endswith("/")), None)


def _is_servable(path: Path) -> bool:
    """A raw GB/GBC/GBA file, or an archive whose inner game file is one. Other files are never opened."""
    suffix = path.suffix.lower()
    if suffix in ROM_EXTS:
        return True
    if suffix != ".zip":
        return False
    try:
        with zipfile.ZipFile(path) as z:
            return _zip_game_entry(z) is not None
    except (zipfile.BadZipFile, OSError):
        return False


def servable_roms(folders) -> list[Path]:
    """Every game the folders offer, in folder then name order. Saves, .sfc/.md/.z64 and the like are excluded."""
    return [p for f in folders if Path(f).is_dir() for p in sorted(Path(f).iterdir()) if _is_servable(p)]


def rom_list(folders) -> list[str]:
    """Names only (no bytes read): what /rom/list shows."""
    return [p.name for p in servable_roms(folders)]


def _pick(folders, name: str | None) -> Path:
    """The servable game called `name` (the first servable game when no name), else ValueError."""
    roms = servable_roms(folders)
    if name is None:
        if not roms:
            raise FileNotFoundError("no games in the allow-listed folders")
        return roms[0]
    for p in roms:
        if p.name == name:
            return p
    raise ValueError(f"{name!r} is not in the allow-listed game folders")


def rom_bytes(folders, name: str | None = None) -> tuple[str, bytes]:
    path = _pick(folders, name)
    key = (str(path), path.stat().st_mtime_ns)
    if key not in _ROM_CACHE:
        _ROM_CACHE.clear()  # one game at a time: keep memory bounded
        _ROM_CACHE[key] = _read_rom(path)
    return path.name, _ROM_CACHE[key]


def _read_rom(path: Path) -> bytes:
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as z:
            entry = _zip_game_entry(z)
            if entry is None:
                raise ValueError(f"{path.name} holds no GB/GBC/GBA ROM")
            return z.read(entry)
    return path.read_bytes()


def rom_info(folders, name: str | None = None) -> dict:
    n, data = rom_bytes(folders, name)
    return {"name": n, "size": len(data), "chunks": (len(data) + CHUNK - 1) // CHUNK, "chunk": CHUNK}


def rom_chunk(folders, name: str | None, i: int) -> dict:
    _, data = rom_bytes(folders, name)
    if i < 0 or i * CHUNK >= len(data):
        raise IndexError(f"chunk {i} out of range")
    return {"i": i, "b64": base64.b64encode(data[i * CHUNK:(i + 1) * CHUNK]).decode("ascii")}


# ---------- mailbox: agent commands in (pending/), pane replies out (replies/) ----------

def _sub(data_dir: Path, name: str) -> Path:
    d = Path(data_dir) / name
    d.mkdir(parents=True, exist_ok=True)
    return d


def enqueue(data_dir: Path, cmd: dict) -> dict:
    cmd = {"id": uuid.uuid4().hex[:12], "queued_ms": int(time.time() * 1000), **cmd}
    (_sub(data_dir, "pending") / f"{cmd['id']}.json").write_text(json.dumps(cmd), encoding="utf-8")
    return cmd


def take_pending(data_dir: Path) -> list[dict]:
    out = []
    for p in sorted(_sub(data_dir, "pending").glob("*.json")):
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        finally:
            p.unlink(missing_ok=True)
    return out


def store_reply(data_dir: Path, body: dict) -> dict:
    cid = str((body or {}).get("id") or "")
    if not cid.isalnum():
        return {"ok": False, "error": "bad id"}
    rec = {**body, "replied_ms": int(time.time() * 1000)}
    (_sub(data_dir, "replies") / f"{cid}.json").write_text(json.dumps(rec), encoding="utf-8")
    return {"ok": True}


def wait_reply(data_dir: Path, cid: str, timeout: float = 15.0) -> dict | None:
    path = _sub(data_dir, "replies") / f"{cid}.json"
    end = time.time() + timeout
    while time.time() < end:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
        time.sleep(0.05)
    return None


def log_event(data_dir: Path, body: dict) -> dict:
    """Pane-side evidence line -> events.jsonl (append only)."""
    rec = {"server_ms": int(time.time() * 1000), **(body or {})}
    with (Path(data_dir) / "events.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec) + "\n")
    return {"ok": True}


# ---------- agent tool: game_mode op=open|status ----------

GAME_MODE_SCHEMA = {
    "name": "game_mode",
    "description": (
        "Open Hermes game mode on the user's own local game (the FireRed ROM already in the user's "
        "allow-listed game folder). op=open opens game mode in Hermes Desktop. op=status reports the "
        "last command. NEVER search for, fetch or download ROMs: only open a game the user already has."
    ),
    "parameters": {
        "type": "object",
        "properties": {"op": {"type": "string", "enum": ["open", "status"]}},
        "required": ["op"],
        "additionalProperties": False,
    },
}


def game_mode(data_dir: Path, args: dict) -> str:
    op = (args or {}).get("op")
    if op == "open":
        cmd = enqueue(data_dir, {"op": "open"})
        return json.dumps({"ok": True, "command": "open", "id": cmd["id"]})
    if op == "status":
        pending = len(list(_sub(data_dir, "pending").glob("*.json")))
        return json.dumps({"ok": True, "pending": pending})
    return json.dumps({"ok": False, "code": "bad_op", "error": f"unknown op {op!r}",
                       "fix": "Use op=open or op=status."})


PKG = Path(__file__).resolve().parent
WEB_DIR = PKG / "web"
# Default ROM folder, used only when present. The catalog's game_dirs are the user-chosen list.
DEFAULT_ROM_DIRS = [Path.home() / "Emulators" / "ROMs"]


def current_home() -> Path:
    """The HERMES_HOME this process is bound to (the profile dir for a profile, the root for default)."""
    import os
    env = os.environ.get("HERMES_HOME")
    return Path(env) if env else Path.home() / ".hermes"


def resolve_data_dir() -> Path:
    """Where catalog.json, pending/ and replies/ live. EMULATOR_CATALOG_DATA_DIR overrides for tests."""
    import os
    env = os.environ.get("EMULATOR_CATALOG_DATA_DIR")
    if env:
        return Path(env)
    try:
        from plugins.plugin_storage import plugin_data_dir
        return Path(plugin_data_dir(PLUGIN_NAME))
    except Exception:  # outside Hermes (tests, scripts)
        return Path.home() / ".emulator-catalog"


def rom_folders() -> list[Path]:
    """The allow-list for ROM reads: catalog game_dirs plus the default folder, existing ones only."""
    return allowed_rom_dirs(resolve_data_dir(), DEFAULT_ROM_DIRS)


def allowed_rom_dirs(data_dir: Path, default_dirs) -> list[Path]:
    """Folders a ROM may come from: the catalog's game_dirs (same store as emu_catalog) then the defaults.
    Missing folders are dropped so a stale entry can never widen the list."""
    seen, out = set(), []
    for raw in [*catalog.Store(Path(data_dir)).load()["game_dirs"], *default_dirs]:
        p = Path(raw)
        if p.is_dir() and str(p) not in seen:
            seen.add(str(p))
            out.append(p)
    return out


# ---------- player frame: web/player/index.html with the shared player modules inlined (CONTRACTS §11.1) ----------
# The sandboxed frame has an opaque origin, so it cannot fetch sibling modules: they travel as text. The frame names no
# emulator core. The core (adapters/<id>/core) arrives in the `load` message, so this frame serves every adapter.

_PRELUDE_MARKER = "__PRELUDE__"  # appears once in player/index.html, inside the page's module script
_PRELUDE = r"""const __mod = src => import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
const contracts = await __mod(__CONTRACTS_SRC__);
const controls = await __mod(__CONTROLS_SRC__);
const { createPlayer, fitSize } = await __mod(__PLAYER_SRC__);"""
# placeholder -> shared module file under web/. None of these has relative imports, so each is safe as a blob module.
_SHARED = (
    ("__CONTRACTS_SRC__", ("engine", "contracts.mjs")),
    ("__CONTROLS_SRC__", ("player", "controls.mjs")),
    ("__PLAYER_SRC__", ("player", "player.mjs")),
)


def _js_literal(text: str) -> str:
    # JSON string literal that cannot close the surrounding <script>.
    return json.dumps(text).replace("</", "<\\/")


def frame_html(web: Path = WEB_DIR) -> str:
    html = (Path(web) / "player" / "index.html").read_text(encoding="utf-8").replace("\r\n", "\n")
    if html.count(_PRELUDE_MARKER) != 1:
        raise ValueError(f"player/index.html changed; cannot patch: {_PRELUDE_MARKER} must appear once")
    prelude = _PRELUDE
    for placeholder, parts in _SHARED:
        src = Path(web).joinpath(*parts).read_text(encoding="utf-8")
        prelude = prelude.replace(placeholder, _js_literal(src))
    return html.replace(_PRELUDE_MARKER, prelude)


def assets(web: Path = WEB_DIR) -> dict:
    wasm = (Path(web).parent / "adapters" / "mgba" / "core" / "mgba.wasm").read_bytes()
    return {"html": frame_html(web), "wasm_b64": base64.b64encode(wasm).decode("ascii"), "wasm_size": len(wasm)}

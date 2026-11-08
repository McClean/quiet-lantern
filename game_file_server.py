"""Localhost-only, read-only file server for the game tile (CONTRACTS §7, §11.2).

Routes: /health, /player.html, /library[?rescan=1], /library/<systemId>, /rom/<titleId>,
/adapters, /core/<adapterId>/<file>. GET only, bound to 127.0.0.1, no writes, no directory listing.
The library is scanned from the allow-listed folders on start and on /library?rescan=1. Saves and unclaimed
files are never served, and no response carries a file path.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

try:
    from . import game_mode_core as core
except ImportError:  # loaded as a top-level module by dashboard/plugin_api.py
    import game_mode_core as core

try:
    from . import contracts
except ImportError:
    import contracts

_CORS = {"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"}
_ROM_PREFIX = "/rom/"
_LIB_PREFIX = "/library/"
_CORE_PREFIX = "/core/"
ADAPTERS_DIR = Path(__file__).resolve().parent / "adapters"
PACKS_DIR = Path(__file__).resolve().parent / "packs"
ADAPTER_FIELDS = ("id", "name", "buttons", "controls", "capabilities", "systems")
_CTYPES = {".wasm": "application/wasm", ".mjs": "text/javascript; charset=utf-8",
           ".js": "text/javascript; charset=utf-8"}
_ROM_LOCK = threading.Lock()  # serialises game reads from disk


class _Server(ThreadingHTTPServer):
    # Windows: SO_REUSEADDR lets a second socket bind a port that is already listening, so it stays off there and
    # a taken port raises OSError (start-up can tell "ours" from "someone else's"). POSIX: SO_REUSEADDR never allows
    # binding a listening port; it only skips TIME_WAIT, without which a restart could not rebind for up to 60 s.
    allow_reuse_address = os.name != "nt"


def _core_files(adapter) -> list[str]:
    """Files this adapter may serve under /core: runtime.files plus the binding. Only wasm adapters have them."""
    rt = adapter.manifest["runtime"]
    if rt.get("kind") != "wasm" or not rt.get("binding"):
        return []
    return [*rt.get("files", []), rt["binding"]]


def _loadable(adapter) -> bool:
    files = _core_files(adapter)
    return bool(files) and all((adapter.path / f).is_file() for f in files)


class Library:
    """The scanned library (CONTRACTS §5, §7): an in-memory SQLite snapshot of the allow-listed folders.

    A rescan builds a new snapshot off to the side and swaps it in under the lock, so readers never see a
    half-written library. Each snapshot is built from scratch, so a folder removed from the allow-list drops
    out at the next rescan. Every query runs under the lock.
    """

    def __init__(self, folders, adapters_dir: Path, packs_dir: Path):
        self._folders = folders
        self._adapters_dir = Path(adapters_dir)
        self._packs_dir = Path(packs_dir)
        self._lock = threading.Lock()        # guards _db, _adapters, _system_names
        self._scan_lock = threading.Lock()   # one scan at a time
        self._db: sqlite3.Connection | None = None
        self._adapters: list = []
        self._system_names: dict[str, str] = {}
        self.rescan()

    def rescan(self) -> None:
        with self._scan_lock:
            adapters = contracts.discover_adapters(self._adapters_dir)
            packs = contracts.discover_packs(self._packs_dir, adapters)
            db = sqlite3.connect(":memory:", check_same_thread=False)
            db.executescript(contracts.LIBRARY_SQL)
            contracts.scan_library(db, [Path(f) for f in self._folders()], adapters, packs)
            names: dict[str, str] = {}
            for a in sorted(adapters, key=lambda a: (-int(a.manifest.get("priority", 0)), a.id)):
                for s in a.manifest["systems"]:
                    names.setdefault(s["id"], s["name"])
            with self._lock:
                old, self._db = self._db, db
                self._adapters, self._system_names = adapters, names
            if old is not None:
                old.close()

    def _read(self, fn):
        with self._lock:
            return fn(self._db, self._system_names, self._adapters)

    def library(self) -> dict:
        def build(db, names, _adapters):
            counts = db.execute("SELECT system, COUNT(*), MIN(adapter) FROM titles WHERE missing = 0 "
                                "GROUP BY system").fetchall()
            systems = [{"id": s, "name": names.get(s, s), "adapter": a, "count": n}
                       for s, n, a in counts if n > 0]
            systems.sort(key=lambda x: (x["name"], x["id"]))
            unsupported = {e: c for e, c in db.execute(
                "SELECT ext, SUM(count) FROM unsupported GROUP BY ext") if c > 0}
            return {"systems": systems, "unsupported": unsupported}
        return self._read(build)

    def system_titles(self, system: str) -> dict | None:
        def build(db, names, _adapters):
            if system not in names:
                return None
            rows = db.execute("SELECT id, name, code, header_title, pack, adapter FROM titles "
                              "WHERE system = ? AND missing = 0 ORDER BY name, id", (system,)).fetchall()
            return {"system": system, "titles": [
                {"id": i, "name": n, "code": c, "headerTitle": h, "pack": p, "adapter": a}
                for i, n, c, h, p, a in rows]}
        return self._read(build)

    def game_source(self, title_id: str) -> tuple[Path, str | None] | None:
        def build(db, _names, _adapters):
            row = db.execute("SELECT path, inner FROM titles WHERE id = ? AND missing = 0", (title_id,)).fetchone()
            return (Path(row[0]), row[1]) if row else None
        return self._read(build)

    def adapters_view(self) -> list[dict]:
        def build(_db, _names, adapters):
            return [{k: a.manifest[k] for k in ADAPTER_FIELDS if k in a.manifest}
                    for a in adapters if _loadable(a)]
        return self._read(build)

    def core_file(self, adapter_id: str, rel: str) -> Path | None:
        def build(_db, _names, adapters):
            for a in adapters:
                if a.id == adapter_id:
                    f = a.path / rel
                    return f if rel in _core_files(a) and f.is_file() else None
            return None
        return self._read(build)

    def mgba_wasm_path(self) -> Path | None:
        p = self._adapters_dir / "mgba" / "core" / "mgba.wasm"
        return p if p.is_file() else None


def _read_game(path: Path, inner: str | None) -> bytes:
    if inner is None:
        return path.read_bytes()
    with zipfile.ZipFile(path) as z:
        return z.read(inner)


def _handler(lib: Library, web: Path):
    class Handler(BaseHTTPRequestHandler):
        server_version = "emulator-catalog"
        sys_version = ""

        def log_message(self, format, *args):  # keep the gateway log quiet
            pass

        def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for k, v in {**_CORS, **(extra or {})}.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, obj) -> None:
            self._send(status, json.dumps(obj).encode("utf-8"), "application/json")

        def _not_found(self) -> None:
            self._json(404, {"ok": False, "error": "not found"})

        def do_GET(self):
            path, _, query = self.path.partition("?")
            if path == "/health":
                return self._json(200, {"ok": True, "plugin": core.PLUGIN_NAME, "version": core.VERSION})
            if path == "/player.html":
                return self._send(200, core.frame_html(web).encode("utf-8"), "text/html; charset=utf-8")
            if path == "/library":
                if parse_qs(query).get("rescan") == ["1"]:
                    lib.rescan()
                return self._json(200, lib.library())
            if path.startswith(_LIB_PREFIX):
                found = lib.system_titles(path[len(_LIB_PREFIX):])
                return self._json(200, found) if found is not None else self._not_found()
            if path == "/adapters":
                return self._json(200, lib.adapters_view())
            if path.startswith(_CORE_PREFIX):
                parts = path.split("/", 3)  # ['', 'core', '<adapterId>', '<file>']
                f = lib.core_file(parts[2], parts[3]) if len(parts) == 4 else None
                if f is None:
                    return self._not_found()
                try:
                    data = f.read_bytes()
                except OSError:
                    return self._not_found()
                return self._send(200, data, _CTYPES.get(f.suffix.lower(), "application/octet-stream"))
            if path.startswith(_ROM_PREFIX):
                source = lib.game_source(path[len(_ROM_PREFIX):])
                if source is None:
                    return self._not_found()
                try:
                    with _ROM_LOCK:
                        data = _read_game(*source)
                except (OSError, KeyError, zipfile.BadZipFile):
                    return self._not_found()
                return self._send(200, data, "application/octet-stream")
            return self._not_found()

        def _refuse(self):
            self._send(405, json.dumps({"ok": False, "error": "read-only: GET only"}).encode("utf-8"),
                       "application/json", {"Allow": "GET"})

        do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _refuse

    return Handler


def serve(port: int, folders=None, web: Path = core.WEB_DIR, adapters_dir=None, packs_dir=None) -> ThreadingHTTPServer:
    """Start the read-only server on 127.0.0.1:port in a daemon thread. port=0 picks a free port.

    The library is scanned before the server starts (CONTRACTS §7: rescan on start)."""
    folders = folders or core.rom_folders
    lib = Library(folders, adapters_dir or ADAPTERS_DIR, packs_dir or PACKS_DIR)
    srv = _Server(("127.0.0.1", port), _handler(lib, Path(web)))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, name="emulator-catalog-files", daemon=True).start()
    return srv


DEFAULT_PORT = 47911
PORT_ENV = "EMULATOR_CATALOG_FILE_PORT"
_SERVER: ThreadingHTTPServer | None = None
_LOCK = threading.Lock()  # one server per process, however many times the router loads


def resolve_port() -> int:
    """47911, or EMULATOR_CATALOG_FILE_PORT when it is a valid TCP port. A bad override falls back."""
    raw = os.environ.get(PORT_ENV, "").strip()
    if raw.isdigit() and 0 < int(raw) <= 65535:
        return int(raw)
    return DEFAULT_PORT


def _is_ours(port: int) -> bool:
    """True when 127.0.0.1:port answers /health as this plugin. Any other answer, or none, is not ours."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1.0) as r:
            return json.loads(r.read().decode("utf-8")).get("plugin") == core.PLUGIN_NAME
    except (OSError, ValueError):
        return False


def ensure_started(port: int | None = None, folders=None, web: Path = core.WEB_DIR) -> dict:
    """Start the file server once per process. Never raises: returns a state the tile can show.

    started     this process started the server
    running     this process already has it
    reused      another profile's gateway already serves it on this port (same plugin)
    unavailable the port is held by something else; the error names the port and the fix
    """
    global _SERVER
    port = resolve_port() if port is None else port
    with _LOCK:
        if _SERVER is not None:
            return {"state": "running", "port": _SERVER.server_address[1]}
        try:
            _SERVER = serve(port, folders=folders, web=web)
        except OSError as exc:
            if port and _is_ours(port):
                return {"state": "reused", "port": port}
            return {"state": "unavailable", "port": port,
                    "error": f"127.0.0.1:{port} is in use by another program ({exc}). "
                             f"Set {PORT_ENV} to a free port and restart the gateway."}
        return {"state": "started", "port": _SERVER.server_address[1]}


# ---------- keeper: one daemon thread per process keeps the server up, and takes the port back if it is freed ----------

_log = logging.getLogger("emulator_catalog.game_file_server")
KEEPER_NAME = "emulator-catalog-keeper"
KEEPER_ENV = "EMULATOR_CATALOG_FILE_SERVER"  # set to "0" to disable the keeper (tests, short-lived tools)
_KEEPER = None  # (thread, stop_event) started by this module instance
_KEEPER_LOCK = threading.Lock()


def _log_state(res: dict) -> None:
    state, port = res["state"], res["port"]
    if state == "started":
        _log.info("game file server listening on 127.0.0.1:%s", port)
    elif state == "reused":
        _log.info("game file server on 127.0.0.1:%s is served by another gateway; reusing it", port)
    else:
        _log.warning("game file server not available: %s", res.get("error", state))


def _keeper_loop(interval: float, port, folders, web, stop: threading.Event) -> None:
    last = None
    while True:
        try:
            res = ensure_started(port=port, folders=folders, web=web)
        except Exception as exc:  # ensure_started does not raise; keep the keeper alive regardless
            res = {"state": "unavailable", "port": port, "error": f"{type(exc).__name__}: {exc}"}
        key = "up" if res["state"] in ("started", "running") else res["state"]
        if key != last:  # log state changes only, never every tick
            last = key
            _log_state(res)
        if stop.wait(interval):
            return


def start_keeper(interval: float = 10.0, port: int | None = None, folders=None,
                 web: Path = core.WEB_DIR) -> threading.Thread | None:
    """Start the keeper thread once per process and return it. Returns at once; never waits on the network.

    The thread calls ensure_started() immediately and then every `interval` seconds, so if another process
    that held the port exits, this one takes it over within about one interval. None when disabled by
    EMULATOR_CATALOG_FILE_SERVER=0.
    """
    global _KEEPER
    if os.environ.get(KEEPER_ENV, "").strip() == "0":
        return None
    with _KEEPER_LOCK:
        # One keeper per process, even if this module was loaded twice (plugin package and top-level import).
        alive = [t for t in threading.enumerate() if t.name == KEEPER_NAME and t.is_alive()]
        if alive:
            return alive[0]
        stop = threading.Event()
        thread = threading.Thread(target=_keeper_loop, args=(interval, port, folders, web, stop),
                                  name=KEEPER_NAME, daemon=True)
        thread.start()
        _KEEPER = (thread, stop)
        return thread


def stop_keeper(timeout: float = 2.0) -> None:
    """Stop the keeper this module started. Used by tests; the daemon thread also dies with the process."""
    global _KEEPER
    with _KEEPER_LOCK:
        if _KEEPER is None:
            return
        thread, stop = _KEEPER
        _KEEPER = None
    stop.set()
    thread.join(timeout)


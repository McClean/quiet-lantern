"""Agent-facing tools: emu_catalog, emu_session, emu_play. Handlers return JSON strings
(or the multimodal envelope for screenshots), never raise."""
from __future__ import annotations

import json
import re
import secrets
import subprocess
import time
from pathlib import Path

from . import catalog
from . import mgba_driver

MAX_STEPS = 32
STEP_RE = re.compile(r"^(?:wait:(\d{1,5})|([A-Za-z]+(?:\+[A-Za-z]+)*))$")


def _ok(**kw) -> str:
    return json.dumps({"ok": True, **kw})


def _err(code: str, error: str, fix: str) -> str:
    return json.dumps({"ok": False, "code": code, "error": error, "fix": fix})


def _safe_name(name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "-", str(name or "")).strip("-")[:48]
    return cleaned or time.strftime("save-%Y%m%d-%H%M%S")


class State:
    """Per-process plugin state: config store and at most one running session."""

    def __init__(self, data_dir: Path, default_emulator_dirs=(), default_game_dirs=()):
        self.data_dir = Path(data_dir)
        self.store = catalog.Store(self.data_dir)
        self.default_emulator_dirs = [str(p) for p in default_emulator_dirs]
        self.default_game_dirs = [str(p) for p in default_game_dirs]
        self.session: dict | None = None

    # Seams for tests.
    def launch(self, cmd: list[str]):
        flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        return subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, creationflags=flags)

    def new_port_and_token(self):
        return mgba_driver.free_port(), secrets.token_hex(16)

    def dirs(self):
        cfg = self.store.load()
        emu_dirs = list(dict.fromkeys(cfg["emulator_dirs"] + self.default_emulator_dirs))
        game_dirs = list(dict.fromkeys(cfg["game_dirs"] + self.default_game_dirs))
        return emu_dirs, game_dirs

    def scan(self):
        emu_dirs, game_dirs = self.dirs()
        return catalog.scan_emulators(emu_dirs), catalog.scan_games(game_dirs)

    def running(self) -> bool:
        if not self.session:
            return False
        if self.session["proc"].poll() is not None:
            self._cleanup()
            return False
        return True

    def _cleanup(self):
        if self.session:
            self.session["client"].close()
        self.session = None

    def stop_session(self):
        if not self.session:
            return
        proc = self.session["proc"]
        try:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except Exception:
                    proc.kill()
        finally:
            self._cleanup()

    def saves_dir(self) -> Path:
        d = self.data_dir / "saves" / self.session["game"]["id"]
        d.mkdir(parents=True, exist_ok=True)
        return d

    def shots_dir(self) -> Path:
        d = self.data_dir / "screenshots"
        d.mkdir(parents=True, exist_ok=True)
        return d


# ---------------------------------------------------------------- emu_catalog

def emu_catalog(state: State, args: dict) -> str:
    op = (args or {}).get("op")
    if op == "list":
        emus, games = state.scan()
        emu_dirs, game_dirs = state.dirs()
        for g in games:
            e = catalog.pick_emulator(emus, g["system"])
            g["playable_with"] = e["kind"] if e else None
        return _ok(emulators=emus, games=games, emulator_dirs=emu_dirs, game_dirs=game_dirs)
    if op in ("add_dir", "remove_dir"):
        kind = args.get("kind")
        key = {"games": "game_dirs", "emulators": "emulator_dirs"}.get(kind)
        if not key:
            return _err("bad_kind", f"kind must be games or emulators, got {kind!r}", "Pass kind=games or kind=emulators.")
        raw = str(args.get("path") or "").strip()
        if not raw:
            return _err("bad_path", "path is required", "Pass an absolute folder path.")
        path = str(Path(raw).expanduser())
        cfg = state.store.load()
        if op == "add_dir":
            if not Path(path).is_dir():
                return _err("not_found", f"folder does not exist: {path}", "Check the path; the folder must already exist.")
            if path not in cfg[key]:
                cfg[key].append(path)
        else:
            cfg[key] = [p for p in cfg[key] if Path(p) != Path(path)]
        state.store.save(cfg)
        return _ok(game_dirs=cfg["game_dirs"], emulator_dirs=cfg["emulator_dirs"])
    return _err("bad_op", f"unknown op {op!r}", "Use op=list, add_dir or remove_dir.")


# ---------------------------------------------------------------- emu_session

def _wait_for_bridge(client, proc, timeout: float = 20.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("emulator exited during startup")
        try:
            return client.ping()
        except (OSError, mgba_driver.BridgeError) as exc:
            last = exc
            client.close()
            time.sleep(0.25)
    raise TimeoutError(f"bridge did not answer within {timeout:.0f}s ({last})")


def emu_session(state: State, args: dict) -> str:
    op = (args or {}).get("op")
    if op == "status":
        if not state.running():
            return _ok(running=False)
        s = state.session
        try:
            info = s["client"].ping()
        except Exception as exc:  # noqa: BLE001 - report, don't raise
            info = {"error": str(exc)}
        return _ok(running=True, game=s["game"], emulator=_public_emu(s["emulator"]), info=info)
    if op == "stop":
        was = state.running()
        state.stop_session()
        return _ok(stopped=was)
    if op == "start":
        if state.running():
            return _err("session_running", f"already playing {state.session['game']['name']}",
                        "Call emu_session op=stop first.")
        emus, games = state.scan()
        game = catalog.find_game(games, str(args.get("game") or ""))
        if not game:
            return _err("game_not_found", f"no game matches {args.get('game')!r}",
                        "Call emu_catalog op=list and pass a game id or part of its name.")
        if args.get("emulator"):
            emu = next((e for e in emus if e["id"] == args["emulator"] or e["kind"] == args["emulator"]), None)
        else:
            emu = catalog.pick_emulator(emus, game["system"])
        if not emu:
            return _err("no_emulator", f"no installed emulator plays {game['system']}",
                        "Install one (e.g. mGBA) and add its folder with emu_catalog op=add_dir kind=emulators.")
        if emu["driver"] != "mgba-lua":
            return _err("not_controllable", f"{emu['kind']} has no agent driver yet",
                        "Use an mGBA build for GB/GBC/GBA; other emulators are launch-only for now.")
        port, token = state.new_port_and_token()
        script = mgba_driver.render_bridge_script(state.data_dir / "run", port, token)
        proc = state.launch(mgba_driver.launch_command(emu, game["path"], script))
        client = mgba_driver.BridgeClient(port, token)
        state.session = {"game": game, "emulator": emu, "proc": proc, "client": client, "script": str(script)}
        if not emu.get("auto_script"):
            return _ok(game=game, emulator=_public_emu(emu), info=None, manual_step=(
                f"This mGBA build cannot auto-load scripts. In mGBA open Tools > Scripting, File > Load script, "
                f"and choose {script}. Then call emu_session op=status."))
        try:
            info = _wait_for_bridge(client, proc)
        except Exception as exc:  # noqa: BLE001
            state.stop_session()
            return _err("bridge_timeout", str(exc), "Check that mGBA opened the game; retry emu_session op=start.")
        return _ok(game=game, emulator=_public_emu(emu), info=info)
    return _err("bad_op", f"unknown op {op!r}", "Use op=start, stop or status.")


def _public_emu(e: dict) -> dict:
    return {k: e[k] for k in ("id", "kind", "name", "path", "systems", "driver", "auto_script") if k in e}


# ---------------------------------------------------------------- emu_play

def _parse_steps(steps):
    plan = []
    if not isinstance(steps, list) or not steps:
        return None, _err("bad_step", "steps must be a non-empty list", 'Example: ["UP","UP","A","wait:30"].')
    if len(steps) > MAX_STEPS:
        return None, _err("too_many_steps", f"{len(steps)} steps > {MAX_STEPS}",
                          "Send at most a few steps, then take a screenshot to check progress.")
    for raw in steps:
        m = STEP_RE.match(str(raw).strip())
        if not m:
            return None, _err("bad_step", f"cannot parse step {raw!r}", 'Use "A", "A+B", "UP" or "wait:30".')
        if m.group(1):
            plan.append(("wait", int(m.group(1))))
            continue
        buttons = [b.upper() for b in m.group(2).split("+")]
        bad = [b for b in buttons if b not in mgba_driver.BUTTONS]
        if bad:
            return None, _err("bad_step", f"unknown button(s) {bad}",
                              f"Valid buttons: {', '.join(mgba_driver.BUTTONS)}.")
        plan.append(("press", buttons))
    return plan, None


def _screenshot_result(payload: dict, path: Path) -> str:
    # Public surfaces only (catalog rule 9): return the path; the agent inspects it with vision_analyze.
    return json.dumps({**payload, "hint": "Inspect it with vision_analyze on this path."})


def emu_play(state: State, args: dict):
    args = args or {}
    op = args.get("op")
    if not state.running():
        return _err("no_session", "no game is running", "Start one with emu_session op=start game=<name>.")
    client = state.session["client"]
    try:
        if op == "status":
            return _ok(info=client.ping(), game=state.session["game"])
        if op == "press":
            plan, error = _parse_steps(args.get("steps"))
            if error:
                return error
            hold = max(1, min(int(args.get("hold_frames", 8)), 600))
            gap = max(0, min(int(args.get("gap_frames", 12)), 600))
            last = ""
            for kind, value in plan:
                last = client.wait(value) if kind == "wait" else client.press(value, hold, gap)
            return _ok(steps=len(plan), result=last,
                       hint="Take a screenshot to confirm what happened before the next move.")
        if op == "screenshot":
            path = state.shots_dir() / time.strftime("shot-%Y%m%d-%H%M%S.png")
            client.screenshot(path)
            return _screenshot_result({"ok": True, "screenshot": str(path)}, path)
        if op == "save":
            name = _safe_name(args.get("name"))
            path = state.saves_dir() / f"{name}.ss"
            client.save_state(path)
            return _ok(name=name, path=str(path))
        if op == "load":
            name = _safe_name(args.get("name"))
            path = state.saves_dir() / f"{name}.ss"
            if not path.is_file():
                return _err("save_not_found", f"no save named {name}", "Call emu_play op=list_saves.")
            client.load_state(path)
            return _ok(name=name, path=str(path))
        if op == "list_saves":
            files = sorted(state.saves_dir().glob("*.ss"), key=lambda p: p.stat().st_mtime, reverse=True)
            return _ok(saves=[{"name": p.stem, "modified": time.strftime("%Y-%m-%d %H:%M:%S",
                                                                         time.localtime(p.stat().st_mtime))}
                              for p in files])
        if op == "read":
            addr = int(str(args.get("address")), 0)
            length = max(1, min(int(args.get("length", 1)), 4096))
            return _ok(address=hex(addr), hex=client.read(addr, length).hex())
        if op == "reset":
            client.reset()
            return _ok()
    except mgba_driver.BridgeError as exc:
        return _err("bridge_error", str(exc), "Check the arguments; call emu_play op=status.")
    except (OSError, ValueError) as exc:
        return _err("io_error", str(exc), "If the emulator was closed, call emu_session op=status / start.")
    return _err("bad_op", f"unknown op {op!r}", "Use press, screenshot, save, load, list_saves, read, reset or status.")

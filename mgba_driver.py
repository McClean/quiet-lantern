"""mGBA driver: render the Lua bridge, launch mGBA, and talk to the bridge over 127.0.0.1."""
from __future__ import annotations

import itertools
import socket
from pathlib import Path

BUTTONS = ("A", "B", "SELECT", "START", "RIGHT", "LEFT", "UP", "DOWN", "R", "L")
BRIDGE_TEMPLATE = Path(__file__).resolve().parent / "drivers" / "mgba_bridge.lua"


class BridgeError(RuntimeError):
    """The bridge answered ERR."""


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def render_bridge_script(out_dir: Path, port: int, token: str) -> Path:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    text = BRIDGE_TEMPLATE.read_text(encoding="utf-8")
    text = text.replace("{{PORT}}", str(int(port))).replace("{{TOKEN}}", token)
    path = out_dir / "mgba_bridge.lua"
    path.write_text(text, encoding="utf-8")
    return path


def launch_command(emulator: dict, game_path: str, script_path: Path) -> list[str]:
    cmd = [emulator["path"]]
    if emulator.get("auto_script"):
        cmd += ["--script", str(script_path)]
    cmd.append(str(game_path))
    return cmd


class BridgeClient:
    def __init__(self, port: int, token: str, timeout: float = 120.0):
        self.port, self.token, self.timeout = int(port), token, timeout
        self._ids = itertools.count(1)
        self._sock = None
        self._file = None

    def _connect(self):
        if self._sock is None:
            self._sock = socket.create_connection(("127.0.0.1", self.port), timeout=self.timeout)
            self._file = self._sock.makefile("rwb")

    def close(self):
        for obj in (self._file, self._sock):
            try:
                if obj is not None:
                    obj.close()
            except OSError:
                pass
        self._sock = self._file = None

    def call(self, command: str, *args) -> str:
        self._connect()
        rid = str(next(self._ids))
        line = " ".join([rid, self.token, command, *[str(a) for a in args]])
        try:
            self._file.write((line + "\n").encode("utf-8"))
            self._file.flush()
            reply = self._file.readline().decode("utf-8").rstrip("\r\n")
        except OSError:
            self.close()
            raise
        if not reply:
            self.close()
            raise ConnectionError("bridge closed the connection")
        got_id, _, rest = reply.partition(" ")
        status, _, payload = rest.partition(" ")
        if got_id != rid:
            self.close()
            raise BridgeError(f"out-of-order reply {got_id!r} for request {rid!r}")
        if status != "OK":
            raise BridgeError(payload or "bridge error")
        return payload

    def ping(self) -> dict:
        payload = self.call("ping")
        info = {}
        head, _, title = payload.partition(" title=")
        for part in head.split():
            k, _, v = part.partition("=")
            info[k] = v
        info["title"] = title
        return info

    def press(self, buttons, hold: int = 8, wait: int = 12) -> str:
        names = [str(b).upper() for b in buttons]
        bad = [b for b in names if b not in BUTTONS]
        if bad or not names:
            raise ValueError(f"unknown buttons {bad}; valid: {', '.join(BUTTONS)}")
        return self.call("press", "+".join(names), int(hold), int(wait))

    def wait(self, frames: int) -> str:
        return self.call("wait", int(frames))

    def screenshot(self, path) -> str:
        return self.call("screenshot", str(Path(path)).replace("\\", "/"))

    def save_state(self, path) -> str:
        return self.call("save", str(Path(path)).replace("\\", "/"))

    def load_state(self, path) -> str:
        return self.call("load", str(Path(path)).replace("\\", "/"))

    def read(self, address: int, length: int) -> bytes:
        return bytes.fromhex(self.call("read", hex(int(address)), int(length)))

    def reset(self) -> str:
        return self.call("reset")

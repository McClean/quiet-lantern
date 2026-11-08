"""mGBA driver: launches mGBA with the Lua bridge and talks to it over localhost TCP."""
from __future__ import annotations

import socket
import socketserver
import threading
from pathlib import Path

import pytest

from conftest import load_module

mgba = load_module("mgba_driver")


class FakeBridge(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, token):
        self.token, self.lines = token, []
        super().__init__(("127.0.0.1", 0), self._Handler)

    class _Handler(socketserver.StreamRequestHandler):
        def handle(self):
            for raw in self.rfile:
                line = raw.decode().strip()
                self.server.lines.append(line)
                rid, tok, cmd, *args = line.split(" ")
                if tok != self.server.token:
                    out = f"{rid} ERR bad token"
                elif cmd == "ping":
                    out = f"{rid} OK platform=0 frame=10 code=BPRE title=POKEMON FIRE"
                elif cmd == "screenshot":
                    Path(" ".join(args)).write_bytes(b"\x89PNG fake")
                    out = f"{rid} OK {' '.join(args)}"
                elif cmd == "read":
                    out = f"{rid} OK 0102ff"
                elif cmd == "press" and args[0] == "BAD":
                    out = f"{rid} ERR unknown key BAD"
                else:
                    out = f"{rid} OK frame=99"
                self.wfile.write((out + "\n").encode())


@pytest.fixture
def bridge():
    srv = FakeBridge("tok123")
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield srv
    srv.shutdown()
    srv.server_close()


def test_client_ping_parses_fields(bridge):
    c = mgba.BridgeClient(bridge.server_address[1], "tok123")
    info = c.ping()
    assert info == {"platform": "0", "frame": "10", "code": "BPRE", "title": "POKEMON FIRE"}
    assert bridge.lines[0].split(" ")[1:] == ["tok123", "ping"]


def test_client_raises_bridge_error_on_err(bridge):
    c = mgba.BridgeClient(bridge.server_address[1], "tok123")
    with pytest.raises(mgba.BridgeError, match="unknown key BAD"):
        c.call("press", "BAD")


def test_press_sends_combo_and_timing(bridge):
    c = mgba.BridgeClient(bridge.server_address[1], "tok123")
    c.press(["A", "B"], hold=4, wait=20)
    assert bridge.lines[-1].endswith("press A+B 4 20")


def test_press_rejects_unknown_buttons_before_sending(bridge):
    c = mgba.BridgeClient(bridge.server_address[1], "tok123")
    with pytest.raises(ValueError):
        c.press(["X"])
    assert bridge.lines == []


def test_read_returns_bytes(bridge):
    c = mgba.BridgeClient(bridge.server_address[1], "tok123")
    assert c.read(0x02000000, 3) == b"\x01\x02\xff"
    assert bridge.lines[-1].endswith("read 0x2000000 3")


def test_screenshot_writes_file(bridge, tmp_path):
    c = mgba.BridgeClient(bridge.server_address[1], "tok123")
    out = c.screenshot(tmp_path / "s.png")
    assert Path(out).read_bytes().startswith(b"\x89PNG")


def test_render_bridge_script_fills_port_and_token(tmp_path):
    path = mgba.render_bridge_script(tmp_path, 4321, "abc")
    text = Path(path).read_text(encoding="utf-8")
    assert 'tonumber("4321")' in text and '"abc"' in text
    assert "{{" not in text


def test_launch_command_uses_script_flag_when_supported(tmp_path):
    emu = {"path": "C:/E/mGBA.exe", "auto_script": True}
    cmd = mgba.launch_command(emu, "C:/R/game.gba", tmp_path / "b.lua")
    assert cmd == ["C:/E/mGBA.exe", "--script", str(tmp_path / "b.lua"), "C:/R/game.gba"]


def test_launch_command_without_script_flag_omits_it(tmp_path):
    emu = {"path": "C:/E/mGBA.exe", "auto_script": False}
    cmd = mgba.launch_command(emu, "C:/R/game.gba", tmp_path / "b.lua")
    assert cmd == ["C:/E/mGBA.exe", "C:/R/game.gba"]


def test_free_port_is_bindable():
    port = mgba.free_port()
    s = socket.socket()
    s.bind(("127.0.0.1", port))
    s.close()

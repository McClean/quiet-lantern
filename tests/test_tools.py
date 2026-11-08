"""The three agent tools, exercised against a fake bridge and a fake process launcher."""
from __future__ import annotations

import json
import threading
import zipfile
from pathlib import Path

import pytest

from conftest import load_package, load_module
from test_mgba_driver import FakeBridge

plugin = load_package()
tools = load_module("tools")


class FakeProc:
    def __init__(self):
        self.killed = False
        self.pid = 4242

    def poll(self):
        return 0 if self.killed else None

    def terminate(self):
        self.killed = True

    def wait(self, timeout=None):
        return 0

    def kill(self):
        self.killed = True


@pytest.fixture
def env(tmp_path, monkeypatch):
    srv = FakeBridge("unused")
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()

    emu_dir = tmp_path / "Emulators" / "mGBA"
    emu_dir.mkdir(parents=True)
    (emu_dir / "mGBA.exe").write_bytes(b"MZ --script FILE")
    roms = tmp_path / "ROMs"
    roms.mkdir()
    with zipfile.ZipFile(roms / "Pokemon - FireRed Version (USA).zip", "w") as z:
        z.writestr("Pokemon - FireRed Version (USA).gba", b"x")

    launched = []

    def fake_launch(cmd):
        launched.append(cmd)
        return FakeProc()

    state = tools.State(data_dir=tmp_path / "data", default_emulator_dirs=[], default_game_dirs=[])
    monkeypatch.setattr(state, "launch", fake_launch)
    monkeypatch.setattr(state, "new_port_and_token", lambda: (srv.server_address[1], "unused"))
    yield {"state": state, "srv": srv, "launched": launched, "tmp": tmp_path, "emu_dir": emu_dir, "roms": roms}
    state.stop_session()
    srv.shutdown()
    srv.server_close()


def _j(result):
    return json.loads(result) if isinstance(result, str) else result


def test_catalog_add_dirs_then_list(env):
    s = env["state"]
    r = _j(tools.emu_catalog(s, {"op": "add_dir", "kind": "emulators", "path": str(env["tmp"] / "Emulators")}))
    assert r["ok"]
    r = _j(tools.emu_catalog(s, {"op": "add_dir", "kind": "games", "path": str(env["roms"])}))
    assert r["ok"]
    r = _j(tools.emu_catalog(s, {"op": "list"}))
    assert r["ok"]
    assert [e["kind"] for e in r["emulators"]] == ["mgba"]
    assert r["games"][0]["name"] == "Pokemon - FireRed Version (USA)"
    assert r["games"][0]["system"] == "gba"
    assert r["games"][0]["playable_with"] == "mgba"


def test_catalog_add_dir_rejects_missing_folder(env):
    r = _j(tools.emu_catalog(env["state"], {"op": "add_dir", "kind": "games", "path": str(env["tmp"] / "nope")}))
    assert r["ok"] is False and r["code"] == "not_found" and r["fix"]


def test_catalog_remove_dir(env):
    s = env["state"]
    tools.emu_catalog(s, {"op": "add_dir", "kind": "games", "path": str(env["roms"])})
    r = _j(tools.emu_catalog(s, {"op": "remove_dir", "kind": "games", "path": str(env["roms"])}))
    assert r["ok"] and r["game_dirs"] == []


def _setup(env):
    s = env["state"]
    tools.emu_catalog(s, {"op": "add_dir", "kind": "emulators", "path": str(env["tmp"] / "Emulators")})
    tools.emu_catalog(s, {"op": "add_dir", "kind": "games", "path": str(env["roms"])})
    return s


def test_session_start_launches_mgba_with_bridge_script(env):
    s = _setup(env)
    r = _j(tools.emu_session(s, {"op": "start", "game": "firered"}))
    assert r["ok"], r
    assert r["game"]["name"].startswith("Pokemon - FireRed")
    assert r["emulator"]["kind"] == "mgba"
    assert r["info"]["code"] == "BPRE"
    cmd = env["launched"][0]
    assert cmd[0].endswith("mGBA.exe") and cmd[1] == "--script" and cmd[-1].endswith(".zip")
    assert Path(cmd[2]).read_text(encoding="utf-8").count("{{") == 0


def test_session_start_unknown_game(env):
    s = _setup(env)
    r = _j(tools.emu_session(s, {"op": "start", "game": "zelda"}))
    assert r["ok"] is False and r["code"] == "game_not_found"


def test_session_start_refuses_second_session(env):
    s = _setup(env)
    tools.emu_session(s, {"op": "start", "game": "firered"})
    r = _j(tools.emu_session(s, {"op": "start", "game": "firered"}))
    assert r["ok"] is False and r["code"] == "session_running"


def test_session_status_and_stop(env):
    s = _setup(env)
    assert _j(tools.emu_session(s, {"op": "status"}))["running"] is False
    tools.emu_session(s, {"op": "start", "game": "firered"})
    st = _j(tools.emu_session(s, {"op": "status"}))
    assert st["running"] is True and st["game"]["name"].startswith("Pokemon")
    assert _j(tools.emu_session(s, {"op": "stop"}))["ok"]
    assert _j(tools.emu_session(s, {"op": "status"}))["running"] is False


def test_play_without_session_explains_fix(env):
    r = _j(tools.emu_play(env["state"], {"op": "press", "steps": ["A"]}))
    assert r["ok"] is False and r["code"] == "no_session" and "emu_session" in r["fix"]


def test_play_press_steps_with_waits(env):
    s = _setup(env)
    tools.emu_session(s, {"op": "start", "game": "firered"})
    r = _j(tools.emu_play(s, {"op": "press", "steps": ["UP", "UP", "A+B", "wait:30"]}))
    assert r["ok"], r
    sent = [l.split(" ", 2)[2] for l in env["srv"].lines if " ping" not in l]
    assert sent == ["press UP 8 12", "press UP 8 12", "press A+B 8 12", "wait 30"]


def test_play_press_rejects_bad_step_without_sending(env):
    s = _setup(env)
    tools.emu_session(s, {"op": "start", "game": "firered"})
    before = len(env["srv"].lines)
    r = _j(tools.emu_play(s, {"op": "press", "steps": ["UP", "JUMP"]}))
    assert r["ok"] is False and r["code"] == "bad_step"
    assert len(env["srv"].lines) == before


def test_play_press_caps_step_count(env):
    s = _setup(env)
    tools.emu_session(s, {"op": "start", "game": "firered"})
    r = _j(tools.emu_play(s, {"op": "press", "steps": ["A"] * 100}))
    assert r["ok"] is False and r["code"] == "too_many_steps"


def test_play_screenshot_returns_path(env):
    s = _setup(env)
    tools.emu_session(s, {"op": "start", "game": "firered"})
    r = tools.emu_play(s, {"op": "screenshot"})
    text = r["text_summary"] if isinstance(r, dict) else r
    data = json.loads(text)
    assert data["ok"] and Path(data["screenshot"]).is_file()


def test_play_save_load_named_state(env):
    s = _setup(env)
    tools.emu_session(s, {"op": "start", "game": "firered"})
    r = _j(tools.emu_play(s, {"op": "save", "name": "before brock"}))
    assert r["ok"] and r["name"] == "before-brock"
    assert "before-brock" in r["path"]
    Path(r["path"]).write_bytes(b"state")  # fake bridge does not write the file
    lst = _j(tools.emu_play(s, {"op": "list_saves"}))
    assert [x["name"] for x in lst["saves"]] == ["before-brock"]
    r = _j(tools.emu_play(s, {"op": "load", "name": "before-brock"}))
    assert r["ok"]
    r = _j(tools.emu_play(s, {"op": "load", "name": "nope"}))
    assert r["ok"] is False and r["code"] == "save_not_found"


def test_play_save_rejects_path_traversal(env):
    s = _setup(env)
    tools.emu_session(s, {"op": "start", "game": "firered"})
    r = _j(tools.emu_play(s, {"op": "save", "name": "../../evil"}))
    assert r["ok"] and ".." not in Path(r["path"]).name
    assert Path(r["path"]).parent.name == s.session["game"]["id"]


def test_play_read_memory(env):
    s = _setup(env)
    tools.emu_session(s, {"op": "start", "game": "firered"})
    r = _j(tools.emu_play(s, {"op": "read", "address": "0x02000000", "length": 3}))
    assert r["ok"] and r["hex"] == "0102ff"


def test_plugin_registers_manifest_tools():
    class Ctx:
        def __init__(self):
            self.tools, self.skills = {}, {}

        def register_tool(self, name, toolset, schema, handler, check_fn=None, requires_env=None,
                          is_async=False, description="", emoji="", override=False):
            self.tools[name] = handler

        def register_skill(self, name, path, description="", frontmatter=None):
            self.skills[name] = path

    import yaml
    ctx = Ctx()
    plugin.register(ctx)
    manifest = yaml.safe_load((Path(plugin.__file__).parent / "plugin.yaml").read_text(encoding="utf-8"))
    assert sorted(ctx.tools) == sorted(manifest["provides_tools"]) == ["emu_catalog", "emu_play", "emu_session", "game_mode"]
    assert "emulator-catalog" in ctx.skills
    out = ctx.tools["emu_play"]({"op": "status"})
    assert isinstance(out, str)

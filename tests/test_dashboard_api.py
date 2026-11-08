"""Dashboard routes (dashboard/plugin_api.py) exercised through FastAPI's TestClient. No Hermes needed."""
from __future__ import annotations

import base64
import importlib.util
import json
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from conftest import ROOT, load_module

core = load_module("game_mode_core")


def _load_api():
    spec = importlib.util.spec_from_file_location("game_mode_plugin_api", ROOT / "dashboard" / "plugin_api.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def env(tmp_path, monkeypatch):
    home = tmp_path / "hermes" / "profiles" / "gamer"
    home.mkdir(parents=True)
    data = tmp_path / "data"
    data.mkdir()
    roms = tmp_path / "ROMs"
    roms.mkdir()
    (roms / "Plain.gba").write_bytes(b"A" * 5)
    (data / "catalog.json").write_text(json.dumps({"game_dirs": [str(roms)], "emulator_dirs": []}), encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("EMULATOR_CATALOG_DATA_DIR", str(data))
    api = _load_api()
    monkeypatch.setattr(api.core, "DEFAULT_ROM_DIRS", [])
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/emulator-catalog")
    return {"client": TestClient(app), "api": api, "data": data, "roms": roms, "base": "/api/plugins/emulator-catalog"}


def test_health_reports_the_profile_the_request_is_bound_to(env):
    r = env["client"].get(env["base"] + "/health")
    assert r.status_code == 200
    assert r.json()["profile"] == "gamer" and r.json()["plugin"] == "emulator-catalog"


def test_rom_info_serves_an_allow_listed_rom(env):
    r = env["client"].get(env["base"] + "/rom/info", params={"name": "Plain.gba"})
    assert r.status_code == 200 and r.json()["size"] == 5


def test_rom_info_outside_allow_list_is_404(env):
    r = env["client"].get(env["base"] + "/rom/info", params={"name": "Secret.gba"})
    assert r.status_code == 404


def test_rom_chunk_serves_base64_bytes(env):
    r = env["client"].get(env["base"] + "/rom/chunk", params={"i": 0, "name": "Plain.gba"})
    assert r.status_code == 200 and base64.b64decode(r.json()["b64"]) == b"AAAAA"


def test_assets_serves_the_real_player_frame(env):
    r = env["client"].get(env["base"] + "/assets")
    assert r.status_code == 200
    body = r.json()
    assert "createPlayer" in body["html"] and "__PRELUDE__" not in body["html"]
    assert "createMgba" not in body["html"]  # the core arrives in load(), not in the frame (CONTRACTS §11.1)
    assert base64.b64decode(body["wasm_b64"])[:4] == b"\x00asm"


def test_pending_hands_out_queued_commands_once(env):
    core.enqueue(env["data"], {"op": "open"})
    first = env["client"].get(env["base"] + "/pending").json()["cmds"]
    assert [c["op"] for c in first] == ["open"]
    assert env["client"].get(env["base"] + "/pending").json()["cmds"] == []


def test_reply_is_stored_for_the_agent(env):
    r = env["client"].post(env["base"] + "/reply", json={"id": "abc123", "ok": True})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert core.wait_reply(env["data"], "abc123", timeout=1)["ok"] is True


def test_event_is_appended_to_the_log(env):
    env["client"].post(env["base"] + "/event", json={"kind": "boot", "data": {}})
    lines = (env["data"] / "events.jsonl").read_text(encoding="utf-8").splitlines()
    assert json.loads(lines[-1])["kind"] == "boot"


def test_manifest_names_the_plugin_and_its_api():
    manifest = json.loads((ROOT / "dashboard" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest == {"name": "emulator-catalog", "api": "plugin_api.py"}


def test_manifest_discloses_the_localhost_file_server_it_runs():
    # plugin.yaml is the disclosure the user reads: it must name the 127.0.0.1-only read-only server.
    import yaml
    text = (ROOT / "plugin.yaml").read_text(encoding="utf-8")
    desc = yaml.safe_load(text)["description"]
    assert "127.0.0.1" in desc and "47911" in desc
    assert "read-only" in desc.lower() and "GET" in desc
    assert "no background threads" not in desc.lower()  # the old claim is false now


# ---------- the file server starts when the router loads, and a taken port never breaks the router ----------

def _free_port():
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _health_on(port):
    import urllib.request
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=3) as r:
        return json.loads(r.read().decode("utf-8"))


def test_loading_the_router_starts_the_localhost_file_server(monkeypatch):
    port = _free_port()
    monkeypatch.setenv("EMULATOR_CATALOG_FILE_PORT", str(port))
    monkeypatch.delitem(sys.modules, "game_file_server", raising=False)  # a fresh process-level server
    api = _load_api()
    try:
        assert _health_on(port)["plugin"] == "emulator-catalog"
        assert api.router is not None
    finally:
        srv = sys.modules["game_file_server"]._SERVER
        if srv is not None:
            srv.shutdown()
            srv.server_close()


def test_router_still_loads_when_the_file_server_port_is_taken(monkeypatch):
    import socket
    squatter = socket.socket()
    squatter.bind(("127.0.0.1", 0))
    squatter.listen()
    monkeypatch.setenv("EMULATOR_CATALOG_FILE_PORT", str(squatter.getsockname()[1]))
    monkeypatch.delitem(sys.modules, "game_file_server", raising=False)
    try:
        api = _load_api()  # must not raise
        assert api.router is not None
    finally:
        squatter.close()

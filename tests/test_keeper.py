"""The keeper: one daemon thread per process that keeps the localhost game file server up. No Hermes needed.

Every test uses free ports and temp ROM folders. Nothing here binds 47911 or reads a real ROM.
"""
from __future__ import annotations

import json
import logging
import os
import socket
import threading
import time
import urllib.request
from pathlib import Path

import pytest

from conftest import load_module, load_package

fs = load_module("game_file_server")
core = load_module("game_mode_core")
plugin = load_package()

KEEPER_NAME = "emulator-catalog-keeper"
LOG_NAME = "emulator_catalog.game_file_server"


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def keeper_threads():
    return [t for t in threading.enumerate() if t.name == KEEPER_NAME]


def health(port: int) -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
        return json.loads(r.read().decode("utf-8"))


@pytest.fixture
def roms(tmp_path):
    d = tmp_path / "ROMs"
    d.mkdir()
    (d / "Plain.gba").write_bytes(b"A" * 5)
    return d


@pytest.fixture
def clean(monkeypatch):
    """No server and no keeper in this process; the keeper switched on for this test only."""
    monkeypatch.setattr(fs, "_SERVER", None)
    monkeypatch.delenv("EMULATOR_CATALOG_FILE_SERVER", raising=False)
    yield fs
    fs.stop_keeper()
    srv = fs._SERVER
    if srv is not None:
        srv.shutdown()
        srv.server_close()
    monkeypatch.setattr(fs, "_SERVER", None)


# ---------- start_keeper: one thread, env opt-out, never waits on the network ----------

def test_start_keeper_starts_one_daemon_thread_even_when_called_twice(clean, roms):
    port = free_port()
    kw = dict(interval=30, port=port, folders=lambda: [roms], web=core.WEB_DIR)
    first = fs.start_keeper(**kw)
    second = fs.start_keeper(**kw)
    assert first is second
    assert len(keeper_threads()) == 1
    assert first.daemon is True


def test_env_opt_out_zero_disables_the_keeper(clean, monkeypatch):
    monkeypatch.setenv("EMULATOR_CATALOG_FILE_SERVER", "0")
    assert fs.start_keeper(interval=0.05, port=free_port()) is None
    assert keeper_threads() == []
    assert fs._SERVER is None


def test_start_keeper_returns_without_waiting_on_a_hung_port(clean, roms):
    # A port that accepts TCP but never answers HTTP: the first tick would wait out its 1 s health timeout.
    hung = socket.socket()
    hung.bind(("127.0.0.1", 0))
    hung.listen()
    try:
        t0 = time.monotonic()
        fs.start_keeper(interval=30, port=hung.getsockname()[1], folders=lambda: [roms], web=core.WEB_DIR)
        assert time.monotonic() - t0 < 0.5
    finally:
        hung.close()


# ---------- the keeper re-acquires a freed port ----------

def test_keeper_takes_over_the_port_within_two_intervals_of_it_being_freed(clean, roms):
    port = free_port()
    interval = 0.3
    holder = fs.serve(port=port, folders=lambda: [roms], web=core.WEB_DIR)  # another process owns the port
    fs.start_keeper(interval=interval, port=port, folders=lambda: [roms], web=core.WEB_DIR)
    time.sleep(interval * 1.5)
    assert fs._SERVER is None  # held by the other server, so this process must not claim it
    holder.shutdown()
    holder.server_close()
    deadline = time.monotonic() + 2 * interval + 0.5  # two intervals, plus a little for thread scheduling
    while fs._SERVER is None and time.monotonic() < deadline:
        time.sleep(0.02)
    assert fs._SERVER is not None, "keeper did not take the freed port within two intervals"
    assert health(port)["plugin"] == "emulator-catalog"


def test_keeper_logs_each_state_change_once_not_every_tick(clean, roms, caplog):
    port = free_port()
    holder = fs.serve(port=port, folders=lambda: [roms], web=core.WEB_DIR)
    with caplog.at_level(logging.INFO, logger=LOG_NAME):
        fs.start_keeper(interval=0.05, port=port, folders=lambda: [roms], web=core.WEB_DIR)
        time.sleep(0.5)  # about ten ticks while the other server holds the port
        assert len([r for r in caplog.records if r.name == LOG_NAME]) == 1
        holder.shutdown()
        holder.server_close()
        deadline = time.monotonic() + 2.0
        while len([r for r in caplog.records if r.name == LOG_NAME]) < 2 and time.monotonic() < deadline:
            time.sleep(0.02)
        logged = [r.getMessage() for r in caplog.records if r.name == LOG_NAME]
    assert len(logged) == 2, logged  # one line for "reused", one for "started"; no per-tick spam


# ---------- register(ctx) starts the keeper and never fails because of it ----------

class FakeCtx:
    def __init__(self):
        self.tools = {}

    def register_tool(self, name, toolset, schema, handler, check_fn=None, requires_env=None,
                      is_async=False, description="", emoji="", override=False):
        self.tools[name] = handler

    def register_skill(self, name, path, description="", frontmatter=None):
        pass


EXPECTED_TOOLS = ["emu_catalog", "emu_play", "emu_session", "game_mode"]


def test_register_starts_the_keeper_and_still_registers_every_tool(monkeypatch):
    calls = []
    monkeypatch.setattr(fs, "start_keeper", lambda *a, **k: calls.append(1))
    ctx = FakeCtx()
    plugin.register(ctx)
    assert calls == [1]
    assert sorted(ctx.tools) == EXPECTED_TOOLS


def test_register_never_raises_when_the_keeper_fails(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("thread could not start")

    monkeypatch.setattr(fs, "start_keeper", boom)
    ctx = FakeCtx()
    plugin.register(ctx)  # must not raise: a keeper failure never fails plugin load
    assert sorted(ctx.tools) == EXPECTED_TOOLS


# ---------- the disclosure names the thread the user will see in the manifest ----------

def test_manifest_discloses_the_keeper_thread():
    import yaml
    root = Path(__file__).resolve().parents[1]
    desc = yaml.safe_load((root / "plugin.yaml").read_text(encoding="utf-8"))["description"]
    assert "background thread" in desc.lower()
    assert "127.0.0.1" in desc


# ---------- the suite itself never binds the real port ----------

def test_suite_runs_with_the_keeper_opted_out():
    assert os.environ.get("EMULATOR_CATALOG_FILE_SERVER") == "0"

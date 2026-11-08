"""Catalog: find installed emulators and games on disk. No Hermes needed."""
from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from conftest import load_module

catalog = load_module("catalog")


def _fake_mgba(root: Path, with_script_flag: bool) -> Path:
    d = root / "mGBA-x"
    d.mkdir(parents=True)
    exe = d / "mGBA.exe"
    exe.write_bytes(b"MZ...usage...--script FILE  Run a script" if with_script_flag else b"MZ...usage...")
    return exe


def test_scan_emulators_finds_mgba_and_reports_script_support(tmp_path):
    _fake_mgba(tmp_path / "a", with_script_flag=True)
    found = catalog.scan_emulators([tmp_path])
    assert len(found) == 1
    emu = found[0]
    assert emu["kind"] == "mgba"
    assert emu["systems"] == ["gb", "gbc", "gba"]
    assert emu["driver"] == "mgba-lua"
    assert emu["auto_script"] is True
    assert emu["path"].endswith("mGBA.exe")


def test_old_mgba_without_script_flag_is_marked_manual(tmp_path):
    _fake_mgba(tmp_path, with_script_flag=False)
    emu = catalog.scan_emulators([tmp_path])[0]
    assert emu["auto_script"] is False


def test_unknown_emulators_are_listed_launch_only(tmp_path):
    (tmp_path / "RetroArch").mkdir()
    (tmp_path / "RetroArch" / "retroarch.exe").write_bytes(b"MZ")
    emu = catalog.scan_emulators([tmp_path])[0]
    assert emu["kind"] == "retroarch"
    assert emu["driver"] == "launch-only"
    assert "gba" in emu["systems"]


def test_missing_roots_are_ignored(tmp_path):
    assert catalog.scan_emulators([tmp_path / "nope"]) == []


def test_scan_games_by_extension_and_inside_zip(tmp_path):
    (tmp_path / "Tetris.gb").write_bytes(b"x")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "Game.gbc").write_bytes(b"x")
    with zipfile.ZipFile(tmp_path / "Fire.zip", "w") as z:
        z.writestr("Fire (USA).gba", b"x")
    with zipfile.ZipFile(tmp_path / "junk.zip", "w") as z:
        z.writestr("readme.txt", b"x")
    (tmp_path / "notes.txt").write_text("x")

    games = {g["name"]: g for g in catalog.scan_games([tmp_path])}
    assert set(games) == {"Tetris", "Game", "Fire"}
    assert games["Tetris"]["system"] == "gb"
    assert games["Game"]["system"] == "gbc"
    assert games["Fire"]["system"] == "gba"
    assert games["Fire"]["path"].endswith("Fire.zip")
    assert all(g["id"] for g in games.values())
    assert len({g["id"] for g in games.values()}) == 3


def test_pick_emulator_prefers_controllable_driver():
    emus = [
        {"kind": "retroarch", "driver": "launch-only", "systems": ["gba"], "auto_script": False, "path": "r"},
        {"kind": "mgba", "driver": "mgba-lua", "systems": ["gb", "gbc", "gba"], "auto_script": False, "path": "old"},
        {"kind": "mgba", "driver": "mgba-lua", "systems": ["gb", "gbc", "gba"], "auto_script": True, "path": "new"},
    ]
    assert catalog.pick_emulator(emus, "gba")["path"] == "new"
    assert catalog.pick_emulator(emus, "nes") is None


def test_find_game_by_id_or_fuzzy_name():
    games = [{"id": "aa11", "name": "Pokemon - FireRed Version (USA)"}, {"id": "bb22", "name": "Tetris"}]
    assert catalog.find_game(games, "bb22")["name"] == "Tetris"
    assert catalog.find_game(games, "firered")["id"] == "aa11"
    assert catalog.find_game(games, "zelda") is None


def test_store_round_trip(tmp_path):
    store = catalog.Store(tmp_path)
    cfg = store.load()
    assert cfg["game_dirs"] == [] and cfg["emulator_dirs"] == []
    cfg["game_dirs"].append("D:/ROMs")
    store.save(cfg)
    assert catalog.Store(tmp_path).load()["game_dirs"] == ["D:/ROMs"]

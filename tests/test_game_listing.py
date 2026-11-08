"""Which games the game folders offer: an archive counts only when the file inside it is GB/GBC/GBA.

No Hermes needed. Temp folders only; nothing here touches a real ROM folder.
"""
from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from conftest import load_module

core = load_module("game_mode_core")


def _zip(path, inner, data=b"X"):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(inner, data)
    return path


@pytest.fixture
def folder(tmp_path):
    d = tmp_path / "ROMs"
    d.mkdir()
    return d


def test_rom_list_leaves_out_a_zip_of_a_non_gba_file(folder):
    _zip(folder / "Chrono Trigger (USA).zip", "Chrono Trigger (USA).sfc")
    _zip(folder / "Advance Wars.zip", "Advance Wars.gba")
    assert core.rom_list([folder]) == ["Advance Wars.zip"]


def test_rom_list_names_archives_and_raw_files_that_hold_a_gb_gbc_gba_game(folder):
    _zip(folder / "Phantasy Star IV (USA).zip", "Phantasy Star IV (USA).md")
    _zip(folder / "Ocarina.zip", "Ocarina.z64")
    _zip(folder / "Fire.zip", "Fire.gbc")
    (folder / "Plain.gba").write_bytes(b"A")
    (folder / "Notes.txt").write_text("x", encoding="utf-8")
    assert core.rom_list([folder]) == ["Fire.zip", "Plain.gba"]


def test_rom_list_skips_a_corrupt_archive_instead_of_failing(folder):
    (folder / "Broken.zip").write_bytes(b"not a zip")
    _zip(folder / "Advance Wars.zip", "Advance Wars.gba")
    assert core.rom_list([folder]) == ["Advance Wars.zip"]


def test_rom_list_never_opens_the_save_file(folder, monkeypatch):
    # Guard: the .sav is read-only to us and must never be opened, read or written.
    # Spies on every read path (Path.open, Path.read_bytes, zipfile) and records what they touch.
    save = folder / "Pokemon - FireRed Version (USA).sav"
    save.write_bytes(b"save")
    _zip(folder / "Advance Wars.zip", "Advance Wars.gba")
    touched = []
    real_open, real_read, real_zip = Path.open, Path.read_bytes, zipfile.ZipFile

    def spy_open(self, *a, **k):
        touched.append(str(self))
        return real_open(self, *a, **k)

    def spy_read(self):
        touched.append(str(self))
        return real_read(self)

    def spy_zip(file, *a, **k):
        touched.append(str(file))
        return real_zip(file, *a, **k)

    monkeypatch.setattr(Path, "open", spy_open)
    monkeypatch.setattr(Path, "read_bytes", spy_read)
    monkeypatch.setattr(core.zipfile, "ZipFile", spy_zip)
    assert core.rom_list([folder]) == ["Advance Wars.zip"]
    assert not any(t.endswith(".sav") for t in touched)
    assert save.read_bytes() == b"save"  # and it is still intact


def test_requesting_a_non_gba_archive_by_name_is_refused(folder):
    _zip(folder / "Chrono Trigger (USA).zip", "Chrono Trigger (USA).sfc")
    with pytest.raises(ValueError, match="allow-listed"):
        core.rom_bytes([folder], "Chrono Trigger (USA).zip")


def test_default_game_is_the_first_servable_one_not_the_first_file(folder):
    _zip(folder / "Aaa Chrono.zip", "Chrono.sfc")
    _zip(folder / "Bbb.zip", "Bbb.gba", b"B" * 3)
    name, data = core.rom_bytes([folder])
    assert name == "Bbb.zip"
    assert data == b"B" * 3

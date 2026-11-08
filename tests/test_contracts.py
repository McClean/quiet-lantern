"""Contract v1 (docs/CONTRACTS.md). Validators + schemas are the coordinator's; registry functions are pending.

Pending tests are xfail(strict=True): implementing the seam makes them XPASS, which fails the run until the
implementer removes the marker in the same commit.
"""
from __future__ import annotations

import copy
import hashlib
import json
import sqlite3
import zipfile
from pathlib import Path

import pytest

from conftest import ROOT, load_module

contracts = load_module("contracts")

pending = pytest.mark.xfail(strict=True, reason="contract v1 seam not implemented yet (Wave 1)")


def _json(rel: str) -> dict:
    return json.loads((ROOT / rel).read_text(encoding="utf-8"))


# ---------- schemas exist and are the files the validators use ----------

def test_schema_files_are_valid_json_and_versioned():
    for rel in ("contracts/adapter-manifest.schema.json", "contracts/pack-manifest.schema.json",
                "contracts/game-context.schema.json"):
        s = _json(rel)
        assert s["type"] == "object"
        assert s["properties"].get("contract", s["properties"].get("v"))["const"] == 1


# ---------- adapter manifest ----------

def test_mgba_manifest_is_valid():
    assert contracts.validate_adapter_manifest(_json("adapters/mgba/manifest.json")) == []


def test_adapter_manifest_rejects_missing_licence_and_bad_id():
    m = _json("adapters/mgba/manifest.json")
    del m["licence"]
    m["id"] = "MGBA!"
    errors = contracts.validate_adapter_manifest(m)
    assert any("licence" in e for e in errors)
    assert any("id" in e for e in errors)


def test_adapter_manifest_rejects_unknown_capability_button_and_extra_keys():
    m = _json("adapters/mgba/manifest.json")
    m["capabilities"].append("teleport")
    m["buttons"].append("TURBO")
    m["surprise"] = True
    errors = contracts.validate_adapter_manifest(m)
    assert any("capabilities" in e for e in errors)
    assert any("buttons" in e for e in errors)
    assert any("surprise" in e for e in errors)


def test_wasm_adapter_requires_files_and_binding_external_does_not():
    m = _json("adapters/mgba/manifest.json")
    del m["runtime"]["files"]
    assert any("files" in e for e in contracts.validate_adapter_manifest(m))
    m["runtime"] = {"kind": "external"}
    assert contracts.validate_adapter_manifest(m) == []


def test_extension_must_be_dotted_lowercase():
    m = _json("adapters/mgba/manifest.json")
    m["systems"][0]["extensions"] = ["GBA"]
    assert any("extensions" in e for e in contracts.validate_adapter_manifest(m))


GBA_KEYINPUT_BITS = ["A", "B", "SELECT", "START", "RIGHT", "LEFT", "UP", "DOWN", "R", "L"]


def test_mgba_buttons_follow_the_gba_keyinput_bit_order():
    """Contract §3: an adapter's `buttons` order is its core's input bit order; for mGBA that is GBA KEYINPUT."""
    assert _json("adapters/mgba/manifest.json")["buttons"] == GBA_KEYINPUT_BITS


# ---------- pack manifest ----------

FIRERED_PACK = {"contract": 1, "id": "firered-bpre", "name": "Pokémon FireRed (USA)", "adapter": "mgba",
                "match": {"codes": ["BPRE"]}, "provides": ["gameplayMode", "isPaused", "readState", "actors"],
                "actorSwap": "avatar", "skill": "game-firered-bpre"}


def test_pack_manifest_example_is_valid():
    assert contracts.validate_pack_manifest(FIRERED_PACK) == []


def test_pack_manifest_needs_a_match_rule():
    p = copy.deepcopy(FIRERED_PACK)
    p["match"] = {}
    assert any("match" in e for e in contracts.validate_pack_manifest(p))


def test_pack_sha1_must_be_40_hex():
    p = copy.deepcopy(FIRERED_PACK)
    p["match"] = {"sha1": ["abc"]}
    assert any("sha1" in e for e in contracts.validate_pack_manifest(p))


# ---------- game context ----------

LAUNCHED = {
    "v": 1, "stage": "launched",
    "system": {"id": "gba", "adapter": "mgba"},
    "title": {"id": "3f2a9c0d11223344", "name": "Pokemon - FireRed Version (USA)", "code": "BPRE",
              "pack": "firered-bpre", "skill": "game-firered-bpre"},
    "campaign": {"id": "c_main0001", "name": "Main run", "slot": None, "lastPlayedAt": None},
    "resume": {"objectives": {}, "mode": "assist", "style": "together", "reflexes": ["mash_text"],
               "note": "Just beat Brock.", "updatedAt": None},
}


def test_launched_context_is_valid():
    assert contracts.validate_game_context(LAUNCHED) == []


def test_launched_context_requires_resume():
    c = copy.deepcopy(LAUNCHED)
    del c["resume"]
    assert any("resume" in e for e in contracts.validate_game_context(c))


def test_system_selected_needs_only_system():
    assert contracts.validate_game_context({"v": 1, "stage": "system_selected",
                                            "system": {"id": "gba", "adapter": "mgba"}}) == []


def test_context_rejects_bad_mode_and_stage():
    c = copy.deepcopy(LAUNCHED)
    c["resume"]["mode"] = "watch"
    c["stage"] = "playing"
    errors = contracts.validate_game_context(c)
    assert any("mode" in e for e in errors)
    assert any("stage" in e for e in errors)


# ---------- library SQL ----------

def test_library_sql_applies_and_sets_version(tmp_path):
    db = sqlite3.connect(tmp_path / "library.db")
    db.executescript(contracts.LIBRARY_SQL)
    assert db.execute("PRAGMA user_version").fetchone()[0] == 1
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"roots", "titles", "unsupported", "campaigns", "saves"} <= tables
    db.executescript(contracts.LIBRARY_SQL)  # idempotent


def test_library_sql_rejects_unknown_root_kind(tmp_path):
    db = sqlite3.connect(tmp_path / "library.db")
    db.executescript(contracts.LIBRARY_SQL)
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO roots(path, kind, added_at) VALUES ('x', 'cloud', 'now')")


# ---------- pending: Wave 1 implements these (signatures fixed by CONTRACTS.md §9) ----------

def _gba_bytes(code: bytes = b"BPRE") -> bytes:
    rom = bytearray(0x200)
    rom[0xA0:0xAC] = b"POKEMON FIRE"
    rom[0xAC:0xB0] = code
    rom[0xB2] = 0x96
    return bytes(rom)


def _adapters_dir(tmp_path: Path) -> Path:
    root = tmp_path / "adapters"
    (root / "mgba").mkdir(parents=True)
    (root / "mgba" / "manifest.json").write_text((ROOT / "adapters/mgba/manifest.json").read_text("utf-8"), "utf-8")
    return root


def test_discover_adapters_finds_valid_and_skips_invalid(tmp_path):
    root = _adapters_dir(tmp_path)
    (root / "broken").mkdir()
    (root / "broken" / "manifest.json").write_text("{not json", "utf-8")
    found = contracts.discover_adapters(root)
    assert [a.id for a in found] == ["mgba"]


def test_dummy_adapter_drop_in_and_removal(tmp_path):
    root = _adapters_dir(tmp_path)
    dummy = root / "dummy"
    dummy.mkdir()
    (dummy / "manifest.json").write_text(json.dumps({
        "contract": 1, "id": "dummy", "name": "Dummy", "licence": "MIT", "runtime": {"kind": "external"},
        "systems": [{"id": "dmy", "name": "Dummy", "extensions": [".dmy"]}],
        "buttons": ["A"], "capabilities": ["input"]}), "utf-8")
    assert {a.id for a in contracts.discover_adapters(root)} == {"mgba", "dummy"}
    for f in dummy.iterdir():
        f.unlink()
    dummy.rmdir()
    assert {a.id for a in contracts.discover_adapters(root)} == {"mgba"}


def test_match_file_reads_inside_zip_and_checks_header(tmp_path):
    adapters = contracts.discover_adapters(_adapters_dir(tmp_path))
    z = tmp_path / "game.zip"
    with zipfile.ZipFile(z, "w") as f:
        f.writestr("readme.txt", "hi")
        f.writestr("Game (USA).gba", _gba_bytes())
    m = contracts.match_file(z, adapters)
    assert (m.adapter, m.system, m.code, m.inner) == ("mgba", "gba", "BPRE", "Game (USA).gba")


def test_match_file_rejects_wrong_header_and_unclaimed_ext(tmp_path):
    adapters = contracts.discover_adapters(_adapters_dir(tmp_path))
    bad = tmp_path / "fake.gba"
    bad.write_bytes(b"\0" * 0x200)
    sfc = tmp_path / "x.sfc"
    sfc.write_bytes(b"\0" * 0x200)
    assert contracts.match_file(bad, adapters) is None
    assert contracts.match_file(sfc, adapters) is None


def test_scan_library_is_read_only_and_counts_unsupported(tmp_path):
    adapters = contracts.discover_adapters(_adapters_dir(tmp_path))
    roms = tmp_path / "ROMs"
    roms.mkdir()
    (roms / "a.gba").write_bytes(_gba_bytes())
    (roms / "b.sfc").write_bytes(b"\0" * 64)
    (roms / "a.sav").write_bytes(b"\1" * 64)
    before = {p.name: (p.stat().st_mtime_ns, p.read_bytes()) for p in roms.iterdir()}
    db = sqlite3.connect(tmp_path / "library.db")
    db.executescript(contracts.LIBRARY_SQL)
    report = contracts.scan_library(db, [roms], adapters, packs=[])
    assert report.titles == 1 and report.unsupported == {".sfc": 1}
    after = {p.name: (p.stat().st_mtime_ns, p.read_bytes()) for p in roms.iterdir()}
    assert before == after


def test_mgba_core_files_present():
    """CONTRACTS §1: an adapter's runtime.files live inside its own folder (Phase 0 moves web/dist here)."""
    m = _json("adapters/mgba/manifest.json")
    for rel in m["runtime"]["files"] + [m["runtime"]["binding"]]:
        assert (ROOT / "adapters/mgba" / rel).is_file(), rel

# ---------- registry behaviour beyond the flipped seams ----------

def _db(tmp_path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(tmp_path / "library.db")
    db.executescript(contracts.LIBRARY_SQL)
    return db


def _scan(tmp_path: Path, roms: Path, packs=(), adapters=None) -> sqlite3.Connection:
    if adapters is None:
        adapters = contracts.discover_adapters(_adapters_dir(tmp_path))
    db = _db(tmp_path)
    contracts.scan_library(db, [roms], adapters, list(packs))
    return db


def test_discover_packs_keeps_only_packs_whose_adapter_is_installed(tmp_path):
    adapters = contracts.discover_adapters(_adapters_dir(tmp_path))
    packs = tmp_path / "packs"
    for pid, adapter in (("firered-bpre", "mgba"), ("orphan", "quicknes")):
        (packs / pid).mkdir(parents=True)
        (packs / pid / "manifest.json").write_text(
            json.dumps({**FIRERED_PACK, "id": pid, "adapter": adapter}), "utf-8")
    assert [p.id for p in contracts.discover_packs(packs, adapters)] == ["firered-bpre"]


def test_scan_library_title_id_is_the_first_16_hex_of_the_rom_sha1(tmp_path):
    roms = tmp_path / "ROMs"
    roms.mkdir()
    rom = _gba_bytes()
    (roms / "a.gba").write_bytes(rom)
    db = _scan(tmp_path, roms)
    assert db.execute("SELECT id FROM titles").fetchall() == [(hashlib.sha1(rom).hexdigest()[:16],)]


def test_scan_library_title_id_of_a_zip_is_the_hash_of_the_inner_file(tmp_path):
    roms = tmp_path / "ROMs"
    roms.mkdir()
    rom = _gba_bytes()
    with zipfile.ZipFile(roms / "b.zip", "w") as f:
        f.writestr("Game.gba", rom)
    db = _scan(tmp_path, roms)
    assert db.execute("SELECT id FROM titles").fetchall() == [(hashlib.sha1(rom).hexdigest()[:16],)]


def test_scan_library_stores_name_system_adapter_code_and_header_title(tmp_path):
    roms = tmp_path / "ROMs"
    roms.mkdir()
    (roms / "a.gba").write_bytes(_gba_bytes())
    db = _scan(tmp_path, roms)
    assert db.execute("SELECT name, system, adapter, code, header_title FROM titles").fetchall() == \
        [("a", "gba", "mgba", "BPRE", "POKEMON FIRE")]


def test_scan_library_records_the_pack_matched_by_code(tmp_path):
    roms = tmp_path / "ROMs"
    roms.mkdir()
    (roms / "a.gba").write_bytes(_gba_bytes())
    pack = contracts.Pack(id="firered-bpre", path=tmp_path, manifest=FIRERED_PACK)
    db = _scan(tmp_path, roms, packs=[pack])
    assert db.execute("SELECT pack FROM titles").fetchall() == [("firered-bpre",)]


def test_scan_library_keeps_a_vanished_title_as_missing(tmp_path):
    roms = tmp_path / "ROMs"
    roms.mkdir()
    (roms / "a.gba").write_bytes(_gba_bytes())
    adapters = contracts.discover_adapters(_adapters_dir(tmp_path))
    db = _scan(tmp_path, roms, adapters=adapters)
    (roms / "a.gba").unlink()
    contracts.scan_library(db, [roms], adapters, [])
    assert db.execute("SELECT missing FROM titles").fetchall() == [(1,)]


def test_scan_library_never_matches_a_sav_file(tmp_path, monkeypatch):
    roms = tmp_path / "ROMs"
    roms.mkdir()
    (roms / "a.gba").write_bytes(_gba_bytes())
    (roms / "a.sav").write_bytes(b"\1" * 64)
    seen: list[str] = []
    real = contracts.match_file
    monkeypatch.setattr(contracts, "match_file", lambda p, a: (seen.append(Path(p).name), real(p, a))[1])
    _scan(tmp_path, roms)
    assert seen == ["a.gba"]

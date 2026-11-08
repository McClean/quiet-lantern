"""Game mode backend core: profile binding, ROM serving, mailbox, frame HTML. No Hermes needed."""
from __future__ import annotations

import base64
import zipfile
from pathlib import Path

import pytest

from conftest import load_module

core = load_module("game_mode_core")


def test_bound_profile_is_the_named_profile_dir_or_default(tmp_path):
    root = tmp_path / "hermes"
    assert core.bound_profile(root) == "default"
    assert core.bound_profile(root / "profiles" / "gamer") == "gamer"


def test_health_reports_bound_profile(tmp_path):
    home = tmp_path / "hermes" / "profiles" / "gamer"
    h = core.health(home)
    assert h["ok"] is True
    assert h["profile"] == "gamer"
    assert h["plugin"] == "emulator-catalog"
    assert h["version"] == "0.1.0"


@pytest.fixture
def roms(tmp_path):
    d = tmp_path / "ROMs"
    d.mkdir()
    (d / "Plain.gba").write_bytes(b"A" * 5)
    with zipfile.ZipFile(d / "Zipped.zip", "w") as z:
        z.writestr("Zipped.gba", b"Z" * 7)
        z.writestr("readme.txt", b"not a rom")
    return d


def test_rom_info_reads_zip_in_memory_and_reports_size(roms):
    info = core.rom_info([roms], "Zipped.zip")
    assert info == {"name": "Zipped.zip", "size": 7, "chunks": 1, "chunk": core.CHUNK}


def test_rom_chunk_returns_base64_slice(roms):
    out = core.rom_chunk([roms], "Plain.gba", 0)
    assert base64.b64decode(out["b64"]) == b"AAAAA"


def test_zipped_rom_is_decompressed_once_across_chunk_requests(roms, monkeypatch):
    # Counts decompressions (ZipFile.read of the game entry), not archive opens: the listing check
    # opens archives to see what is inside, which is metadata only and does not decompress the ROM.
    reads = []
    real_read = zipfile.ZipFile.read

    def counting(self, name, *args, **kwargs):
        reads.append(name)
        return real_read(self, name, *args, **kwargs)

    monkeypatch.setattr(zipfile.ZipFile, "read", counting)
    monkeypatch.setattr(core, "CHUNK", 3)
    core.rom_info([roms], "Zipped.zip")
    for i in range(3):
        core.rom_chunk([roms], "Zipped.zip", i)
    assert reads == ["Zipped.gba"]  # cached: chunk requests must not re-decompress the whole ROM


def test_rom_chunks_split_at_chunk_size(roms, monkeypatch):
    monkeypatch.setattr(core, "CHUNK", 3)
    info = core.rom_info([roms], "Plain.gba")
    assert info["chunks"] == 2
    parts = [base64.b64decode(core.rom_chunk([roms], "Plain.gba", i)["b64"]) for i in range(2)]
    assert b"".join(parts) == b"AAAAA"


def test_rom_outside_allow_list_is_rejected(roms, tmp_path):
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "Secret.gba").write_bytes(b"S")
    with pytest.raises(ValueError, match="allow-listed"):
        core.rom_info([roms], str(outside / "Secret.gba"))
    with pytest.raises(ValueError, match="allow-listed"):
        core.rom_info([roms], "../elsewhere/Secret.gba")


def test_rom_name_not_in_allow_list_is_rejected(roms):
    with pytest.raises(ValueError, match="allow-listed"):
        core.rom_info([roms], "Missing.gba")


# ---------- mailbox: agent commands in, pane replies out ----------

def test_enqueued_command_is_taken_once(tmp_path):
    cmd = core.enqueue(tmp_path, {"op": "open"})
    assert cmd["op"] == "open" and cmd["id"] and cmd["queued_ms"] > 0
    assert [c["id"] for c in core.take_pending(tmp_path)] == [cmd["id"]]
    assert core.take_pending(tmp_path) == []


def test_reply_round_trip_through_wait_reply(tmp_path):
    cid = core.enqueue(tmp_path, {"op": "open"})["id"]
    assert core.wait_reply(tmp_path, cid, timeout=0.05) is None
    assert core.store_reply(tmp_path, {"id": cid, "ok": True})["ok"] is True
    reply = core.wait_reply(tmp_path, cid, timeout=1)
    assert reply["ok"] is True and reply["id"] == cid


def test_reply_rejects_non_alnum_id(tmp_path):
    assert core.store_reply(tmp_path, {"id": "../evil", "ok": True})["ok"] is False


# ---------- agent tool: game_mode op=open|status ----------

def test_game_mode_open_enqueues_an_open_command(tmp_path):
    import json
    out = json.loads(core.game_mode(tmp_path, {"op": "open"}))
    assert out["ok"] is True and out["command"] == "open" and out["id"]
    assert [c["op"] for c in core.take_pending(tmp_path)] == ["open"]


def test_game_mode_rejects_unknown_op(tmp_path):
    import json
    out = json.loads(core.game_mode(tmp_path, {"op": "download"}))
    assert out["ok"] is False and out["code"] == "bad_op"


def test_game_mode_schema_forbids_rom_search_and_download():
    desc = core.GAME_MODE_SCHEMA["description"].lower()
    assert "never search" in desc and "download" in desc and "rom" in desc
    assert core.GAME_MODE_SCHEMA["parameters"]["properties"]["op"]["enum"] == ["open", "status"]


def test_game_mode_status_reports_pending_count(tmp_path):
    import json
    assert json.loads(core.game_mode(tmp_path, {"op": "status"})) == {"ok": True, "pending": 0}
    core.game_mode(tmp_path, {"op": "open"})
    assert json.loads(core.game_mode(tmp_path, {"op": "status"})) == {"ok": True, "pending": 1}


# ---------- player frame: index.html with the shared player modules inlined; no core, no sibling fetch (CONTRACTS §11.1) ----------

FAKE_INDEX = (
    "<script type=\"module\">\n"
    "__PRELUDE__\n"
    "  const p = createPlayer({ contracts, controls });\n"
    "</script>\n"
)


def _fake_web(root: Path) -> Path:
    # The shared player modules (player/, engine/) and the mGBA core's own folder (adapters/mgba/core, for assets()).
    core_dir = root.parent / "adapters" / "mgba" / "core"
    (root / "player").mkdir(parents=True)
    (root / "engine").mkdir(parents=True)
    core_dir.mkdir(parents=True)
    (root / "player" / "index.html").write_text(FAKE_INDEX, encoding="utf-8")
    (root / "player" / "controls.mjs").write_text("export const STANDARD_PAD = {};", encoding="utf-8")
    (root / "player" / "player.mjs").write_text("export function createPlayer() {}", encoding="utf-8")
    (root / "engine" / "contracts.mjs").write_text("export function assertCoreHandle() {}", encoding="utf-8")
    (core_dir / "mgba.mjs").write_text("export default function createMgba(){}", encoding="utf-8")
    (core_dir / "mgba.wasm").write_bytes(b"\x00asm\x01\x00\x00\x00")
    return root


def test_frame_html_inlines_the_shared_modules(tmp_path):
    html = core.frame_html(_fake_web(tmp_path / "web"))
    assert "__PRELUDE__" not in html
    assert "export function createPlayer" in html         # player/player.mjs source travels as a string
    assert "export const STANDARD_PAD" in html            # player/controls.mjs source travels as a string
    assert "export function assertCoreHandle" in html     # engine/contracts.mjs source travels as a string


def test_frame_html_does_not_inline_the_mgba_core(tmp_path):
    html = core.frame_html(_fake_web(tmp_path / "web"))
    assert "createMgba" not in html                       # the core arrives in load(), not in the frame
    assert "mgba" not in html.lower()


def test_frame_html_has_no_sibling_imports_and_fetches_nothing(tmp_path):
    html = core.frame_html(_fake_web(tmp_path / "web"))
    assert "from './" not in html and "import './" not in html
    assert "fetch(" not in html


def test_frame_html_takes_gamepad_from_host_not_navigator():
    html = core.frame_html()  # the real page: its host-pad listener is the only gamepad source
    assert "navigator.getGamepads" not in html
    assert "e.data.t !== 'host-pad'" in html  # the host's snapshot is read from its message


def test_frame_html_refuses_when_player_changed(tmp_path):
    web = _fake_web(tmp_path / "web")
    (web / "player" / "index.html").write_text("<html>changed</html>", encoding="utf-8")
    with pytest.raises(ValueError, match="cannot patch"):
        core.frame_html(web)


def test_assets_returns_html_and_base64_wasm(tmp_path):
    web = _fake_web(tmp_path / "web")
    a = core.assets(web)
    assert base64.b64decode(a["wasm_b64"]) == b"\x00asm\x01\x00\x00\x00"
    assert a["wasm_size"] == 8 and "createPlayer" in a["html"]


def test_default_web_dir_is_this_plugins_own_web_folder():
    assert core.WEB_DIR == Path(core.__file__).resolve().parent / "web"


def test_real_player_frame_builds_from_the_repo_web_folder():
    html = core.frame_html()  # default: this repo's web/ folder, no fixtures
    player = (core.WEB_DIR / "player" / "player.mjs").read_text(encoding="utf-8")
    assert "__PRELUDE__" not in html
    assert "createMgba" not in html and "_hm_" not in html
    assert "export function createPlayer" in html
    assert len(html) > len(player)  # the player module source travels inside the frame


# ---------- allow-list: catalog game_dirs + default folder, nothing else ----------

def test_allowed_rom_dirs_is_catalog_game_dirs_plus_default(tmp_path):
    import json
    data = tmp_path / "data"
    data.mkdir()
    mine = tmp_path / "MyGames"
    mine.mkdir()
    default = tmp_path / "Default"
    default.mkdir()
    (data / "catalog.json").write_text(json.dumps({"game_dirs": [str(mine)], "emulator_dirs": []}), encoding="utf-8")
    dirs = core.allowed_rom_dirs(data, [default])
    assert [str(p) for p in dirs] == [str(mine), str(default)]


def test_allowed_rom_dirs_skips_folders_that_do_not_exist(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    assert core.allowed_rom_dirs(data, [tmp_path / "gone"]) == []


def test_rom_without_name_picks_first_rom_in_allow_list(roms):
    info = core.rom_info([roms])
    assert info["name"] == "Plain.gba"  # sorted: Plain.gba before Zipped.zip


def test_log_event_appends_a_jsonl_line(tmp_path):
    import json
    core.log_event(tmp_path, {"kind": "boot", "data": {"x": 1}})
    core.log_event(tmp_path, {"kind": "load"})
    lines = (tmp_path / "events.jsonl").read_text(encoding="utf-8").splitlines()
    recs = [json.loads(l) for l in lines]
    assert [r["kind"] for r in recs] == ["boot", "load"]
    assert recs[0]["data"] == {"x": 1} and recs[0]["server_ms"] > 0


# ---------- resolution helpers shared by the tool and the dashboard routes ----------

def test_current_home_honours_hermes_home_env(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes" / "profiles" / "gamer"))
    assert core.current_home().name == "gamer"


def test_resolve_data_dir_honours_override_env(tmp_path, monkeypatch):
    monkeypatch.setenv("EMULATOR_CATALOG_DATA_DIR", str(tmp_path / "d"))
    assert core.resolve_data_dir() == tmp_path / "d"


def test_rom_folders_are_catalog_folders_plus_defaults(tmp_path, monkeypatch):
    import json
    data = tmp_path / "data"
    data.mkdir()
    mine, default = tmp_path / "Mine", tmp_path / "Default"
    mine.mkdir()
    default.mkdir()
    (data / "catalog.json").write_text(json.dumps({"game_dirs": [str(mine)], "emulator_dirs": []}), encoding="utf-8")
    monkeypatch.setenv("EMULATOR_CATALOG_DATA_DIR", str(data))
    monkeypatch.setattr(core, "DEFAULT_ROM_DIRS", [default])
    assert core.rom_folders() == [mine, default]



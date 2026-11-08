"""The localhost game file server, exercised over real HTTP on an ephemeral port. No Hermes needed.

Synthetic GBA ROMs in temp folders only. The real ROM folder and real saves are never touched.
"""
from __future__ import annotations

import hashlib
import json
import socket
import threading
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

import pytest

from conftest import ROOT, load_module

core = load_module("game_mode_core")
fs = load_module("game_file_server")
MGBA_MANIFEST = (ROOT / "adapters/mgba/manifest.json").read_bytes()


# ---------- synthetic ROMs: 0xC0 bytes, title at 0xA0, code at 0xAC, Nintendo marker 0x96 at 0xB2 ----------

def gba(title: bytes = b"POKEMON FIRE", code: bytes = b"BPRE", salt: int = 0) -> bytes:
    rom = bytearray(0xC0)
    rom[0xA0:0xA0 + len(title)] = title
    rom[0xAC:0xB0] = code
    rom[0xB2] = 0x96
    rom[-1] = salt
    return bytes(rom)


def tid(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()[:16]


def make_roms(tmp_path: Path) -> Path:
    d = tmp_path / "ROMs"
    d.mkdir()
    (d / "Pokemon - FireRed Version (USA).gba").write_bytes(gba())
    (d / "Metroid.gba").write_bytes(gba(b"METROID", b"AMTE", salt=1))
    with zipfile.ZipFile(d / "Zelda.zip", "w") as z:
        z.writestr("Zelda (USA).gba", gba(b"ZELDA", b"BZME", salt=2))
    (d / "Pokemon - FireRed Version (USA).sav").write_bytes(b"save-bytes")
    (d / "Chrono.sfc").write_bytes(b"\0" * 64)
    (d / "notes.md").write_bytes(b"\0" * 64)
    (d / "Other.z64").write_bytes(b"\0" * 64)
    (tmp_path / "secret.gba").write_bytes(gba(b"SECRET", b"XXXX", salt=3))  # outside the allow-list
    return d


def make_adapters(root: Path, with_core: bool = False) -> Path:
    (root / "mgba").mkdir(parents=True)
    (root / "mgba" / "manifest.json").write_bytes(MGBA_MANIFEST)
    if with_core:
        (root / "mgba" / "core").mkdir()
        (root / "mgba" / "core" / "mgba.mjs").write_bytes(b"export default 1;")
        (root / "mgba" / "core" / "mgba.wasm").write_bytes(b"\0asm-core")
        (root / "mgba" / "binding.mjs").write_bytes(b"export default 2;")
    return root


def get(base, path):
    try:
        with urllib.request.urlopen(base + path, timeout=5) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


@pytest.fixture
def boot(tmp_path):
    servers = []

    def _boot(adapters, roms=None, web=core.WEB_DIR):
        folders = (lambda: [roms]) if roms is not None else (lambda: [])
        srv = fs.serve(port=0, folders=folders, web=web, adapters_dir=adapters, packs_dir=tmp_path / "no-packs")
        servers.append(srv)
        return f"http://127.0.0.1:{srv.server_address[1]}"

    yield _boot
    for srv in servers:
        srv.shutdown()
        srv.server_close()


@pytest.fixture
def lib(tmp_path, boot):
    roms = make_roms(tmp_path)
    adapters = make_adapters(tmp_path / "adapters")
    return {"base": boot(adapters, roms), "roms": roms, "adapters": adapters, "tmp": tmp_path}


@pytest.fixture
def server(lib):
    return lib["base"]


# ---------- routes that stay ----------

def test_health_names_the_plugin_and_version(server):
    status, _, body = get(server, "/health")
    data = json.loads(body)
    assert status == 200
    assert data["plugin"] == "emulator-catalog" and data["version"] == core.VERSION


def test_legacy_mgba_wasm_route_is_gone(server):
    """Cores are served only from /core/<adapter>/ (CONTRACTS §11.2); the old fixed route is removed."""
    status, _, _ = get(server, "/mgba.wasm")
    assert status == 404


def test_player_frame_is_html_with_the_neutral_player_and_no_core(server):
    """The frame inlines the emulator-neutral player; the core arrives later in the load message (§11.1)."""
    status, headers, body = get(server, "/player.html")
    assert status == 200
    assert headers["Content-Type"].startswith("text/html")
    text = body.decode("utf-8")
    assert "createPlayer" in text and "__PRELUDE__" not in text
    assert "createMgba" not in text


def test_unknown_route_is_404(server):
    status, _, _ = get(server, "/etc/passwd")
    assert status == 404


@pytest.mark.parametrize("method", ["POST", "PUT", "DELETE", "PATCH"])
def test_non_get_methods_are_refused_with_405(server, method):
    data = None if method == "DELETE" else b"{}"
    req = urllib.request.Request(server + "/library", data=data, method=method)
    try:
        urllib.request.urlopen(req, timeout=5)
        status, allow = 200, None
    except urllib.error.HTTPError as e:
        status, allow = e.code, e.headers.get("Allow")
    assert status == 405 and allow == "GET"


@pytest.mark.parametrize("path", ["/health", "/library", "/library/gba", "/rom/" + tid(gba()), "/rom/0000000000000000"])
def test_every_response_allows_any_origin_and_is_not_cached(server, path):
    _, headers, _ = get(server, path)
    assert headers["Access-Control-Allow-Origin"] == "*"
    assert headers["Cache-Control"] == "no-store"


# ---------- /library (CONTRACTS §7, §5): scanned at start, rescanned on ?rescan=1 ----------

def test_library_lists_only_systems_that_have_titles(server):
    status, _, body = get(server, "/library")
    assert status == 200
    assert json.loads(body)["systems"] == [{"id": "gba", "name": "Game Boy Advance", "adapter": "mgba", "count": 3}]


def test_library_counts_unsupported_files_per_extension_and_never_counts_saves(server):
    _, _, body = get(server, "/library")
    assert json.loads(body)["unsupported"] == {".sfc": 1, ".md": 1, ".z64": 1}


def test_library_system_lists_titles_sorted_by_name(server):
    status, _, body = get(server, "/library/gba")
    assert status == 200
    assert json.loads(body)["system"] == "gba"
    assert [t["name"] for t in json.loads(body)["titles"]] == [
        "Metroid", "Pokemon - FireRed Version (USA)", "Zelda"]


def test_library_title_carries_id_name_code_header_title_pack_and_adapter(server):
    _, _, body = get(server, "/library/gba")
    titles = {t["name"]: t for t in json.loads(body)["titles"]}
    assert titles["Metroid"] == {"id": tid(gba(b"METROID", b"AMTE", salt=1)), "name": "Metroid", "code": "AMTE",
                                 "headerTitle": "METROID", "pack": None, "adapter": "mgba"}


def test_library_title_of_a_zip_has_the_hash_of_its_inner_game(server):
    _, _, body = get(server, "/library/gba")
    titles = {t["name"]: t for t in json.loads(body)["titles"]}
    assert titles["Zelda"]["id"] == tid(gba(b"ZELDA", b"BZME", salt=2))


def test_library_responses_carry_no_paths(lib):
    _, _, a = get(lib["base"], "/library")
    _, _, b = get(lib["base"], "/library/gba")
    for body in (a, b):
        assert str(lib["tmp"]) not in body.decode("utf-8")
        assert b"path" not in body


def test_unknown_system_is_404(server):
    status, _, _ = get(server, "/library/nintendo-ds")
    assert status == 404


def test_known_system_without_titles_is_an_empty_list(server):
    status, _, body = get(server, "/library/gbc")
    assert status == 200 and json.loads(body) == {"system": "gbc", "titles": []}


def test_a_file_outside_the_allow_list_is_never_listed(lib):
    _, _, body = get(lib["base"], "/library/gba")
    assert b"SECRET" not in body
    assert get(lib["base"], "/rom/" + tid(gba(b"SECRET", b"XXXX", salt=3)))[0] == 404


def test_rescan_query_picks_up_new_files(lib):
    (lib["roms"] / "Mario.gba").write_bytes(gba(b"MARIO", b"AMAE", salt=4))
    assert json.loads(get(lib["base"], "/library")[2])["systems"][0]["count"] == 3
    assert json.loads(get(lib["base"], "/library?rescan=1")[2])["systems"][0]["count"] == 4


def test_rescan_drops_a_removed_file_and_stops_serving_it(lib):
    removed = tid(gba())
    assert get(lib["base"], "/rom/" + removed)[0] == 200
    (lib["roms"] / "Pokemon - FireRed Version (USA).gba").unlink()
    assert json.loads(get(lib["base"], "/library?rescan=1")[2])["systems"][0]["count"] == 2
    assert get(lib["base"], "/rom/" + removed)[0] == 404


def test_requests_during_a_rescan_all_succeed(lib):
    base, errors = lib["base"], []

    def rescans():
        for _ in range(10):
            get(base, "/library?rescan=1")

    def reads():
        for _ in range(30):
            status, _, body = get(base, "/library/gba")
            if status != 200 or "titles" not in json.loads(body):
                errors.append(status)

    threads = [threading.Thread(target=rescans), threading.Thread(target=reads), threading.Thread(target=reads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    assert errors == []


# ---------- /rom/<titleId>: scanned titles only, bytes only from the allow-list ----------

def test_rom_serves_the_game_bytes_of_a_scanned_title(server):
    status, headers, body = get(server, "/rom/" + tid(gba()))
    assert status == 200 and body == gba()
    assert headers["Content-Type"] == "application/octet-stream"


def test_rom_serves_the_inner_game_bytes_of_a_zip(server):
    status, _, body = get(server, "/rom/" + tid(gba(b"ZELDA", b"BZME", salt=2)))
    assert status == 200 and body == gba(b"ZELDA", b"BZME", salt=2)


def test_unknown_title_id_is_404(server):
    assert get(server, "/rom/0000000000000000")[0] == 404


def test_save_file_content_is_never_served(server):
    status, _, body = get(server, "/rom/" + tid(b"save-bytes"))
    assert status == 404 and b"save-bytes" not in body


@pytest.mark.parametrize("name", ["Metroid.gba", "list", "..%2Fsecret.gba", "..%5Csecret.gba", "%2e%2e",
                                  "0123456789abcdeg", "Pokemon%20-%20FireRed%20Version%20(USA).gba"])
def test_rom_takes_only_title_ids_so_names_and_traversal_are_404(server, name):
    status, _, body = get(server, "/rom/" + name)
    assert status == 404
    assert b"SECRET" not in body


def test_old_rom_list_route_is_gone(server):
    assert get(server, "/rom/list")[0] == 404


# ---------- /adapters and /core/<adapterId>/<file> (CONTRACTS §11.2) ----------

def test_adapters_lists_each_wasm_adapter_whose_core_files_are_on_disk(tmp_path, boot):
    base = boot(make_adapters(tmp_path / "core-adapters", with_core=True))
    status, _, body = get(base, "/adapters")
    manifest = json.loads(MGBA_MANIFEST)
    assert status == 200
    assert json.loads(body) == [{k: manifest[k] for k in ("id", "name", "buttons", "controls", "capabilities", "systems")}]


def test_adapters_leaves_out_an_adapter_whose_core_files_are_missing(server):
    assert json.loads(get(server, "/adapters")[2]) == []


@pytest.mark.parametrize("rel, data", [("core/mgba.mjs", b"export default 1;"), ("binding.mjs", b"export default 2;")])
def test_core_serves_the_manifest_files_and_binding(tmp_path, boot, rel, data):
    base = boot(make_adapters(tmp_path / "core-adapters", with_core=True))
    status, _, body = get(base, "/core/mgba/" + rel)
    assert status == 200 and body == data


def test_core_wasm_is_served_as_application_wasm(tmp_path, boot):
    base = boot(make_adapters(tmp_path / "core-adapters", with_core=True))
    status, headers, _ = get(base, "/core/mgba/core/mgba.wasm")
    assert status == 200 and headers["Content-Type"] == "application/wasm"


@pytest.mark.parametrize("rel", ["core/extra.txt", "adapter.py", "manifest.json", "README.md"])
def test_core_refuses_files_the_manifest_does_not_list(tmp_path, boot, rel):
    adapters = make_adapters(tmp_path / "core-adapters", with_core=True)
    (adapters / "mgba" / "core" / "extra.txt").write_bytes(b"not listed")
    (adapters / "mgba" / "adapter.py").write_bytes(b"not listed")
    (adapters / "mgba" / "README.md").write_bytes(b"not listed")
    status, _, body = get(boot(adapters), "/core/mgba/" + rel)
    assert status == 404 and b"not listed" not in body


@pytest.mark.parametrize("path", ["/core/mgba/../manifest.json", "/core/mgba/%2e%2e/manifest.json",
                                  "/core/nope/core/mgba.mjs", "/core/mgba/"])
def test_core_refuses_traversal_and_unknown_adapters(tmp_path, boot, path):
    base = boot(make_adapters(tmp_path / "core-adapters", with_core=True))
    status, _, body = get(base, path)
    assert status == 404 and b"export default" not in body and b"contract" not in body


def test_core_refuses_a_listed_file_that_is_missing_on_disk(tmp_path, boot):
    adapters = make_adapters(tmp_path / "core-adapters", with_core=True)
    (adapters / "mgba" / "core" / "mgba.wasm").unlink()
    assert get(boot(adapters), "/core/mgba/core/mgba.wasm")[0] == 404


# ---------- binding and start-up: once per process, reuse our own, never crash on a taken port ----------

@pytest.fixture
def fresh(monkeypatch):
    """Each test starts with no server running in this process."""
    monkeypatch.setattr(fs, "_SERVER", None)
    monkeypatch.delenv("EMULATOR_CATALOG_FILE_PORT", raising=False)
    yield fs
    srv = fs._SERVER
    if srv is not None:
        srv.shutdown()
        srv.server_close()
        monkeypatch.setattr(fs, "_SERVER", None)


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def test_default_port_is_47911(fresh):
    assert fs.resolve_port() == 47911 and fs.DEFAULT_PORT == 47911


def test_port_can_be_overridden_by_environment(fresh, monkeypatch):
    monkeypatch.setenv("EMULATOR_CATALOG_FILE_PORT", "5555")
    assert fs.resolve_port() == 5555


@pytest.mark.parametrize("bad", ["abc", "0", "70000", "-1"])
def test_a_bad_port_override_falls_back_to_the_default(fresh, monkeypatch, bad):
    monkeypatch.setenv("EMULATOR_CATALOG_FILE_PORT", bad)
    assert fs.resolve_port() == 47911


def test_server_binds_to_loopback_only(fresh, lib):
    srv = fs.serve(port=0, folders=lambda: [lib["roms"]], web=core.WEB_DIR, adapters_dir=lib["adapters"])
    try:
        assert srv.server_address[0] == "127.0.0.1"
    finally:
        srv.shutdown()
        srv.server_close()


def test_ensure_started_starts_once_and_is_idempotent(fresh, lib):
    first = fs.ensure_started(port=0, folders=lambda: [lib["roms"]], web=core.WEB_DIR)
    assert first["state"] == "started" and first["port"] > 0
    server = fs._SERVER
    second = fs.ensure_started(port=0, folders=lambda: [lib["roms"]], web=core.WEB_DIR)
    assert second["state"] == "running" and second["port"] == first["port"]
    assert fs._SERVER is server  # the same server, not a second one


def test_ensure_started_reuses_a_port_already_served_by_this_plugin(fresh, lib):
    port = free_port()
    ours = fs.serve(port=port, folders=lambda: [lib["roms"]], web=core.WEB_DIR)  # another profile's gateway
    try:
        res = fs.ensure_started(port=port, folders=lambda: [lib["roms"]], web=core.WEB_DIR)
        assert res == {"state": "reused", "port": port}
    finally:
        ours.shutdown()
        ours.server_close()


def test_ensure_started_does_not_crash_when_another_program_holds_the_port(fresh, lib):
    squatter = socket.socket()
    squatter.bind(("127.0.0.1", 0))
    squatter.listen()
    port = squatter.getsockname()[1]
    try:
        res = fs.ensure_started(port=port, folders=lambda: [lib["roms"]], web=core.WEB_DIR)
        assert res["state"] == "unavailable" and res["port"] == port
        assert "127.0.0.1" in res["error"] and str(port) in res["error"]
        assert fs._SERVER is None
    finally:
        squatter.close()


def test_ensure_started_refuses_a_port_held_by_a_different_http_server(fresh, lib):
    # A foreign HTTP server answers /health with someone else's JSON: that is not ours, so do not reuse it.
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class Other(BaseHTTPRequestHandler):
        def do_GET(self):
            body = b'{"plugin": "some-other-plugin"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):
            pass

    other = HTTPServer(("127.0.0.1", 0), Other)
    threading.Thread(target=other.serve_forever, daemon=True).start()
    try:
        res = fs.ensure_started(port=other.server_address[1], folders=lambda: [lib["roms"]], web=core.WEB_DIR)
        assert res["state"] == "unavailable"
    finally:
        other.shutdown()
        other.server_close()

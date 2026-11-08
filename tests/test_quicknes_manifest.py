"""adapters/quicknes (CONTRACTS §1, §3, §11.3): manifest validity and layout, checked by the coordinator's validator."""
from __future__ import annotations

import hashlib
import json

from conftest import ROOT, load_module

contracts = load_module("contracts")
ADAPTER = ROOT / "adapters" / "quicknes"
LIBRETRO_ORDER = ["B", "Y", "SELECT", "START", "UP", "DOWN", "LEFT", "RIGHT", "A", "X", "L", "R", "L2", "R2"]


def _manifest() -> dict:
    return json.loads((ADAPTER / "manifest.json").read_text(encoding="utf-8"))


def _sha(path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_quicknes_manifest_passes_the_adapter_schema():
    assert contracts.validate_adapter_manifest(_manifest()) == []


def test_quicknes_buttons_are_exactly_the_libretro_joypad_order():
    # §11.3: every libretro adapter's buttons array is the RETRO_DEVICE_ID_JOYPAD order, bit i = buttons[i].
    assert _manifest()["buttons"] == LIBRETRO_ORDER


def test_quicknes_declares_its_runtime_files_and_they_exist_in_the_folder():
    m = _manifest()
    assert m["id"] == "quicknes" and ADAPTER.name == m["id"]
    assert m["runtime"]["files"] == ["core/core.mjs", "core/core.wasm"]
    assert m["runtime"]["binding"] == "binding.mjs"
    for rel in [*m["runtime"]["files"], m["runtime"]["binding"]]:
        assert (ADAPTER / rel).is_file(), rel


def test_quicknes_binding_is_the_shared_libretro_binding():
    # §11.3: the adapter's binding.mjs is a verbatim copy of libretro/binding.mjs.
    assert _sha(ADAPTER / "binding.mjs") == _sha(ROOT / "libretro" / "binding.mjs")


def test_quicknes_licence_is_gpl_2_or_later_as_granted_by_its_sources():
    # Top-level LICENSE is GPL-2.0 text; the sources grant "version 2 ... or (at your option) any later
    # version". nes_emu/ is LGPL-2.1 (or later) and is compiled in too: see README.
    assert _manifest()["licence"] == "GPL-2.0-or-later"

"""Guard: the suite's home is a scratch dir (conftest.py), so no test can scan the real user's ROM folder."""
from __future__ import annotations

from pathlib import Path

from conftest import ROOT, load_module

core = load_module("game_mode_core")
SCRATCH = ROOT / ".test-tmp"


def test_suite_home_is_the_scratch_dir():
    assert Path.home().is_relative_to(SCRATCH)


def test_default_rom_folders_are_inside_the_scratch_home():
    assert core.DEFAULT_ROM_DIRS and all(Path(p).is_relative_to(SCRATCH) for p in core.DEFAULT_ROM_DIRS)

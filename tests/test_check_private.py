"""The repository's commit guard: no personal paths, user names or save files may be committed."""
from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("check_private", ROOT / "scripts" / "check_private.py")
check_private = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_private)

# Sample paths are assembled at runtime so this file does not itself match the guard.
U = "Us" + "ers"


def test_a_windows_user_folder_path_is_refused():
    hits = check_private.scan_text("notes.md", f"rom at C:\\{U}\\someone\\Games\\x.gba\n")
    assert hits and hits[0][0] == "notes.md" and hits[0][1] == 1


def test_a_git_bash_user_folder_path_is_refused():
    assert check_private.scan_text("a.sh", f"cd /c/{U}/someone/stuff\n")


def test_a_linux_home_path_is_refused_but_emscripten_web_user_is_not():
    assert check_private.scan_text("a.py", "p = '/ho" + "me/alice/roms'\n")
    assert not check_private.scan_text("core.mjs", "var HOME='/home/web_user';\n")


def test_a_steam_library_path_is_refused():
    assert check_private.scan_text("a.md", "D:/Games/steam" + "apps/common/Thing/ROM/x.nes\n")


def test_extra_patterns_from_the_local_file_are_applied_case_insensitively():
    assert check_private.scan_text("a.md", "by Jane Q Public\n", extra=["jane q public"])
    assert not check_private.scan_text("a.md", "by someone else\n", extra=["jane q public"])


def test_clean_text_passes():
    assert check_private.scan_text("a.py", "ROOT = Path(__file__).parent\n") == []


def test_a_save_file_path_is_refused_by_name():
    assert check_private.scan_paths(["tests/fixtures/game.sav", "README.md"]) == ["tests/fixtures/game.sav"]


def test_the_tracked_tree_is_clean():
    files = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout
    paths = [p for p in files.decode("utf-8").split("\0") if p]
    assert check_private.scan_repo(ROOT, paths) == []

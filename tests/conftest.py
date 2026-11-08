from __future__ import annotations

import importlib.util
import os
import socket
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PKG = "emulator_catalog_plugin"

# The suite's home is a scratch dir inside the repo (.test-tmp, gitignored). Set before any module is loaded,
# so the default ROM folder and catalog path never point at the real user's profile.
SCRATCH_HOME = ROOT / ".test-tmp" / "home"
SCRATCH_HOME.mkdir(parents=True, exist_ok=True)
os.environ["HOME"] = os.environ["USERPROFILE"] = str(SCRATCH_HOME)


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# The router starts the localhost file server on load. Keep the suite off the real default port (47911),
# and keep the background keeper thread out of the suite (tests start it explicitly when they need it).
os.environ.setdefault("EMULATOR_CATALOG_FILE_PORT", str(_free_port()))
os.environ["EMULATOR_CATALOG_FILE_SERVER"] = "0"


def load_package():
    """Import the plugin the way Hermes does: as a package, so relative imports work."""
    if PKG in sys.modules:
        return sys.modules[PKG]
    spec = importlib.util.spec_from_file_location(PKG, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
    mod = importlib.util.module_from_spec(spec)
    sys.modules[PKG] = mod
    spec.loader.exec_module(mod)
    return mod


def load_module(name: str):
    load_package()
    return importlib.import_module(f"{PKG}.{name}")

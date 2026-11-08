"""emulator-catalog dashboard backend. Mounted at /api/plugins/emulator-catalog/.

Thin router over game_mode_core. The profile reported by /health is the one this request is bound to.
  GET  /health            {ok, profile, plugin, version}
  GET  /assets            player frame HTML + mgba.wasm (base64)
  GET  /rom/info          {name, size, chunks} for an allow-listed ROM (?name=, default first ROM)
  GET  /rom/chunk?i=N     base64 slice N of the ROM
  GET  /pending           agent commands queued for the pane (taken once)
  POST /reply             pane answers a command
  POST /event             pane evidence line -> events.jsonl
"""
from __future__ import annotations

import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import game_mode_core as core  # noqa: E402
import game_file_server  # noqa: E402

router = APIRouter()

# Start the localhost file server once, when the router loads. Never fatal: a taken port leaves the
# router up, and the desktop tile shows the state (unavailable) with the fix.
try:
    game_file_server.ensure_started()
except Exception:  # pragma: no cover - defensive; ensure_started already reports instead of raising
    pass


@router.get("/health")
async def health() -> dict:
    return core.health(core.current_home())


@router.get("/assets")
async def assets() -> dict:
    return core.assets()


@router.get("/rom/info")
async def rom_info(name: str = "") -> dict:
    try:
        return core.rom_info(core.rom_folders(), name or None)
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc))


@router.get("/rom/chunk")
async def rom_chunk(i: int, name: str = "") -> dict:
    try:
        return core.rom_chunk(core.rom_folders(), name or None, i)
    except (FileNotFoundError, ValueError, IndexError) as exc:
        raise HTTPException(404, str(exc))


@router.get("/pending")
async def pending() -> dict:
    return {"cmds": core.take_pending(core.resolve_data_dir())}


@router.post("/reply")
async def reply(body: dict) -> dict:
    return core.store_reply(core.resolve_data_dir(), body)


@router.post("/event")
async def event(body: dict) -> dict:
    return core.log_event(core.resolve_data_dir(), body)

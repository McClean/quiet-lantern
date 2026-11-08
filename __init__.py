"""emulator-catalog: catalog installed emulators and game folders and let the agent play.

Hermes calls register(ctx). Keep it fast and offline; work happens in the handlers.
"""
from __future__ import annotations

import inspect
import json
from pathlib import Path

PLUGIN_NAME = "emulator-catalog"
TOOLSET = "emulator-catalog"
VERSION = "0.1.0"

CATALOG_SCHEMA = {
    "name": "emu_catalog",
    "description": (
        "Emulator catalog. op=list shows installed emulators, games (with system and which emulator plays them) "
        "and the folders scanned. op=add_dir / remove_dir with kind=games|emulators and an absolute path "
        "changes which folders are scanned."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": ["list", "add_dir", "remove_dir"]},
            "kind": {"type": "string", "enum": ["games", "emulators"]},
            "path": {"type": "string"},
        },
        "required": ["op"],
        "additionalProperties": False,
    },
}

SESSION_SCHEMA = {
    "name": "emu_session",
    "description": (
        "Start, stop or check the one running game. op=start game=<id or part of name> [emulator=<id|kind>] "
        "opens the game in the emulator with the agent bridge. op=status, op=stop."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": ["start", "stop", "status"]},
            "game": {"type": "string"},
            "emulator": {"type": "string"},
        },
        "required": ["op"],
        "additionalProperties": False,
    },
}

PLAY_SCHEMA = {
    "name": "emu_play",
    "description": (
        "Play the running game. op=press steps=[\"UP\",\"A+B\",\"wait:30\"] (buttons A B L R START SELECT "
        "UP DOWN LEFT RIGHT; wait:N frames, 60/s; max 32 steps); op=screenshot returns the screen; "
        "op=save/load name=<label>; op=list_saves; op=read address=0x... length=N reads memory; op=reset; "
        "op=status. Move a few steps, then screenshot."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": ["press", "screenshot", "save", "load", "list_saves", "read",
                                               "reset", "status"]},
            "steps": {"type": "array", "items": {"type": "string"}},
            "hold_frames": {"type": "integer"},
            "gap_frames": {"type": "integer"},
            "name": {"type": "string"},
            "address": {"type": "string"},
            "length": {"type": "integer"},
        },
        "required": ["op"],
        "additionalProperties": False,
    },
}

_STATE = None


def _default_dirs():
    home = Path.home()
    return [home / "Emulators"], [home / "Emulators" / "ROMs"]


def _state():
    global _STATE
    if _STATE is None:
        from . import tools
        try:
            from plugins.plugin_storage import plugin_data_dir
            data_dir = plugin_data_dir(PLUGIN_NAME)
        except Exception:  # outside Hermes (tests, scripts)
            data_dir = Path.home() / ".emulator-catalog"
        emu_dirs, game_dirs = _default_dirs()
        _STATE = tools.State(data_dir, default_emulator_dirs=emu_dirs, default_game_dirs=game_dirs)
    return _STATE


def _wrap(fn_name):
    def handler(args: dict | None = None, **_kwargs):
        from . import tools
        try:
            return getattr(tools, fn_name)(_state(), args or {})
        except Exception as exc:  # never raise into the agent loop
            return json.dumps({"ok": False, "code": "internal", "error": f"{type(exc).__name__}: {exc}",
                               "fix": "Report this; try emu_session op=status."})
    return handler


def _register_tool_compat(register, **kwargs) -> None:
    """Pass only keywords the host's register_tool accepts (older/newer hosts differ)."""
    try:
        params = inspect.signature(register).parameters
    except (TypeError, ValueError):
        params = {}
    if params and not any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        kwargs = {k: v for k, v in kwargs.items() if k in params}
    register(**kwargs)


def _data_dir() -> Path:
    try:
        from plugins.plugin_storage import plugin_data_dir
        return plugin_data_dir(PLUGIN_NAME)
    except Exception:  # outside Hermes (tests, scripts)
        return Path.home() / ".emulator-catalog"


def _game_mode_handler(args: dict | None = None, **_kwargs):
    from . import game_mode_core
    try:
        return game_mode_core.game_mode(_data_dir(), args or {})
    except Exception as exc:  # never raise into the agent loop
        return json.dumps({"ok": False, "code": "internal", "error": f"{type(exc).__name__}: {exc}",
                           "fix": "Report this; try game_mode op=status."})


def register(ctx) -> None:
    """Keep fast: no network, no heavy imports. Lazy-import heavy deps inside handlers."""
    skills_dir = Path(__file__).resolve().parent / "skills"
    if skills_dir.is_dir() and hasattr(ctx, "register_skill"):
        for child in sorted(p for p in skills_dir.iterdir() if p.is_dir()):
            if (child / "SKILL.md").is_file():
                ctx.register_skill(child.name, child / "SKILL.md")

    for schema, fn_name, emoji in ((CATALOG_SCHEMA, "emu_catalog", "🗂️"),
                                   (SESSION_SCHEMA, "emu_session", "🎮"),
                                   (PLAY_SCHEMA, "emu_play", "🕹️")):
        _register_tool_compat(ctx.register_tool, name=schema["name"], toolset=TOOLSET, schema=schema,
                              handler=_wrap(fn_name), description=schema["description"], emoji=emoji)

    from . import game_mode_core
    _register_tool_compat(ctx.register_tool, name=game_mode_core.GAME_MODE_SCHEMA["name"], toolset=TOOLSET,
                          schema=game_mode_core.GAME_MODE_SCHEMA, handler=_game_mode_handler,
                          description=game_mode_core.GAME_MODE_SCHEMA["description"], emoji="🎮")

    # The desktop fetches game files from 127.0.0.1 directly, so something must keep the file server up in
    # this long-lived process. start_keeper returns at once (its thread does the binding); a failure here
    # must never fail plugin load.
    try:
        from . import game_file_server
        game_file_server.start_keeper()
    except Exception:
        pass

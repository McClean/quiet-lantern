# quiet-lantern

A Hermes plugin for playing games you already own inside Hermes Desktop, with the agent alongside. Each game runs
in an emulator compiled to WebAssembly, directly in the Desktop window. Nothing is mirrored from another app.

> Work in progress. The **Status** section below lists what works today and what doesn't yet.

## What it does

- **Game page.** Desktop gets a Game page (sidebar, `Ctrl+K` → "Game mode", or the status-bar chip). Pick a
  system, then a title. Nothing starts until you pick one.
- **Several games at once.** Each running game has a tab. The side panel shows the running games, who has control,
  the campaign's goals and an activity feed. Only the game on screen gets gamepad input and sound. There is no limit
  on games unless you set one (`maxSessions` in the plugin's Desktop storage). "Running slow" appears when a game
  stays under 50 fps for 5 seconds.
- **Agent tools.**
  - `game_mode`: open the Game page, start, list and stop sessions.
  - `emu_catalog`: list the games and emulators the plugin knows about.
  - `emu_session` and `emu_play`: drive a desktop emulator — press buttons, take screenshots, save and load
    states, read memory.
- **Systems.**

  | System | Emulator in the pane |
  |---|---|
  | Game Boy, Game Boy Color, Game Boy Advance | mGBA |
  | NES | QuickNES |

  Adding a system means adding a folder under `adapters/`; see `docs/ADAPTERS.md`.

## What it does not do

- It never downloads, fetches or shares game files. You bring games you own (for example, from cartridges you
  dump yourself, or from official digital releases that include the ROM file).
- It never opens, reads or changes `.sav` files in your game folders.
- It does not need internet access and stores no credentials.

## Install

Requires Hermes 0.23.0 or newer.

```bash
hermes plugins install https://github.com/McClean/quiet-lantern
hermes plugins enable emulator-catalog
```

Restart the gateway once. Then add your game folder, either by asking the agent ("add my ROM folder at …") or by
putting games in `~/Emulators/ROMs`, which the plugin checks if it exists.

The Game page sends agent work to a driving profile, chosen in the page header (`default` when unset). Changing it
needs a gateway restart, which the page offers.

## Disclosure

| What | Detail |
|---|---|
| Files read | The game folders you add, plus `~/Emulators/ROMs` if it exists. Only files with a supported extension (or inside a `.zip`) are read, and `.sav` files are skipped without being opened. |
| Files written | Only under the plugin's Hermes data folder: the catalog, screenshots, save states, and the command and event queue between the agent and Desktop. Your game folders are never written to. |
| Local server | A read-only HTTP server on `127.0.0.1:47911`, GET only. It serves the player page, the emulator cores and allow-listed game files to the Desktop page. One background thread starts it and retries every 10 s if the port is free. Set `EMULATOR_CATALOG_FILE_SERVER=0` to turn it off. |
| Processes | `emu_session` starts a desktop emulator you have installed (mGBA) as a subprocess. It loads a Lua bridge that listens on `127.0.0.1` with a random token for each session. |
| Desktop storage | The Desktop page stores two settings in its own plugin storage: the driving profile and `maxSessions`. |
| Network | None beyond `127.0.0.1`. No telemetry. |
| Credentials | None. |
| Compiled code | Two WebAssembly cores. Both are built from pinned upstream source by this repository's GitHub Actions and carry build attestations (see `THIRD_PARTY_NOTICES.md`). |

## Status

| Works and is tested | Not done or not verified yet |
|---|---|
| mGBA in the pane, about 60 fps, with save states (browser test) | Live check of the multi-game page inside Hermes Desktop |
| QuickNES core with audio (Node tests, plus a real game) | QuickNES running inside the Desktop pane |
| Library: systems, titles and per-title ROM routes | Agent goal-setting and assistance modes |
| Multi-game page logic (unit tests with a stub SDK) | Campaign storage (goals are held in memory for now) |

## Development

```bash
python -m pytest tests -q                 # needs pytest, pyyaml, ruamel.yaml, fastapi, httpx
node --test web/test/*.test.mjs desktop/test/plugin.test.mjs adapters/quicknes/test/*.test.mjs libretro/test/*.test.mjs
hermes plugins validate .
bash scripts/install-hooks.sh             # pre-commit guard against committing personal paths or save files
```

Desktop tests use stub SDK modules; one test also checks imported names against an installed Hermes source tree
when it finds one (`HERMES_SDK_INDEX` sets its path).

Rebuild the cores with Emscripten 7.0.0 on your PATH (or `HM_EM_ENV` pointing at an emsdk env script):
`bash web/build.sh` builds mGBA, and `libretro/build-core.sh` builds a libretro core (see `libretro/README.md`).

## Licence

MIT for this plugin's code. The emulator cores keep their own licences: mGBA is MPL-2.0 and QuickNES is
GPL-2.0-or-later. See `THIRD_PARTY_NOTICES.md`.

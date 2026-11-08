---
name: emulator-catalog
description: Use when the user wants the agent to pick, launch or play a game on an installed emulator (emu_catalog, emu_session, emu_play).
---
# Playing games with emulator-catalog

Tools: `emu_catalog` (what is installed), `emu_session` (start/stop the one running game),
`emu_play` (buttons, screenshots, saves, memory).

## Start
1. `emu_catalog op=list`. Games show `system` and `playable_with`. If a game or emulator is
   missing, ask the user for the folder and call `emu_catalog op=add_dir kind=games|emulators path=...`.
2. `emu_session op=start game=<id or part of the name>`. The emulator opens in its own window.
   If the reply has `manual_step`, relay it to the user (old mGBA builds need the script loaded by hand).
3. Never download or fetch game files. Only play what is already in the user's folders.

## Play loop
1. **Look:** `emu_play op=screenshot`, then `vision_analyze` on the returned `screenshot` path
   with a specific question ("where is the cursor?", "what does the dialog say?").
2. **Decide** from what is on screen (dialog first, then menus, then movement).
3. **Act:** `emu_play op=press steps=[...]`, 2–4 steps at a time. Steps are buttons
   (`A`, `B`, `L`, `R`, `START`, `SELECT`, `UP`, `DOWN`, `LEFT`, `RIGHT`), combos (`A+B`)
   or waits (`wait:60` = 1 second). Each button is held 8 frames then released for 12
   (`hold_frames`, `gap_frames` to change).
4. **Check:** screenshot again before the next move. Without checking you will get lost.
5. Add `wait:60`–`wait:120` after doors, stairs and screen transitions.

## Saves
- `emu_play op=save name=<short label>` before anything risky; `op=load name=...` to retry;
  `op=list_saves`. Saves are per game, stored in the plugin's data folder.

## Memory
- `emu_play op=read address=0x... length=N` returns hex bytes (GBA ROM header title is at 0x080000A0).
  Only use addresses you know from a game-specific skill; do not guess.

## Game mode (open it in Hermes Desktop)
- `game_mode op=open` opens game mode in Hermes Desktop on the user's own local game (already in an
  allow-listed folder). `op=status` shows how many open requests are still waiting.
- Use it when the user asks to open, show or play the game in Desktop. It does not start a session;
  `emu_session` still drives the emulator.
- **Never search for, fetch or download ROMs.** Only open a game the user already has on this machine.

## Errors
- On `ok: false`, read `fix` and follow it. `no_session` → start a game. `bridge_error` /
  `io_error` → `emu_session op=status`; if not running, start again and load the last save.
- `emu_session op=stop` when the user is done (save first).

# Adding an adapter or a game pack

This page is the recipe for adding a system (an adapter) or game knowledge (a pack). The schemas in `contracts/`
and the checks in `contracts.py` and `web/engine/contracts.mjs` are the rules. The contract tests enforce them.

## What goes where

| You want to… | Make | Example |
|---|---|---|
| Support a new **system** (NES, SNES…) | `adapters/<id>/` | `adapters/mgba`, `adapters/quicknes` |
| Teach the agent about one **game** on an existing system | `packs/<id>/` | `packs/firered-bpre` on `mgba` |
| Run an **external program** the pane can't host | `adapters/<id>/` with `runtime.kind: "external"` | none yet |

You don't edit any core file or registration list. Restart the gateway and the folder is discovered. Delete the
folder and it's gone.

## New adapter, step by step (in-pane WebAssembly core)

1. **Create the folder** `adapters/<id>/` with `manifest.json` (copy `adapters/quicknes/manifest.json`), then edit it:
   - `systems`: id, name, extensions, and a `header` check if the format has a fixed signature, so a renamed file
     can't match. NES: `{"offset":0,"hex":"4e45531a"}` (`NES\x1A`).
   - `buttons`: your core's input bit order. Every libretro adapter uses the libretro order
     `B Y SELECT START UP DOWN LEFT RIGHT A X L R L2 R2`.
   - `capabilities`: only what really works. No audio yet? Leave `audio` out.
   - `licence`: the SPDX id the core's own source grants. Read the licence file and the source headers; don't guess.
2. **Build the core into `core/`.**
   - Libretro cores: add `libretro/recipes/<name>.sh` (a 15–25 line compile step; copy `quicknes.sh`), then run
     `libretro/build-core.sh <id> <https git url> <40-hex commit> <recipe>`. It writes `core/core.mjs`,
     `core/core.wasm`, the core's licence, `core/BUILD-INFO.txt` with the source commit and checksums, and copies
     `libretro/binding.mjs` in.
   - Other cores: a build script like `web/build.sh` (mGBA) that pins the upstream commit and records checksums.
   - Add the core to `.github/workflows/build-cores.yml` and to `THIRD_PARTY_NOTICES.md`. The workflow fails until
     the committed files match its rebuild byte for byte.
3. **Write `binding.mjs`** (libretro adapters get it from the build): default export `bind(Module) -> CoreHandle`.
   It only renames and adapts the raw exports. Libretro host mapping: `load→hm_lr_load` (after `hm_lr_init`, which
   `bind()` calls once), `runFrame→hm_lr_step(1)`, `setButtons→hm_lr_set_buttons`, `read→hm_lr_read`,
   `video→hm_lr_screenshot_rgba`, `saveState/loadState→hm_lr_state_*`, `frame→hm_lr_frame`, `fps→hm_lr_fps()/1000`.
4. **Test it** in `adapters/<id>/test/`:
   - `assertCoreHandle(bind(Module), manifest.capabilities)` from `web/engine/contracts.mjs`.
   - Load a **synthetic** ROM you generate in the test (never commit a game), run frames, check the video isn't
     blank, buttons change state, and save → load restores RAM.
   - Real-game tests run only when an env var points at your own file (for example `HERMES_NES_ROM`) and skip
     otherwise.
5. `python -m pytest tests/test_contracts.py` must still pass (discovery validates your manifest).

## New game pack, step by step

1. `packs/<id>/manifest.json`: `adapter`, `match.codes` (header game code) or `match.sha1`, `provides`, `actorSwap`,
   `skill` (`game-<id>`).
2. `pack.mjs`: implement only what `provides` lists. Read memory only through `mem`. Verify every address against the
   running game, and list it in the pack README with how it was verified.
3. `profile.json`: default detectors and assists. Every assist starts `approved: false`; the player approves them.
4. `knowledge.md`: curated play notes; seeds the title's skill on first launch.
5. Test: `assertPack(pack, manifest.provides)` plus snapshot tests from saved RAM dumps (no ROM bytes in the repo).

## Rules that bite

- Never commit, download or fetch game files. Tests synthesise ROMs or use an env var pointing at your own file.
- Never write to the user's game folders, including `.sav` files next to ROMs.
- An adapter that can't meet a contract method says so in its README and leaves the capability out. It never fakes
  one (for example, `saveState` returning `null` while claiming `save_state`).

# QuickNES (NES)

NES emulation in the player pane, using QuickNES from `libretro/QuickNES_Core` run through the shared
libretro host (`libretro/hm_libretro.c`) and the shared binding (`binding.mjs`).

## What it runs

- Core: QuickNES, `https://github.com/libretro/QuickNES_Core.git`, commit `26bb785c9deddb66a17717b21bb4e328f03ade32`.
- System: NES (`.nes`, iNES header `NES\x1a` at offset 0).
- Video 240x224, RGBA. Audio at 48000 Hz stereo (read from the core at load).
- Capabilities: video, input, save_state, memory_read (`ram`, 2 KiB at `$0000`), pause, step, audio, screenshot.
- Not provided: battery save, multitap or pads 2-4 (the host feeds joypad port 0 only).

## Licence

The core's top-level `LICENSE` file is GPL-2.0 text. The compiled sources do not all carry that grant:

- Most of `nes_emu/` (25 files compiled here) carries LGPL-2.1 headers.
- The `.hpp` sources grant "version 2 of the License, or (at your option) any later version".
- Four compiled files (`libretro/libretro.cpp`, `nes_emu/emu2413.cpp`, `nes_emu/emu2413_state.cpp`,
  `nes_emu/Nes_Vrc7.cpp`) have no grant clause in the file; `nes_emu/abstract_file.cpp` has an MIT-style notice.

`manifest.json` records `GPL-2.0-or-later`, the single SPDX id that matches the core's LICENSE file.
Distributing `core/core.wasm` means the GPL/LGPL terms apply: keep `core/LICENSE.quicknes` with the
binaries and offer the corresponding source (the commit above). This is a reading of the files, not legal advice.

## Files

```
manifest.json            contract §1 manifest
binding.mjs              copy of libretro/binding.mjs (checked by tests)
core/core.mjs            Emscripten loader (MODULARIZE, ES6)
core/core.wasm           compiled QuickNES + hm_libretro.c
core/LICENSE.quicknes    the core's LICENSE, copied from the pinned checkout
core/BUILD-INFO.txt      url, commit, recipe, emcc version, sha256 of each shipped file
test/                    node --test suites + synthetic NES ROM generator
```

## Rebuild

Needs emsdk (CMake/Ninja for cmake-based cores) and Git Bash. Set `HM_EM_ENV` to the emsdk env script (it is sourced),
or put `emcc.exe` on PATH. Run from the repo root:

```bash
bash libretro/build-core.sh quicknes https://github.com/libretro/QuickNES_Core.git \
  26bb785c9deddb66a17717b21bb4e328f03ade32 quicknes
```

The script clones the source into `libretro/.build/quicknes/` (gitignored), checks out the pinned commit,
compiles the sources listed in `Makefile.common` with `em++` (`libretro/recipes/quicknes.sh`), links them with
`hm_libretro.c`, and rewrites `core/` and `binding.mjs`. Rebuilding from the same commit gives the same
`core.wasm` sha256 (recorded in `core/BUILD-INFO.txt`).

## Tests

```bash
node --test libretro/test/build-core.test.mjs adapters/quicknes/test/build-output.test.mjs \
  adapters/quicknes/test/host-audio.test.mjs adapters/quicknes/test/binding.test.mjs \
  adapters/quicknes/test/load-clears-audio.test.mjs
```

The tests use a synthetic NES ROM generated in `test/lib/nes-rom.mjs`. No game file is committed.

Real-game test, only when you point it at a ROM you own (read into memory, never written):

```bash
HERMES_NES_ROM="/path/to/your/game.nes" node --test adapters/quicknes/test/gated-real-rom.test.mjs
```

Without `HERMES_NES_ROM` the three gated tests are skipped.

Manifest validation (repo root): `uv run --no-project --with pytest python -m pytest tests/test_quicknes_manifest.py`.

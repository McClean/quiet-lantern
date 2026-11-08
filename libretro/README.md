# libretro

Shared host for libretro cores compiled to WebAssembly. Not an adapter itself: each libretro adapter gets a
copy of `binding.mjs` and its own `core/` built from here.

## Files

```
hm_libretro.c         host: frontend callbacks, joypad port 0 mask, memory maps, RGBA screenshot,
                      save/load state, audio ring (hm_lr_audio_read / hm_lr_audio_rate)
binding.mjs           CoreHandle over the hm_lr_* exports. One for every libretro core.
build-core.sh         builds one core into adapters/<id>/core/ and copies binding.mjs
recipes/<name>.sh     per-core compile step: the only per-core code
test/                 build-core.test.mjs (argument checks; no toolchain needed)
```

## Build a core

```bash
bash libretro/build-core.sh <adapterId> <https git url> <40-hex commit> <recipe>
```

- `adapterId` matches `^[a-z][a-z0-9-]{1,31}$`; it becomes `adapters/<adapterId>/`.
- `commit` must be a full SHA. Branch names are refused, so each build is reproducible.
- `recipe` names `recipes/<recipe>.sh`.

The script:

1. Clones the source into `libretro/.build/<adapterId>/src` (gitignored) and checks out the pinned commit.
2. Runs `recipes/<recipe>.sh <srcdir> <outdir>`, which must leave `<outdir>/core.a`.
3. Compiles `hm_libretro.c` and links it with `core.a` into `adapters/<id>/core/core.mjs` + `core.wasm`.
4. Copies the core's `LICENSE` to `core/LICENSE.<recipe>`, copies `binding.mjs`, and writes `core/BUILD-INFO.txt`.

Toolchain: set `HM_EM_ENV` to the emsdk env script (it is sourced), or put `emcc.exe` on PATH first.

## Add a recipe

A recipe is a shell file that receives the source directory and output directory as native paths (`D:/...`):

```bash
#!/usr/bin/env bash
set -euo pipefail
SRC="$1"; OUT="$2"
# compile the core's sources with em++ / emcc, or run its cmake build with emcmake
emar.exe rcs "$OUT/core.a" obj1.o obj2.o ...
```

Find the source list in the core's `Makefile`/`Makefile.common` (for QuickNES, `SOURCES_CXX`) or its
`CMakeLists.txt`. Compile with `-D__LIBRETRO__` and the core's own defines. Set `-fno-exceptions -fno-rtti`
only if the core builds without them. Link flags stay in `build-core.sh`.

Then add `adapters/<id>/manifest.json` (copy `adapters/quicknes/manifest.json`), set its `buttons` to the
libretro order (`B Y SELECT START UP DOWN LEFT RIGHT A X L R L2 R2`), and write node tests for the adapter
(see `adapters/quicknes/test/`).

## Rules

- Emulator source is fetched from its official repo at a pinned commit. Game files and BIOS are never fetched.
- Read the core's LICENSE file before filling in the manifest `licence` field.
- Keep the core's own copyright and licence files in `core/` with the binaries.

# Third-party notices

This plugin's own code is MIT-licensed (see `LICENSE`). It ships two emulator cores compiled to WebAssembly.
Each keeps its own licence. Its full licence text sits next to the compiled file, and the exact upstream
source commit is recorded beside it.

| Component | Files | Upstream source | Licence |
|---|---|---|---|
| mGBA | `adapters/mgba/core/mgba.wasm`, `mgba.mjs` | https://github.com/mgba-emu/mgba at `662dada8b79070bde93829a44d583c517fc5ec2d` | MPL-2.0 (`adapters/mgba/core/LICENSE.mgba`) |
| QuickNES (libretro core) | `adapters/quicknes/core/core.wasm`, `core.mjs` | https://github.com/libretro/QuickNES_Core at `26bb785c9deddb66a17717b21bb4e328f03ade32` | GPL-2.0-or-later (`adapters/quicknes/core/LICENSE.quicknes`) |

## Source for the compiled cores

Both cores are built from unmodified upstream source. You can rebuild them yourself with the scripts in this repository:

- mGBA: `web/build.sh`. The wrapper `web/src/hm_mgba.c` (MIT, this repository) is linked into the module.
- QuickNES: `libretro/build-core.sh quicknes https://github.com/libretro/QuickNES_Core.git 26bb785c9deddb66a17717b21bb4e328f03ade32 quicknes`.
  The libretro host `libretro/hm_libretro.c` (MIT, this repository) is linked into the module.

`.github/workflows/build-cores.yml` rebuilds both on every push. It fails if the result differs from the committed
files by a single byte, and on `main` it publishes a GitHub build-provenance attestation for each `.wasm`. Check
one with:

```bash
gh attestation verify adapters/mgba/core/mgba.wasm --repo McClean/quiet-lantern
```

## QuickNES licence notes

The QuickNES repository's top-level `LICENSE` is the GPL version 2 text. Its source headers grant "version 2 of the
License, or (at your option) any later version", so the core is listed as GPL-2.0-or-later. Some files under
`nes_emu/` carry LGPL-2.1 headers, and one carries an MIT-style notice. Those terms are compatible with distributing
the combined core under the GPL. The upstream tree at the pinned commit is the authoritative record.

## Libretro API header

`libretro/hm_libretro.c` is compiled against `libretro.h` from the core's own source tree (libretro-common, MIT).
The header is not copied into this repository.

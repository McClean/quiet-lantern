# mgba adapter

Runs Game Boy, Game Boy Color and Game Boy Advance games in the in-pane player with mGBA compiled to WebAssembly
(upstream `662dada8b79070bde93829a44d583c517fc5ec2d`, MPL-2.0).

- `manifest.json` — final (contract v1).
- `core/` — `mgba.mjs` + `mgba.wasm` + `LICENSE.mgba` + `BUILD-INFO.txt`. Built by `web/build.sh` from `web/src/hm_mgba.c`.
- `binding.mjs` — wraps the `hm_*` exports as a CoreHandle (`bind(Module)`). `read(addr, len)` loops `hm_read8`
  (zeros outside the map); no block export is needed.
- Verified games (same sandboxed frame as Desktop): FireRed BPRE, Advance Wars AWRE, Fire Emblem 6 (T) AFEJ.
- Header check: GBA fixed value `0x96` at `0xB2`; GB/GBC Nintendo logo start `CE ED 66 66` at `0x104`. The GB vs
  GBC split is by extension; the CGB flag (`0x143`) is informational.

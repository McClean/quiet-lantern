#!/usr/bin/env bash
# Build adapters/mgba/core from upstream mGBA (unmodified, pinned) + web/src/hm_mgba.c.
# Single-threaded (DISABLE_THREADING) so it runs in an opaque-origin sandboxed iframe.
# Env: HM_EM_ENV = path to an emsdk env script (sourced if set); otherwise emcc/emcmake must be on PATH.
# The mGBA source is cloned at the pinned commit into web/.build/ (gitignored). No game files are fetched.
set -euo pipefail
pick() { if command -v "$1.exe" >/dev/null 2>&1; then echo "$1.exe"; else echo "$1"; fi; }
npwd() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }
P="$(npwd "$(dirname "${BASH_SOURCE[0]}")/..")"  # repo root (this script lives in web/)
MGBA_URL="https://github.com/mgba-emu/mgba.git"
MGBA_REF="${MGBA_REF:-662dada8b79070bde93829a44d583c517fc5ec2d}"
if [ -n "${HM_EM_ENV:-}" ]; then source "$HM_EM_ENV" >/dev/null 2>&1; fi
EMCC="$(pick emcc)"; EMCMAKE="$(pick emcmake)"; CMAKE="$(pick cmake)"
command -v "$EMCC" >/dev/null || { echo "build: emcc not on PATH (set HM_EM_ENV)" >&2; exit 1; }

mkdir -p "$P/web/.build"
SRC="$P/web/.build/mgba-src"; BUILD="$P/web/.build/mgba-build"
if [ ! -d "$SRC/.git" ]; then git init -q "$SRC" && git -C "$SRC" remote add origin "$MGBA_URL"; fi
if [ "$(git -C "$SRC" rev-parse --verify -q HEAD || true)" != "$MGBA_REF" ]; then
  git -C "$SRC" fetch -q --depth 1 origin "$MGBA_REF" && git -C "$SRC" checkout -q -f FETCH_HEAD
fi
[ "$(git -C "$SRC" rev-parse HEAD)" = "$MGBA_REF" ] || { echo "build: checkout is not $MGBA_REF" >&2; exit 1; }
test -z "$(git -C "$SRC" status --porcelain)" || { echo "build: mgba source is modified; refusing" >&2; exit 1; }

FLAGS="-D_GNU_SOURCE -DDISABLE_THREADING -DMGBA_STANDALONE"
"$EMCMAKE" "$CMAKE" -S "$SRC" -B "$BUILD" -G Ninja -DLIBMGBA_ONLY=ON -DCMAKE_BUILD_TYPE=Release   -DCMAKE_C_FLAGS="$FLAGS" -DM_CORE_GBA=ON -DM_CORE_GB=ON   -DENABLE_SCRIPTING=OFF -DENABLE_DEBUGGERS=OFF -DENABLE_GDB_STUB=OFF   -DUSE_ZLIB=OFF -DUSE_PNG=OFF -DUSE_MINIZIP=OFF -DUSE_LIBZIP=OFF -DUSE_SQLITE3=OFF -DUSE_ELF=OFF   -DUSE_LZMA=OFF -DUSE_FFMPEG=OFF -DUSE_LUA=OFF -DUSE_JSON_C=OFF -DUSE_EPOXY=OFF   -DBUILD_GL=OFF -DBUILD_GLES2=OFF -DBUILD_GLES3=OFF >/dev/null
"$CMAKE" --build "$BUILD" -j "$(nproc 2>/dev/null || echo 4)"

# Compile our wrapper with EXACTLY the library's defines: they change mCore/VFile struct layouts.
LIBDEFS=$(grep -m1 -A3 "build CMakeFiles/mgba.dir/src/core/core.c.o" "$BUILD/build.ninja" | sed -n 's/^ *DEFINES = //p' | tr -d '\r')
CORE="$P/adapters/mgba/core"
mkdir -p "$CORE"
"$EMCC" "$P/web/src/hm_mgba.c" "$BUILD/libmgba.a" -O3 $FLAGS $LIBDEFS   -I "$SRC/include" -I "$BUILD/include"   -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=createMgba -s ENVIRONMENT=web   -s ALLOW_MEMORY_GROWTH=1 -s FILESYSTEM=0   -s EXPORTED_FUNCTIONS=_malloc,_free   -s EXPORTED_RUNTIME_METHODS=HEAPU8,HEAP16,HEAPU16,HEAPU32   -o "$CORE/mgba.mjs"
cp "$SRC/LICENSE" "$CORE/LICENSE.mgba"
# Windows emcc and git write CRLF; the canonical (CI) output is LF. Normalise before checksumming.
for f in "$CORE/mgba.mjs" "$CORE/LICENSE.mgba"; do sed -i 's/\r$//' "$f"; done
EMCC_VER="$("$EMCC" --version 2>/dev/null | head -1 | tr -d '\r')"
printf 'mgba %s\nemcc %s\n' "$MGBA_REF" "$EMCC_VER" > "$CORE/BUILD-INFO.txt"
# Checksums are relative to core/ so BUILD-INFO.txt carries no machine-specific paths.
(cd "$CORE" && sha256sum -b mgba.wasm mgba.mjs) >> "$CORE/BUILD-INFO.txt"
cat "$CORE/BUILD-INFO.txt"

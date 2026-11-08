#!/usr/bin/env bash
# build-core.sh <adapterId> <git url> <commit> <recipe>
#
# Builds one libretro core to WebAssembly and writes a self-contained adapter runtime:
#   adapters/<id>/core/core.mjs + core.wasm + LICENSE.<recipe> + BUILD-INFO.txt
#   adapters/<id>/binding.mjs   (copied from libretro/binding.mjs)
# Emulator SOURCE is cloned from the official repo at a pinned commit into libretro/.build/<id>/ (gitignored).
# No game or BIOS is fetched. Recipe contract: libretro/recipes/<recipe>.sh <srcdir> <outdir> -> <outdir>/core.a
# Env: HM_EM_ENV = path to the emsdk env script (sourced if set). If unset, emcc must already be on PATH.
set -euo pipefail
# Emscripten tool names: Windows emsdk ships *.exe shims, Linux/macOS plain names.
pick() { if command -v "$1.exe" >/dev/null 2>&1; then echo "$1.exe"; else echo "$1"; fi; }
EMCC="$(pick emcc)"; EMXX="$(pick em++)"; EMAR="$(pick emar)"; EMCMAKE="$(pick emcmake)"; CMAKE="$(pick cmake)"
export EMCC EMXX EMAR
# Native path of a directory: `pwd -W` on Git Bash (native tools cannot read /d/... paths), plain pwd elsewhere.
npwd() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }

usage() { echo "usage: build-core.sh <adapterId> <git url> <commit> <recipe>" >&2; exit 2; }
[ "$#" -eq 4 ] || usage
ID="$1"; URL="$2"; COMMIT="$3"; RECIPE="$4"

[[ "$ID" =~ ^[a-z][a-z0-9-]{1,31}$ ]] || { echo "build-core: adapter id must match ^[a-z][a-z0-9-]{1,31}$" >&2; exit 2; }
[[ "$URL" =~ ^https:// ]] || { echo "build-core: source url must be https://" >&2; exit 2; }
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "build-core: commit must be a full 40-hex SHA (no branch names)" >&2; exit 2; }
[[ "$RECIPE" =~ ^[a-z0-9-]+$ ]] || { echo "build-core: recipe name must match ^[a-z0-9-]+$" >&2; exit 2; }

# pwd -W gives native D:/ paths: emcc/em++/git/sha256sum-via-cd cannot read MSYS /d/ paths.
HERE="$(npwd "$(dirname "${BASH_SOURCE[0]}")")"
REPO="$(npwd "$HERE/..")"
RECIPE_FILE="$HERE/recipes/$RECIPE.sh"
[ -f "$RECIPE_FILE" ] || { echo "build-core: no recipe at libretro/recipes/$RECIPE.sh" >&2; exit 2; }

if [ -n "${HM_EM_ENV:-}" ]; then
  source "$HM_EM_ENV" >/dev/null 2>&1 || { echo "build-core: cannot source HM_EM_ENV=$HM_EM_ENV" >&2; exit 1; }
fi
command -v "$EMCC" >/dev/null || { echo "build-core: emcc not on PATH (set HM_EM_ENV to the emsdk env script)" >&2; exit 1; }

BUILD="$HERE/.build/$ID"; SRC="$BUILD/src"; OUT="$BUILD/out"
ADAPTER="$REPO/adapters/$ID"
mkdir -p "$SRC" "$OUT" "$ADAPTER/core"

# 1. Source: exactly the pinned commit, shallow.
if [ ! -d "$SRC/.git" ]; then
  git -C "$SRC" init -q
  git -C "$SRC" remote add origin "$URL"
fi
if [ "$(git -C "$SRC" rev-parse --verify -q HEAD || true)" != "$COMMIT" ]; then
  git -C "$SRC" fetch -q --depth 1 origin "$COMMIT"
  git -C "$SRC" checkout -q -f FETCH_HEAD
fi
[ "$(git -C "$SRC" rev-parse HEAD)" = "$COMMIT" ] || { echo "build-core: checkout is not $COMMIT" >&2; exit 1; }
SRC_N="$(npwd "$SRC")"; OUT_N="$(npwd "$OUT")"

# 2. Recipe: produce the core archive.
bash "$RECIPE_FILE" "$SRC_N" "$OUT_N"
[ -s "$OUT/core.a" ] || { echo "build-core: recipe did not produce $OUT/core.a" >&2; exit 1; }

# 3. Link the shared host with the core archive (same flags as spike-007 link()).
"$EMCC" -c "$HERE/hm_libretro.c" -o "$OUT/hm_libretro.o" -O2 -D_GNU_SOURCE \
  -I "$SRC_N/libretro/libretro-common/include"
"$EMXX" "$OUT/hm_libretro.o" "$OUT/core.a" -O2 -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=createLibretro \
  -s ENVIRONMENT=web,node -s ALLOW_MEMORY_GROWTH=1 -s FILESYSTEM=0 -s INITIAL_MEMORY=67108864 \
  -s EXPORTED_FUNCTIONS=_malloc,_free -s EXPORTED_RUNTIME_METHODS=HEAPU8 -s INVOKE_RUN=0 \
  -o "$ADAPTER/core/core.mjs"

# 4. Licence from the core repo, binding, provenance.
cp "$SRC/LICENSE" "$ADAPTER/core/LICENSE.$RECIPE"
cp "$HERE/binding.mjs" "$ADAPTER/binding.mjs"
# Windows emcc and git write CRLF; the canonical (CI) output is LF. Normalise before checksumming.
for f in "$ADAPTER/core/core.mjs" "$ADAPTER/core/LICENSE.$RECIPE"; do sed -i 's/\r$//' "$f"; done
EMCC_VER="$("$EMCC" --version | head -n1 | tr -d '\r')"
{
  echo "adapter: $ID"
  echo "url: $URL"
  echo "commit: $COMMIT"
  echo "recipe: libretro/recipes/$RECIPE.sh"
  echo "licence-file: core/LICENSE.$RECIPE"
  echo "toolchain: $EMCC_VER"
  echo "host: libretro/hm_libretro.c"
  echo "sha256:"
  (cd "$ADAPTER" && sha256sum -b core/core.wasm core/core.mjs binding.mjs)
} > "$ADAPTER/core/BUILD-INFO.txt"
echo "build-core: wrote $ADAPTER/core and binding.mjs"

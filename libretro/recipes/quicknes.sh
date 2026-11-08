#!/usr/bin/env bash
# Recipe: QuickNES (libretro/QuickNES_Core). Makefile has no emscripten target, so the C++ sources
# listed in Makefile.common's SOURCES_CXX are compiled directly with em++ and archived.
# Contract (see build-core.sh): $1 = native source dir (the checked-out core), $2 = native output dir.
# Writes $2/core.a. Emscripten must already be on PATH.
set -euo pipefail
QN="$1"; QO="$2"; mkdir -p "$QO"
n=0; objs=()
for f in $(sed -n '/SOURCES_CXX := /,/^$/p' "$QN/Makefile.common" | grep -o '\$(CORE_DIR)[^ \]*\.cpp' | sed "s|\$(CORE_DIR)|$QN|"); do
  o="$QO/obj$n.o"; n=$((n+1)); objs+=("$o")
  "${EMXX:-em++}" -c "$f" -o "$o" -O2 -D__LIBRETRO__ -D_GNU_SOURCE -DHAVE_NO_LANGEXTRA -DCOLOR_16_BIT -DCOLOR_5_6_5 \
    -DNO_UNALIGNED_ACCESS -DPATH_MAX=4096 -DM_PI=3.14159265358979323846 -fno-exceptions -fno-rtti -w \
    -I "$QN" -I "$QN/nes_emu" -I "$QN/libretro" -I "$QN/libretro/libretro-common/include"
done
[ "$n" -gt 0 ] || { echo "recipe quicknes: no sources found in Makefile.common" >&2; exit 1; }
rm -f "$QO/core.a"; "${EMAR:-emar}" rcs "$QO/core.a" "${objs[@]}"
echo "recipe quicknes: compiled $n sources"

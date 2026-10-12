#!/usr/bin/env bash
# Builds the bot game's client module (cgame, patched gppbots source) as a static wasm
# library for the browser client: build-native-cgame.sh <bots checkout> <out .a>
# Run inside the emsdk environment. The engine links it in (patch 0008) and runs it as
# native wasm instead of interpreting cgame.qvm - the interpreter cost ~10 ms a frame.
# Every global symbol gets an "ovcg_" prefix (q_shared, q_math and friends exist in the
# engine too); a first pass lists the symbols, the second compiles with the renames.
set -euo pipefail
BOTS=$(cd "$1" && pwd)
OUT=$2
S="$BOTS/src"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

SRC="cgame/cg_main.c game/bg_misc.c game/bg_pmove.c game/bg_slidemove.c game/bg_lib.c
     game/bg_alloc.c game/bg_voice.c cgame/cg_consolecmds.c cgame/cg_buildable.c
     cgame/cg_animation.c cgame/cg_animmapobj.c cgame/cg_draw.c cgame/cg_drawtools.c
     cgame/cg_ents.c cgame/cg_event.c cgame/cg_marks.c cgame/cg_players.c
     cgame/cg_playerstate.c cgame/cg_predict.c cgame/cg_servercmds.c cgame/cg_snapshot.c
     cgame/cg_view.c cgame/cg_weapons.c cgame/cg_scanner.c cgame/cg_attachment.c
     cgame/cg_trails.c cgame/cg_particles.c cgame/cg_tutorial.c ui/ui_shared.c
     qcommon/q_math.c qcommon/q_shared.c cgame/cg_syscalls.c"
CFLAGS="-DCGAME -O3 -msimd128 -fno-strict-aliasing -w -DNDEBUG
        -DPRODUCT_VERSION=\"gpp1\" -DSVN_VERSION=\"\""

# q_platform.h has no emscripten branch: supply what its OS blocks would define
cat > "$T/ovcg_platform.h" <<'H'
#define OS_STRING "emscripten"
#define ARCH_STRING "wasm32"
#define ID_INLINE inline
#define PATH_SEP '/'
#define DLL_EXT ".wasm"
#define Q3_LITTLE_ENDIAN
H

compile() {   # <objdir> [extra flags]
    mkdir -p "$1"
    for f in $SRC; do
        emcc $CFLAGS -include "$T/ovcg_platform.h" ${2:-} -c "$S/$f" -o "$1/$(echo "$f" | tr / _).o"
    done
}

compile "$T/pass1"
NM="$(dirname "$(command -v emcc)")/../bin/llvm-nm"
[ -x "$NM" ] || NM="$EMSDK/upstream/bin/llvm-nm"
"$NM" --defined-only --extern-only -j "$T"/pass1/*.o 2>/dev/null | grep -E '^[A-Za-z_][A-Za-z0-9_]*$' \
    | grep -v '^__' | sort -u > "$T/syms"
echo "cgame: $(wc -l < "$T/syms") global symbols prefixed"
sed 's/.*/#define & ovcg_&/' "$T/syms" > "$T/ovcg_prefix.h"
grep -qx 'vmMain' "$T/syms" && grep -qx 'dllEntry' "$T/syms" || { echo "vmMain/dllEntry missing"; exit 1; }

compile "$T/pass2" "-include $T/ovcg_prefix.h"
rm -f "$OUT"
emar rcs "$OUT" "$T"/pass2/*.o
# nothing unprefixed may be left over (would clash with the engine at link time)
LEFT=$("$NM" --defined-only --extern-only -j "$OUT" 2>/dev/null | grep -E '^[A-Za-z_][A-Za-z0-9_]*$' | grep -v -e '^ovcg_' -e '^__' | sort -u || true)
[ -z "$LEFT" ] || { echo "unprefixed symbols left: $LEFT"; exit 1; }
ls -la "$OUT"

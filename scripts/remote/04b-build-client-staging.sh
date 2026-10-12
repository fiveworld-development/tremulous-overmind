#!/usr/bin/env bash
# STAGING variant of 04: builds into /opt/tremulous/build/client-staging (not deployed).
# Output: /opt/tremulous/build/dist/client/tremulous.{js,wasm} -> picked up by
# "02-deploy.sh <host> main local". Runs in a capped scope so the other sites on
# this machine keep their memory and CPU.
set -euo pipefail
cd /   # sudo -u trem cannot stat the caller's home
B=/opt/tremulous
ENGINE_REF=00555626cd3e9da2dc9e2b6e608055261e15c21a
BOTS_REF=e37dadc495350b58e5d8d94a7fb04121fd3e367e   # lepe/trem-gpp-bots, base of patches/bots
EMSDK_VERSION=3.1.74
REPO=https://github.com/fiveworld-development/tremulous-overmind
as_trem() { sudo -n -u trem -H env HOME="$B" "$@"; }

sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    xz-utils bzip2 make >/dev/null

E="$B/build/emsdk"
if ! sudo -n test -x "$E/emsdk"; then
    as_trem git clone -q --depth 1 https://github.com/emscripten-core/emsdk.git "$E"
fi
if ! sudo -n test -f "$E/.installed-$EMSDK_VERSION"; then
    echo "== emsdk $EMSDK_VERSION"
    as_trem bash -c "cd '$E' && ./emsdk install $EMSDK_VERSION >/dev/null && ./emsdk activate $EMSDK_VERSION >/dev/null && touch .installed-$EMSDK_VERSION"
fi

W="$B/build/client-work-staging"
as_trem rm -rf "$W"
as_trem mkdir -p "$W"
as_trem git clone -q --filter=blob:none https://github.com/justinl1996/tremulous.git "$W/engine"
as_trem git -C "$W/engine" checkout -q "$ENGINE_REF"
as_trem git clone -q --depth 1 "$REPO" "$W/overmind"
for p in $(sudo -n find "$W/overmind/patches/engine" -name '*.patch' | sort); do
    echo "== $(basename "$p")"
    as_trem git -C "$W/engine" apply --whitespace=nowarn "$p"
done
# the bot game's cgame, linked into the client as native wasm (engine patch 0008);
# must be the same source as the servers' cgame.qvm (03-build-on-host.sh)
as_trem git clone -q --filter=blob:none https://github.com/lepe/trem-gpp-bots.git "$W/bots"
as_trem git -C "$W/bots" checkout -q "$BOTS_REF"
for p in $(sudo -n find "$W/overmind/patches/bots" -name '*.patch' | sort); do
    echo "== $(basename "$p")"
    as_trem git -C "$W/bots" apply --whitespace=nowarn "$p"
done

echo "== wasm client (capped: 1.2G RAM, low CPU weight)"
sudo -n systemd-run --quiet --wait --pipe --collect -p MemoryMax=1200M -p CPUWeight=20 \
    --uid=trem --gid=trem -E HOME="$B" bash -c "
        set -e
        source '$E/emsdk_env.sh' >/dev/null 2>&1
        nice -n 15 bash '$W/overmind/scripts/remote/build-native-cgame.sh' '$W/bots' '$W/libovcg.a' > '$W/cgame.log' 2>&1 \
            || { tail -30 '$W/cgame.log'; exit 1; }
        tail -2 '$W/cgame.log'
        cd '$W/engine'
        nice -n 15 emmake make -j2 release PLATFORM=js BUILD_CLIENT=1 BUILD_SERVER=0 \
            BUILD_GAME_SO=0 BUILD_GAME_QVM=0 OVERMIND_CGAME_LIB='$W/libovcg.a' > '$W/client.log' 2>&1 \
        || nice -n 15 emmake make release PLATFORM=js BUILD_CLIENT=1 BUILD_SERVER=0 \
            BUILD_GAME_SO=0 BUILD_GAME_QVM=0 OVERMIND_CGAME_LIB='$W/libovcg.a' >> '$W/client.log' 2>&1
    " || { sudo -n tail -40 "$W/client.log"; exit 1; }

D="$B/build/client-staging"   # staging only: never picked up by deploys
as_trem rm -rf "$D"
as_trem mkdir -p "$D"
JS=$(sudo -n find "$W/engine/build" -maxdepth 3 -name 'tremulous*.js' | head -1)
WASM=$(sudo -n find "$W/engine/build" -maxdepth 3 -name 'tremulous*.wasm' | head -1)
[ -n "$JS" ] && [ -n "$WASM" ] || { echo "client output not found"; sudo -n find "$W/engine/build" -maxdepth 3 -name 'tremulous*'; exit 1; }
as_trem cp "$JS" "$D/tremulous.js"
as_trem cp "$WASM" "$D/tremulous.wasm"
# the loader fetches the wasm by its build name; keep both names working
if [ "$(basename "$WASM")" != tremulous.wasm ]; then
    as_trem sed -i "s/$(basename "$WASM")/tremulous.wasm/g" "$D/tremulous.js"
fi
sudo -n ls -la "$D"
sudo -n grep -c '_Overmind_Action' "$D/tremulous.js"
echo "client built OK"

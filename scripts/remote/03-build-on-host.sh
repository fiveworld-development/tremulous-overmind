#!/usr/bin/env bash
# Builds the dedicated server + bot game module on the host itself (same steps as the CI
# "server" job). Output: /opt/tremulous/build/dist/server -> use with ARTIFACTS=local 02-deploy.sh
set -euo pipefail
cd /   # sudo -u trem cannot stat the caller's home
B=/opt/tremulous
ENGINE_REF=00555626cd3e9da2dc9e2b6e608055261e15c21a
BOTS_REF=e37dadc495350b58e5d8d94a7fb04121fd3e367e   # lepe/trem-gpp-bots, base of patches/bots
REPO=https://github.com/fiveworld-development/tremulous-overmind
as_trem() { sudo -n -u trem -H env HOME="$B" "$@"; }
J="nice -n 15 make -j2"
S="nice -n 15 make"   # a failed parallel build is retried serially (the Makefiles race now and then)

sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    build-essential zlib1g-dev rsync >/dev/null

W="$B/build/work"
as_trem rm -rf "$W"
as_trem mkdir -p "$W" "$B/build/dist"
as_trem git clone -q --filter=blob:none https://github.com/justinl1996/tremulous.git "$W/engine"
as_trem git -C "$W/engine" checkout -q "$ENGINE_REF"
as_trem git clone -q --filter=blob:none https://github.com/lepe/trem-gpp-bots.git "$W/bots"
as_trem git -C "$W/bots" checkout -q "$BOTS_REF"
as_trem git clone -q --depth 1 "$REPO" "$W/overmind"
for p in $(sudo -n find "$W/overmind/patches/engine" -name '*.patch' | sort); do echo "== $(basename "$p")"; as_trem git -C "$W/engine" apply --whitespace=nowarn "$p"; done
for p in $(sudo -n find "$W/overmind/patches/bots" -name '*.patch' | sort); do echo "== $(basename "$p")"; as_trem git -C "$W/bots"   apply --whitespace=nowarn "$p"; done

echo "== tremded"
as_trem bash -c "cd '$W/engine' && A='release BUILD_CLIENT=0 BUILD_SERVER=1 BUILD_GAME_SO=0 BUILD_GAME_QVM=0' && { $J \$A || $S \$A; } > '$W/engine.log' 2>&1" \
    || { sudo -n tail -40 "$W/engine.log"; exit 1; }
echo "== game.qvm (bots)"
as_trem bash -c "cd '$W/bots' && A='release BUILD_CLIENT=0 BUILD_CLIENT_SMP=0 BUILD_SERVER=0 BUILD_GAME_SO=0 \
    BUILD_GAME_QVM=1 USE_CURL=0 USE_OPENAL=0 USE_CODEC_VORBIS=0 TOOLS_OPTIMIZE=-std=gnu99' && { $J \$A || $S \$A; } > '$W/bots.log' 2>&1" \
    || { sudo -n tail -40 "$W/bots.log"; exit 1; }

D="$B/build/dist/server"
as_trem rm -rf "$D"; as_trem mkdir -p "$D/vm" "$D/bot"
as_trem find "$W/engine/build" -maxdepth 2 -type f -name 'tremded*' -exec cp {} "$D/" \;
as_trem find "$W/bots/build" -path '*/base/vm/game.qvm' -exec cp {} "$D/vm/" \;
# the bot game module needs its matching client module (entity layout differs from 1.3)
as_trem find "$W/bots/build" -path '*/base/vm/cgame.qvm' -exec cp {} "$D/vm/" \;
as_trem cp -r "$W/bots/gpp-bot/." "$D/bot/"
as_trem find "$D/bot" -name '._*' -delete
sudo -n ls -la "$D" "$D/vm"
sudo -n test -f "$D/vm/game.qvm"
echo "built OK"

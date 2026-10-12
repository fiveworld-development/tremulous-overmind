#!/usr/bin/env bash
# One-time host setup: packages, unprivileged service user, sources.
set -euo pipefail
cd /   # sudo -u trem cannot stat the caller's home
B=/opt/tremulous
export DEBIAN_FRONTEND=noninteractive

sudo -n apt-get update -qq
sudo -n apt-get install -y -qq --no-install-recommends git git-lfs zip unzip python3-venv ca-certificates >/dev/null

# Dedicated service user: no login shell, no sudo, owns only /opt/tremulous
if ! id trem >/dev/null 2>&1; then
    sudo -n useradd --system --home-dir "$B" --shell /usr/sbin/nologin trem
fi
sudo -n install -d -o trem -g trem -m 0750 "$B" "$B/src" "$B/servers" "$B/web"

as_trem() { sudo -n -u trem -H env HOME="$B" "$@"; }
as_trem git lfs install --skip-repo >/dev/null

clone() { # url dir [lfs]
    if sudo -n test -d "$B/src/$2/.git"; then as_trem git -C "$B/src/$2" pull -q --ff-only
    else as_trem git clone -q --depth 1 "$1" "$B/src/$2"; fi
}
clone https://github.com/justinl1996/tremulous.git engine
clone https://github.com/lepe/trem-gpp-bots.git gppbots
clone https://github.com/justinl1996/tremulous_web.git web-stack
clone https://github.com/justinl1996/websockify.git websockify
as_trem git -C "$B/src/web-stack" lfs pull

sudo -n du -sh "$B/src"/engine "$B/src"/gppbots "$B/src"/web-stack "$B/src"/websockify
sudo -n ls -la "$B/src/web-stack/tremulous_assets" | head -30

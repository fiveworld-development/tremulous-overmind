#!/usr/bin/env bash
# Deploys / updates Tremulous Overmind on the host. Idempotent.
# usage: 02-deploy.sh <public host name> [git ref] [nightly|local]
#   needs: 01-bootstrap.sh done (user "trem", /opt/tremulous, sources)
set -euo pipefail
cd /   # sudo -u trem cannot stat the caller's home
HOST_NAME=${1:?host name, e.g. play.webnova360.com}
REF=${2:-main}
ARTIFACTS=${3:-${ARTIFACTS:-nightly}}   # nightly | local
MODE=${4:-full}   # full | webonly (web files + units/nginx, game servers keep running)
REPO=https://github.com/fiveworld-development/tremulous-overmind
WEBSOCKIFY_COMMIT=7ad65ad51ffe9e186cf78a41fb3b2235fd5fc14e   # justinl1996/websockify "hacky support for udp"
B=/opt/tremulous
as_trem() { sudo -n -u trem -H env HOME="$B" "$@"; }

echo "== repo ($REF)"
if sudo -n test -d "$B/src/overmind/.git"; then
    as_trem git -C "$B/src/overmind" fetch -q origin "$REF"
    as_trem git -C "$B/src/overmind" checkout -q --detach FETCH_HEAD
else
    as_trem git clone -q "$REPO" "$B/src/overmind"
    as_trem git -C "$B/src/overmind" checkout -q --detach "$REF"
fi
O="$B/src/overmind"
SHA=$(as_trem git -C "$O" rev-parse --short HEAD)

if [ "$ARTIFACTS" = local ]; then
    echo "== artifacts: host build (03-build-on-host.sh)"
    DL="$B/build/dist"
else
    echo "== release artifacts (nightly)"
    DL="$B/src/dl-$SHA"
    as_trem mkdir -p "$DL"
    for f in web-client.tar.gz server.tar.gz SHA256SUMS; do
        as_trem curl -fsSL -o "$DL/$f" "$REPO/releases/download/nightly/$f"
    done
    ( cd "$DL" && sudo -n -u trem sha256sum -c SHA256SUMS )
    as_trem mkdir -p "$DL/client" "$DL/server"
    as_trem tar -xzf "$DL/web-client.tar.gz" -C "$DL/client"
    as_trem tar -xzf "$DL/server.tar.gz" -C "$DL/server"
fi
# without our own client build, build-web.js falls back to the upstream prebuilt client
CLIENT_ARG=""
sudo -n test -f "$DL/client/tremulous.wasm" && CLIENT_ARG="--client '$DL/client'"

echo "== dedicated server"
as_trem mkdir -p "$B/server/gpp"
as_trem install -m 0750 "$(sudo -n find "$DL/server" -maxdepth 1 -name 'tremded*' | head -1)" "$B/server/tremded"
for pk3 in $(sudo -n find "$B/src/web-stack/tremulous_assets" -name '*.pk3'); do
    as_trem ln -sf "$pk3" "$B/server/gpp/$(basename "$pk3")"
done
for i in 1 2; do
    case $i in 1) cfg=arena ;; 2) cfg=skirmish ;; esac
    G="$B/servers/$i/gpp"
    as_trem mkdir -p "$G/vm"
    as_trem install -m 0640 "$O/deploy/server/$cfg.cfg" "$G/server.cfg"
    as_trem install -m 0640 "$O/deploy/server/$cfg-maprotation.cfg" "$G/maprotation.cfg"
    # fallback first map; the unit's ExecStartPre replaces it with a random pick
    sudo -n test -f "$G/startmap.cfg" || echo "map $(grep -E '^[[:space:]]+[A-Za-z0-9_]+[[:space:]]*$' "$O/deploy/server/$cfg-maprotation.cfg" | tr -d ' \t\r' | tail -1)" | as_trem tee "$G/startmap.cfg" >/dev/null
    # Bots: the trem-gpp-bots game module uses an older entity layout than 1.3, so the
    # clients get its matching cgame.qvm (zz-overmind-vm.pk3, below). BOT_QVM=0 falls
    # back to the stock 1.3 game module without bots.
    if [ "${BOT_QVM:-1}" = 1 ]; then
        as_trem install -m 0640 "$DL/server/vm/game.qvm" "$G/vm/game.qvm"
    else
        as_trem rm -f "$G/vm/game.qvm"
    fi
    as_trem cp -r "$DL/server/bot/." "$G/"
done

echo "== websocket gateway"
sudo -n test -x "$B/venv/bin/websockify" || {
    as_trem python3 -m venv "$B/venv"
    as_trem "$B/venv/bin/pip" install -q "git+https://github.com/justinl1996/websockify.git@$WEBSOCKIFY_COMMIT"
}

echo "== client module for the bot game (zz-overmind-vm.pk3)"
as_trem mkdir -p "$B/build/pk3"
if [ "${BOT_QVM:-1}" = 1 ]; then
    # deterministic zip (fixed timestamp): the content-addressed URL only changes with the qvm
    as_trem python3 - "$DL/server/vm/cgame.qvm" "$B/build/pk3/zz-overmind-vm.pk3" <<'PY'
import sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(dst, "w") as z:
    info = zipfile.ZipInfo("vm/cgame.qvm", date_time=(2026, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    z.writestr(info, open(src, "rb").read())
PY
else
    as_trem rm -f "$B/build/pk3/zz-overmind-vm.pk3" "$B/server/gpp/zz-overmind-vm.pk3"
fi

echo "== web ($SHA)"
REL="$B/web/releases/$SHA"
as_trem mkdir -p "$B/build/pk3" "$B/web/releases"
as_trem bash -c "cd '$O' && node scripts/build-web.js --stack '$B/src/web-stack' $CLIENT_ARG \
    --pk3 '$B/build/pk3' --out '$REL' --base /play-tremulous/"
# the servers need our paks too (pure servers only accept paks they have)
as_trem bash -c "cp '$B'/build/pk3/*.pk3 '$B/server/gpp/'"
as_trem ln -sfn "$REL" "$B/web/current"
sudo -n chmod 0755 "$B" "$B/web"
sudo -n chgrp -R www-data "$B/web"
sudo -n find "$B/web" -type d -exec chmod 0750 {} + -o -type f -exec chmod 0640 {} +

echo "== status helper"
sudo -n install -d -o trem -g trem "$B/bin"
sudo -n install -m 0755 -o root -g root "$O/deploy/status/tremulous-status.py" "$B/bin/tremulous-status.py"
sudo -n install -m 0755 -o root -g root "$O/deploy/status/tremulous-watchdog.py" "$B/bin/tremulous-watchdog.py"

echo "== systemd"
for u in tremulous.slice tremulous-server@.service tremulous-gateway@.service tremulous-status.service tremulous-status.timer tremulous-watchdog.service tremulous-watchdog.timer; do
    sudo -n install -m 0644 "$O/deploy/systemd/$u" "/etc/systemd/system/$u"
done
sudo -n systemctl daemon-reload
sudo -n systemctl reset-failed 'tremulous-*' 2>/dev/null || true
for i in 1 2; do
    sudo -n systemctl enable -q "tremulous-server@$i" "tremulous-gateway@$i"
    if [ "$MODE" != webonly ]; then
        sudo -n systemctl restart "tremulous-server@$i" "tremulous-gateway@$i"
    fi
done
sudo -n systemctl enable -q --now tremulous-status.timer tremulous-watchdog.timer

echo "== nginx"
if ! sudo -n test -f /etc/ssl/tremulous/origin.crt; then
    # Cloudflare "Full" mode accepts a self-signed origin certificate; replace with a
    # Cloudflare Origin CA cert for "Full (strict)".
    sudo -n install -d -m 0750 /etc/ssl/tremulous
    sudo -n openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 3650 \
        -subj "/CN=$HOST_NAME" -keyout /etc/ssl/tremulous/origin.key -out /etc/ssl/tremulous/origin.crt 2>/dev/null
    sudo -n chmod 0640 /etc/ssl/tremulous/origin.key
fi
# our Worker's shared secret (X-Overmind-Auth); set on the host and in the Worker, never
# in the repo. Without it the Worker's X-Overmind-Client header is simply not trusted.
if ! sudo -n test -f /etc/nginx/snippets/tremulous-secret.conf; then
    echo 'map $http_x_overmind_auth $trem_from_worker { default 0; }' | sudo -n tee /etc/nginx/snippets/tremulous-secret.conf >/dev/null
    sudo -n chmod 0600 /etc/nginx/snippets/tremulous-secret.conf
    echo "WARN: no Worker secret yet (/etc/nginx/snippets/tremulous-secret.conf)"
fi
sudo -n sed "s/__TREM_HOST__/$HOST_NAME/g" "$O/deploy/nginx/tremulous-headers.conf" | sudo -n tee /etc/nginx/snippets/tremulous-headers.conf >/dev/null
sudo -n sed "s/__TREM_HOST__/$HOST_NAME/g" "$O/deploy/nginx/tremulous.conf" | sudo -n tee /etc/nginx/sites-available/tremulous >/dev/null
sudo -n ln -sfn /etc/nginx/sites-available/tremulous /etc/nginx/sites-enabled/tremulous
sudo -n nginx -t
sudo -n systemctl reload nginx

echo "== health"
sleep 3
systemctl --no-pager --lines=0 status "tremulous-server@1" "tremulous-server@2" "tremulous-gateway@1" "tremulous-gateway@2" | grep -E '●|Active:'
sudo -n systemctl start tremulous-status.service; sudo -n cat "$B/web/status.json"
echo
curl -sk -o /dev/null -w 'page %{http_code}\n' --resolve "$HOST_NAME:443:127.0.0.1" "https://$HOST_NAME/play-tremulous/"
echo "deployed $SHA"

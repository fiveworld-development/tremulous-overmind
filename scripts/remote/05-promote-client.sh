#!/usr/bin/env bash
# Promotes a client from build/client-staging (tested locally against the live servers)
# to build/dist/client, where "02-deploy.sh <host> main local" picks it up.
# The previous client is kept as build/dist/client.prev for a quick rollback.
set -euo pipefail
cd /
B=/opt/tremulous
as_trem() { sudo -n -u trem -H env HOME="$B" "$@"; }
S="$B/build/client-staging"; D="$B/build/dist/client"
sudo -n test -f "$S/tremulous.wasm" || { echo "no staged client"; exit 1; }
as_trem rm -rf "$D.prev"
if sudo -n test -d "$D"; then as_trem mv "$D" "$D.prev"; fi
as_trem cp -r "$S" "$D"
sudo -n sha256sum "$D"/tremulous.*

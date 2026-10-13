#!/usr/bin/env python3
"""Restarts a game server that stopped answering.

A crash exits tremded (engine patch 0010) and systemd restarts it by itself. This
catches the rest: a server that hangs, or one that lost its map without exiting. It
sends "getstatus" to each server; one that has been running for a while and fails
FAILS checks in a row (or answers without a map) gets "systemctl restart".
Runs as root from tremulous-watchdog.timer; keeps its counters in /run.
"""
import json
import os
import socket
import subprocess
import sys
import time

SERVERS = {"1": 30710, "2": 30720}
FAILS = 3          # consecutive failed checks (timer every 10 s -> ~30 s of silence)
GRACE = 90         # seconds after a (re)start: map loading and bot spawning
STATE = "/run/tremulous-watchdog.json"


def healthy(port):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(2.0)
            s.sendto(b"\xff\xff\xff\xffgetstatus\n", ("127.0.0.1", port))
            data, _ = s.recvfrom(65535)
    except OSError:
        return False
    lines = data.decode("latin-1").split("\n")
    if len(lines) < 2 or "statusResponse" not in lines[0]:
        return False
    parts = lines[1].split("\\")[1:]
    info = dict(zip(parts[0::2], parts[1::2]))
    return bool(info.get("mapname"))


def uptime(unit):
    out = subprocess.run(["systemctl", "show", unit, "-p", "ActiveEnterTimestampMonotonic", "-p", "ActiveState"],
                         capture_output=True, text=True).stdout
    props = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
    if props.get("ActiveState") != "active":
        return None  # systemd is already restarting it
    since = int(props.get("ActiveEnterTimestampMonotonic", "0")) / 1e6
    return time.monotonic() - since


def main():
    try:
        with open(STATE) as f:
            fails = json.load(f)
    except (OSError, ValueError):
        fails = {}
    for key, port in SERVERS.items():
        unit = "tremulous-server@%s.service" % key
        up = uptime(unit)
        if up is None or up < GRACE or healthy(port):
            fails[key] = 0
            continue
        fails[key] = fails.get(key, 0) + 1
        print("%s: no answer (%d/%d)" % (unit, fails[key], FAILS), flush=True)
        if fails[key] >= FAILS:
            print("%s: restarting" % unit, flush=True)
            subprocess.run(["systemctl", "restart", unit])
            fails[key] = 0
    with open(STATE, "w") as f:
        json.dump(fails, f)


if __name__ == "__main__":
    sys.exit(main())

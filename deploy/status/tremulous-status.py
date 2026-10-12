#!/usr/bin/env python3
"""Writes status.json for the landing page: map and human player count per server.

Queries each local server with the standard "getstatus" out-of-band packet and
writes the result atomically into the web root. Runs from a systemd timer.
"""
import json
import os
import socket
import sys
import tempfile

SERVERS = {"1": 30721, "2": 30722}
OUT = sys.argv[1] if len(sys.argv) > 1 else "/opt/tremulous/web/status.json"


def query(port):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(1.0)
        s.sendto(b"\xff\xff\xff\xffgetstatus\n", ("127.0.0.1", port))
        data, _ = s.recvfrom(65535)
    lines = data.decode("latin-1").split("\n")
    parts = lines[1].split("\\")[1:]
    info = dict(zip(parts[0::2], parts[1::2]))
    players = [l for l in lines[2:] if l.strip()]
    # bot names carry the [BOT] tag (g_bot_tagname 1)
    humans = sum(1 for p in players if "[BOT]" not in p)
    return {
        "online": True,
        "map": info.get("mapname", "?"),
        "humans": humans,
        "bots": len(players) - humans,
        "max": int(info.get("sv_maxclients", 0) or 0),
    }


def main():
    status = {}
    for key, port in SERVERS.items():
        try:
            status[key] = query(port)
        except (OSError, IndexError, ValueError):
            status[key] = {"online": False}
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(OUT), prefix=".status-")
    with os.fdopen(fd, "w") as f:
        json.dump(status, f, separators=(",", ":"))
    os.chmod(tmp, 0o644)
    os.replace(tmp, OUT)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Static server with a deliberate per-path delay.

Used to reproduce the PSI CLS condition locally: on fast localhost the fonts
always win the race against first paint, so no shift occurs. PSI's throttled
runs sometimes paint text before the webfonts land, and that is the run where
CLS appears. This server lets us force that ordering deterministically by
holding back specific paths.

  python scripts/slow-server.py <root> <port> [--delay /fonts/=800] ...
"""
import sys
import time
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = sys.argv[1]
PORT = int(sys.argv[2])
RULES = []
for arg in sys.argv[3:]:
    path, _, ms = arg.partition("=")
    RULES.append((path, int(ms)))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        clean = self.path.split("?")[0]
        for prefix, ms in RULES:
            if clean.startswith(prefix):
                time.sleep(ms / 1000.0)
                break
        return super().do_GET()

    def log_message(self, fmt, *args):
        if os.environ.get("SLOW_SERVER_VERBOSE"):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"serving {ROOT} on http://127.0.0.1:{PORT} with {RULES}", flush=True)
    srv.serve_forever()

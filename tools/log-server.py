#!/usr/bin/env python3
"""Minimal receiver for Celeste's optional remote debug logs.

The game POSTs JSON to /api/log (console output, errors, anomalies, state
snapshots, freeze reports). Run this behind a reverse proxy that forwards
POST /api/log here (see deploy/nginx.example.conf). Each request is appended
as one JSON line with a receive timestamp. Write-only: nothing is served back.

    python3 tools/log-server.py --port 8790 --file celeste-debug.jsonl
"""
import argparse
import json
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 64 * 1024


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--file", default="celeste-debug.jsonl")
    args = ap.parse_args()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0) or 0)
            if n <= 0 or n > MAX_BODY:
                self.send_response(413 if n > MAX_BODY else 400)
                self.end_headers()
                return
            raw = self.rfile.read(n).decode("utf-8", "replace")
            try:
                body = json.loads(raw)
            except ValueError:
                body = {"raw": raw}
            line = {
                "rx": datetime.now(timezone.utc).isoformat(),
                "ip": self.headers.get("X-Real-IP") or self.client_address[0],
                **(body if isinstance(body, dict) else {"body": body}),
            }
            with open(args.file, "a", encoding="utf-8") as f:
                f.write(json.dumps(line, ensure_ascii=False) + "\n")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')

        def do_GET(self):
            self.send_response(405)
            self.end_headers()

        def log_message(self, *_):
            pass

    print(f"celeste log receiver on 127.0.0.1:{args.port} -> {args.file}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()

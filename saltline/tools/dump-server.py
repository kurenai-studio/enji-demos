#!/usr/bin/env python3
"""Receives the Saltline scene dump and writes it under assets/resources/harbor."""
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = "/Users/shinjiyu/Documents/taptap/saltline-enji/assets/resources/harbor"
HERE = os.path.dirname(os.path.abspath(__file__))


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Path, X-Append")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.split("?", 1)[0] != "/export-scene.js":
            self.send_response(404)
            self.end_headers()
            return
        data = open(os.path.join(HERE, "export-scene.js"), "rb").read()
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/javascript")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        data = self.rfile.read(length)
        rel = self.headers.get("X-Path", "").replace("\\", "/").lstrip("/")
        if not rel or ".." in rel.split("/"):
            self.send_response(400)
            self.end_headers()
            return
        path = os.path.join(ROOT, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        mode = "ab" if self.headers.get("X-Append") == "1" else "wb"
        with open(path, mode) as handle:
            handle.write(data)
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, fmt, *args):
        print(fmt % args)


if __name__ == "__main__":
    os.makedirs(ROOT, exist_ok=True)
    print(f"dump server -> {ROOT}")
    ThreadingHTTPServer(("127.0.0.1", 8777), Handler).serve_forever()

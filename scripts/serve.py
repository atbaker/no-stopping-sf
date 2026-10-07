#!/usr/bin/env python3
"""Serve only the public site directory, suitable for an ngrok HTTP tunnel."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, default=3000)
parser.add_argument('--host', default='127.0.0.1')
args = parser.parse_args()
directory = Path(__file__).resolve().parents[1] / 'site/dist'


class RevalidatingHandler(SimpleHTTPRequestHandler):
    # Match production (Cloudflare sends max-age=0, must-revalidate) so browsers never reuse stale CSS/JS locally.
    def end_headers(self):
        self.send_header('Cache-Control', 'public, max-age=0, must-revalidate')
        super().end_headers()


handler = partial(RevalidatingHandler, directory=str(directory))
server = ThreadingHTTPServer((args.host, args.port), handler)
print(f'No Stopping SF: http://{args.host}:{args.port}', flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    server.server_close()

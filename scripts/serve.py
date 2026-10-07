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
handler = partial(SimpleHTTPRequestHandler, directory=str(directory))
server = ThreadingHTTPServer((args.host, args.port), handler)
print(f'No Stopping SF: http://{args.host}:{args.port}', flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    server.server_close()

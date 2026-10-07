#!/usr/bin/env python3
"""Check that production serves the snapshot prepared by this exact run."""
import argparse
import hashlib
import json

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_fixed

from download_permits import ROOT


@retry(retry=retry_if_exception_type((RuntimeError, httpx.TransportError)),
       stop=stop_after_attempt(6), wait=wait_fixed(5), reraise=True)
def verify(base_url):
    public = ROOT / 'site/dist'
    with httpx.Client(timeout=60, follow_redirects=True, headers={'Accept-Encoding': 'gzip'}) as client:
        for path in ['index.html', 'app.mjs', 'data/permits.json', 'data/metadata.json', 'data/permits.csv', 'data/addresses.json']:
            expected = (public / path).read_bytes()
            digest = hashlib.sha256(expected).hexdigest()
            route = '' if path == 'index.html' else path
            response = client.get(base_url.rstrip('/') + '/' + route, params={'snapshot': digest})
            response.raise_for_status()
            if response.content != expected:
                raise RuntimeError(f'Production {path} does not match this run')
            if path.endswith('.mjs') and 'javascript' not in response.headers.get('content-type', ''):
                raise RuntimeError('JavaScript module served with incorrect content type')
            if path.endswith('.json') and 'application/json' not in response.headers.get('content-type', ''):
                raise RuntimeError('Snapshot served with incorrect content type')
            print(f'Verified {path}: {len(expected)} bytes, encoding={response.headers.get("content-encoding", "identity")}')
        missing = client.get(base_url.rstrip('/') + '/data/nonexistent-snapshot.json')
        if missing.status_code != 404:
            raise RuntimeError('Missing data assets must return 404')
    snapshot = json.loads((public / 'data/permits.json').read_text())
    print(f'Published snapshot verified: {len(snapshot["permits"])} permits')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url')
    verify(parser.parse_args().url)

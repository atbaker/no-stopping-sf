import contextlib
import gzip
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from tenacity import stop_after_attempt, wait_none
import verify_deployment as deployment


class DeploymentVerificationTests(unittest.TestCase):
    def verify(self, stale=False, missing_status=404):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            public = root / 'site/dist'
            (public / 'data').mkdir(parents=True)
            files = {'index.html': b'<title>No Stopping SF</title>', 'app.mjs': b'export {};',
                     'data/permits.json': b'{"permits":[]}', 'data/metadata.json': b'{}',
                     'data/permits.csv': b'id,number\n', 'data/addresses.json': b'{"streets":{}}'}
            for name, content in files.items():
                (public / name).write_bytes(content)
            def handler(request):
                name = request.url.path.lstrip('/') or 'index.html'
                if name not in files:
                    return httpx.Response(missing_status, text='missing')
                mime = 'text/javascript' if name.endswith('.mjs') else 'application/json' if name.endswith('.json') else 'text/plain'
                content = b'old snapshot' if stale and name == 'data/permits.json' else files[name]
                return httpx.Response(200, content=gzip.compress(content),
                                      headers={'Content-Type': mime, 'Content-Encoding': 'gzip'})
            client = httpx.Client(transport=httpx.MockTransport(handler))
            with patch.object(deployment, 'ROOT', root), patch.object(deployment.httpx, 'Client', return_value=client), \
                    contextlib.redirect_stdout(io.StringIO()):
                # One attempt avoids reusing a closed mock client on retry.
                deployment.verify.retry_with(stop=stop_after_attempt(1), wait=wait_none())('https://example.test')

    def test_exact_snapshot_and_compressed_assets_pass(self):
        self.verify()

    def test_stale_snapshot_fails(self):
        with self.assertRaisesRegex(RuntimeError, 'does not match'):
            self.verify(stale=True)

    def test_html_fallback_for_missing_data_fails(self):
        with self.assertRaisesRegex(RuntimeError, 'must return 404'):
            self.verify(missing_status=200)

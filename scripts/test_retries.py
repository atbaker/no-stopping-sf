import json
import ssl
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from tenacity import wait_none
import download_permits as api


URL = 'https://sf-row.my.site.com/'


def http_error(code, retry_after=None):
    headers = {'Retry-After': retry_after} if retry_after else {}
    response = httpx.Response(code, headers=headers, request=httpx.Request('GET', URL))
    return httpx.HTTPStatusError('test', request=response.request, response=response)


class RetryTests(unittest.TestCase):
    def request(self, outcomes):
        self.calls = []
        def handler(request):
            self.calls.append(request)
            outcome = outcomes[len(self.calls) - 1]
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        with httpx.Client(transport=httpx.MockTransport(handler)) as client, \
                patch.object(api, '_client', client):
            return api.request.retry_with(wait=wait_none(), before_sleep=lambda state: None)(URL)

    def response(self):
        return httpx.Response(200, text='public data')

    def test_transient_server_and_network_failures_recover(self):
        self.assertEqual(self.request([http_error(503), httpx.ReadTimeout('timeout'), self.response()]), 'public data')
        self.assertEqual(len(self.calls), 3)

    def test_permanent_http_errors_are_not_retried(self):
        for code in [400, 401, 403, 404]:
            with self.assertRaises(httpx.HTTPStatusError):
                self.request([http_error(code)])
            self.assertEqual(len(self.calls), 1)

    def test_attempts_are_bounded_and_original_error_is_raised(self):
        error = http_error(429)
        with self.assertRaises(httpx.HTTPStatusError) as raised:
            self.request([error] * 5)
        self.assertIs(raised.exception, error)
        self.assertEqual(len(self.calls), 5)

    def test_http_error_response_is_checked(self):
        self.assertEqual(self.request([httpx.Response(503), self.response()]), 'public data')
        self.assertEqual(len(self.calls), 2)

    def test_retry_after_and_invalid_headers(self):
        def state(value):
            return SimpleNamespace(outcome=SimpleNamespace(exception=lambda: http_error(429, value)), attempt_number=1)
        self.assertEqual(api.retry_wait(state('120')), 120)
        self.assertGreaterEqual(api.retry_wait(state('invalid')), 1)
        self.assertGreater(api.retry_wait(state('Wed, 21 Oct 2099 07:28:00 GMT')), 300)

    def test_retry_after_beyond_budget_fails_without_early_retry(self):
        calls = []
        def handler(request):
            calls.append(request)
            return httpx.Response(429, headers={'Retry-After': '600'})
        with httpx.Client(transport=httpx.MockTransport(handler)) as client, \
                patch.object(api, '_client', client):
            with self.assertRaises(httpx.HTTPStatusError):
                api.request(URL)
        self.assertEqual(len(calls), 1)

    def test_bad_certificates_and_data_validation_fail_fast(self):
        error = httpx.ConnectError('bad cert')
        error.__cause__ = ssl.SSLCertVerificationError('bad cert')
        with self.assertRaises(httpx.ConnectError):
            self.request([error])
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(api.is_transient(json.JSONDecodeError('bad data', '', 0)))
        self.assertFalse(api.is_transient(RuntimeError('Incomplete pagination')))
        self.assertFalse(api.is_transient(httpx.LocalProtocolError('invalid request')))
        self.assertTrue(api.is_transient(httpx.RemoteProtocolError('server disconnected')))

    def test_shared_client_get_post_redirect_and_form_encoding(self):
        calls = []
        def handler(request):
            calls.append(request)
            if request.url.path == '/redirect':
                return httpx.Response(302, headers={'Location': '/final'})
            return self.response()
        with api.client_session() as client:
            with patch.object(client, '_transport', httpx.MockTransport(handler)):
                self.assertEqual(api.request(URL + 'redirect'), 'public data')
                self.assertEqual(api.request(URL, b'message=%7B%7D'), 'public data')
            self.assertIs(api._client, client)
            self.assertFalse(client.is_closed)
        self.assertTrue(client.is_closed)
        self.assertIsNone(api._client)
        self.assertEqual([r.method for r in calls], ['GET', 'GET', 'POST'])
        self.assertEqual(calls[-1].content, b'message=%7B%7D')
        self.assertIn('application/x-www-form-urlencoded', calls[-1].headers['Content-Type'])
        self.assertEqual(calls[-1].headers['Referer'], api.SOURCE)

    def test_standalone_request_closes_its_own_client_without_sharing_it(self):
        def handler(request):
            self.assertIsNone(api._client)
            return self.response()
        client = httpx.Client(transport=httpx.MockTransport(handler))
        with patch.object(api, 'new_client', return_value=client):
            self.assertEqual(api.request(URL), 'public data')
        self.assertTrue(client.is_closed)
        self.assertIsNone(api._client)


if __name__ == '__main__':
    unittest.main()

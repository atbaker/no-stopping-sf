"""Concurrent HTTP requests retain ordering and recover unvalidated work."""
import contextlib
import io
import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import parse_qs
from unittest.mock import patch

import httpx
import download_permits as api
import download_photos as photos


class ConcurrencyTests(unittest.TestCase):
    def test_independent_http_requests_overlap_but_results_stay_ordered(self):
        barrier = threading.Barrier(3)
        release_first = threading.Event()
        lock = threading.Lock()
        active = peak = 0
        completed = []
        def handler(request):
            nonlocal active, peak
            form = parse_qs(request.content.decode())
            index = json.loads(form['message'][0])['actions'][0]['params']['index']
            with lock:
                active += 1
                peak = max(peak, active)
            barrier.wait(timeout=5)
            if index == 0:
                if not release_first.wait(timeout=5):
                    raise RuntimeError('Other request did not complete')
            with lock:
                completed.append(index)
                active -= 1
            if index == 2:
                release_first.set()
            return httpx.Response(200, json={'actions': [{'state': 'SUCCESS', 'returnValue': index}]})
        requests = [[api.action('test', {'index': i})] for i in range(3)]
        with httpx.Client(transport=httpx.MockTransport(handler)) as client, \
                patch.object(api, '_client', client):
            results = list(api.call_batches({}, requests, concurrency=3))
        self.assertEqual(peak, 3)
        self.assertLess(completed.index(2), completed.index(0))
        self.assertEqual([r['actions'][0]['returnValue'] for _, r in results], [0, 1, 2])

    def test_checkpoint_keeps_other_batches_pending_after_failure(self):
        parents = {f'parent-{i}': {'permit_id': f'permit-{i}', 'kind': 'tow_sign_submission'} for i in range(50)}
        def backend(context, actions):
            results, records = [], {}
            for action in actions:
                parent = action['params']['parentRecordId']
                index = int(parent.split('-')[1])
                rid = '069' + f'{index:015d}'
                fields = {'ParentId': parent, 'RecordType': 'File', 'FileType': 'JPEG'}
                records[rid] = {'CombinedAttachment': {'record': {'fields': {
                    k: {'value': v} for k, v in fields.items()}}}}
                results.append({'returnValue': {'recordIdActionsList': [{'recordId': rid}], 'hasMoreData': False}})
            return {'actions': results, 'context': {'globalValueProviders': [
                {'type': '$Record', 'values': {'records': records}}]}}
        def failed_backend(context, actions):
            if actions[0]['params']['parentRecordId'] == 'parent-25':
                raise RuntimeError('interrupted batch')
            return backend(context, actions)
        with tempfile.TemporaryDirectory() as directory, patch.object(photos.time, 'sleep'), \
                contextlib.redirect_stdout(io.StringIO()):
            checkpoint = Path(directory) / 'checkpoint.json'
            with patch.object(api, 'call', failed_backend):
                with self.assertRaisesRegex(RuntimeError, 'interrupted batch'):
                    photos.fetch_files({}, parents, checkpoint, concurrency=3)
            state = json.loads(checkpoint.read_text())
            self.assertEqual(len(state['images']), 25)
            self.assertEqual([p[0] for p in state['pending']], list(parents)[25:])
            resumed = []
            def resumed_backend(context, actions):
                resumed.extend(a['params']['parentRecordId'] for a in actions)
                return backend(context, actions)
            with patch.object(api, 'call', resumed_backend):
                images = photos.fetch_files({}, parents, checkpoint, resume=True, concurrency=1)
            self.assertEqual(len(images), 50)
            self.assertEqual(resumed, list(parents)[25:])
            self.assertEqual(json.loads(checkpoint.read_text())['pending'], [])

    def test_submission_next_pages_are_read_after_their_initial_pages(self):
        initial_done = set()
        lock = threading.Lock()
        def backend(context, actions):
            results = []
            for action in actions:
                parent = action['params']['parentRecordId']
                token = action['params']['listRecordsQuery']['pageToken']
                with lock:
                    if token == '0':
                        initial_done.add(parent)
                    elif parent not in initial_done:
                        raise RuntimeError('Next page fetched before first page')
                results.append({'returnValue': {'listReference': {
                    'inContextOfRecordId': parent, 'relatedListId': 'MUSW__Submissions__r'},
                    'records': [{'id': parent + '-' + token, 'fields': {'Name': {'value': 'TOW Away Sign Photo'}}}],
                    'nextPageToken': 'next' if token == '0' else None}})
            return {'actions': results}
        with patch.object(api, 'call', backend), patch.object(photos.time, 'sleep'), \
                contextlib.redirect_stdout(io.StringIO()):
            parents = photos.fetch_submissions({}, [f'permit-{i}' for i in range(80)], concurrency=3)
        self.assertEqual(len(parents), 160)
        self.assertEqual(len(initial_done), 80)


if __name__ == '__main__':
    unittest.main()

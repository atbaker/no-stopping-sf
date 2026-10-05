import contextlib
import io
import unittest
from unittest.mock import patch

import download_photos as photos


class AttachmentTests(unittest.TestCase):
    def test_only_tow_photo_submissions_are_selected(self):
        def backend(context, actions):
            return {'actions': [{'returnValue': {'listReference': {
                'inContextOfRecordId': 'permit', 'relatedListId': 'MUSW__Submissions__r'},
                'records': [{'id': rid, 'fields': {'Name': {'value': name}}} for rid, name in [
                    ('tow', 'TOW Away Sign Photo'), ('plan', 'Construction Plan'),
                    ('other', 'Site Photo')]], 'nextPageToken': None}}]}
        with patch.object(photos.api, 'call', backend), patch.object(photos.time, 'sleep'), \
                contextlib.redirect_stdout(io.StringIO()):
            parents = photos.fetch_submissions({}, ['permit'])
        self.assertEqual(parents, {'tow': {'permit_id': 'permit', 'kind': 'tow_sign_submission'}})

    def backend(self, repeated=False, missing=False, full_final=False):
        def call(context, actions):
            results, records = [], {}
            for action in actions:
                parent = action['params']['parentRecordId']
                offset = action['params']['offset']
                ids = ['069' + f'{i:015d}' for i in range(501)]
                page_ids = ids[:500] if offset == 0 or repeated else ids[500:]
                if full_final:
                    page_ids = ids[:500]
                for rid in page_ids:
                    fields = {'Id': rid, 'ParentId': parent, 'RecordType': 'File', 'FileType': 'JPEG',
                              'Title': 'Sign photo', 'FileExtension': 'jpeg', 'CreatedDate': '2026-10-04'}
                    records[rid] = {'CombinedAttachment': {'record': {'fields': {
                        k: {'value': v} for k, v in fields.items()}}}}
                results.append({'returnValue': {'recordIdActionsList': [{'recordId': rid} for rid in page_ids],
                    'offset': 500 if offset == 0 else 501, 'hasMoreData': offset == 0 and not full_final}})
            return {'actions': results, 'context': {'globalValueProviders': [
                {'type': '$Record', 'values': {'records': {} if missing else records}}]}}
        return call

    def fetch(self, backend):
        with patch.object(photos.api, 'call', backend), patch.object(photos.time, 'sleep'), \
                contextlib.redirect_stdout(io.StringIO()):
            return photos.fetch_files({}, {'parent': {'permit_id': 'permit', 'kind': 'permit'}})

    def test_reads_next_attachment_page(self):
        self.assertEqual(len(self.fetch(self.backend())), 501)

    def test_repeated_page_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'Repeated attachment'):
            self.fetch(self.backend(repeated=True))

    def test_missing_provider_data_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'metadata missing'):
            self.fetch(self.backend(missing=True))

    def test_full_final_page_is_not_silently_truncated(self):
        with self.assertRaisesRegex(RuntimeError, 'Full attachment page'):
            self.fetch(self.backend(full_final=True))

    def test_shared_file_is_rechecked_with_each_parent_in_isolation(self):
        rid = '069000000000000001'
        calls = []
        def backend(context, actions):
            calls.append(len(actions))
            fields = {'Id': rid, 'ParentId': actions[-1]['params']['parentRecordId'],
                      'RecordType': 'File', 'FileType': 'JPEG', 'Title': 'Sign',
                      'FileExtension': 'jpeg', 'CreatedDate': '2026-10-04'}
            return {'actions': [{'returnValue': {'recordIdActionsList': [{'recordId': rid}],
                'offset': 1, 'hasMoreData': False}} for _ in actions], 'context': {
                    'globalValueProviders': [{'type': '$Record', 'values': {'records': {
                        rid: {'CombinedAttachment': {'record': {'fields': {
                            k: {'value': v} for k, v in fields.items()}}}}}}}]}}
        with patch.object(photos.api, 'call', backend), patch.object(photos.time, 'sleep'), \
                contextlib.redirect_stdout(io.StringIO()):
            result = photos.fetch_files({}, {parent: {'permit_id': parent, 'kind': 'permit'}
                                             for parent in ['first', 'second']})
        self.assertEqual(calls, [2, 1])
        self.assertEqual(result[('first', rid)]['source_parent_id'], 'first')
        self.assertEqual(result[('second', rid)]['source_parent_id'], 'second')

    def test_bulk_versions_validate_every_result(self):
        rid, version = '069000000000000001', '068000000000000001'
        image = {('permit', rid): {}}
        result = {'statusCode': 200, 'result': {'id': rid, 'fields': {
            'LatestPublishedVersionId': {'value': version}}}}
        calls = []
        def backend(context, actions):
            calls.append(actions)
            return {'actions': [{'returnValue': {'results': [result]}}]}
        with patch.object(photos.api, 'call', backend), patch.object(photos.time, 'sleep'), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(photos.fetch_versions({}, image), {rid: version})
            self.assertEqual(calls[0][0]['params']['recordIds'], [rid])
            result['statusCode'] = 403
            with self.assertRaisesRegex(RuntimeError, 'HTTP 403'):
                photos.fetch_versions({}, image)


if __name__ == '__main__':
    unittest.main()

"""Regression checks for exports beyond Salesforce's offset limit."""
import contextlib
import io
import re
import unittest
from unittest.mock import patch

import download_permits as downloader


class PublicList:
    def __init__(self, count, fault=None):
        self.rows = []
        self.fault = fault
        self.count_calls = 0
        for index in range(count):
            rid = 'a10' + f'{index:015d}'
            fields = {name: {'value': None} for name in downloader.LIST_FIELDS}
            fields.update({'Id': {'value': rid}, 'Name': {'value': f'PERMIT-{index}'}})
            self.rows.append({'id': rid, 'fields': fields})

    def __call__(self, context, actions):
        action = actions[0]
        descriptor, params = action['descriptor'], action['params']
        if descriptor.endswith('ACTION$getListUiById'):
            value = {'info': {'listReference': {'id': 'public-list',
                'objectApiName': downloader.ENTITY, 'listViewApiName': 'Discovered_API_Name'}}}
        elif descriptor == downloader.LIST_DESCRIPTOR:
            self.count_calls += 1
            count = len(self.rows) + (self.fault == 'count-changed' and self.count_calls > 1)
            value = {'totalCount': count}
        else:
            query = params['listRecordsQuery']
            # This fake source rejects offsets like Salesforce. A successful
            # 5,001-row export must use successive filters, not large offsets.
            if query['pageToken'] != '0':
                raise RuntimeError('Offset limit exceeded')
            where = query.get('where')
            cursor = re.search(r'gt: "([A-Za-z0-9]+)"', where).group(1) if where else None
            rows = [row for row in self.rows if cursor is None or row['id'] > cursor]
            if self.fault == 'ignored-cursor':
                rows = self.rows
            if self.fault == 'omitted-record':
                rows = [row for row in rows if row is not self.rows[2]]
            value = {'records': rows[:query['pageSize']], 'where': where, 'sortBy': 'Id',
                     'listReference': {'id': 'public-list'}, 'currentPageToken': '0'}
            value['count'] = len(value['records'])
        return {'actions': [{'returnValue': value}]}


class PaginationTests(unittest.TestCase):
    def fetch(self, backend):
        with patch.object(downloader, 'call', backend), patch.object(downloader.time, 'sleep'), \
                contextlib.redirect_stdout(io.StringIO()):
            return downloader.fetch_list({}, 'public-list')

    def test_exports_beyond_both_old_limits(self):
        records, pages, expected, api_name = self.fetch(PublicList(5001))
        self.assertEqual(len(records), 5001)
        self.assertEqual(expected, 5001)
        self.assertEqual(api_name, 'Discovered_API_Name')
        self.assertTrue(all(page['offset'] == 0 for page in pages))
        self.assertEqual(pages[-1]['returned'], 0)

    def test_ignored_cursor_fails_instead_of_looping(self):
        with self.assertRaisesRegex(RuntimeError, 'Repeated record IDs'):
            self.fetch(PublicList(501, 'ignored-cursor'))

    def test_missing_record_fails_count_reconciliation(self):
        with self.assertRaisesRegex(RuntimeError, 'Incomplete pagination'):
            self.fetch(PublicList(501, 'omitted-record'))

    def test_changed_source_count_rejects_export(self):
        with self.assertRaisesRegex(RuntimeError, 'Source count changed'):
            self.fetch(PublicList(501, 'count-changed'))

    def test_empty_source(self):
        records, pages, expected, _ = self.fetch(PublicList(0))
        self.assertEqual((records, expected), ({}, 0))
        self.assertEqual(pages[0]['returned'], 0)


if __name__ == '__main__':
    unittest.main()

import unittest
from unittest.mock import patch

import download_addresses as eas


class AddressDownloadTests(unittest.TestCase):
    def row(self, rid):
        return {':id': rid, 'address': rid + ' MARKET ST', 'latitude': '37.7', 'longitude': '-122.4'}

    def test_pagination_includes_final_empty_page_and_checks_counts(self):
        rows = [self.row(str(i)) for i in range(5)]
        calls = []
        def query(params):
            calls.append(params)
            if '$offset' not in params:
                return [{'count': '5'}]
            return rows[params['$offset']:params['$offset'] + params['$limit']]
        with patch.object(eas, 'query', side_effect=query):
            result = eas.download(page_size=2)
        self.assertEqual(len(result), 5)
        self.assertNotIn(':id', result[0])
        self.assertEqual([p['$offset'] for p in calls if '$offset' in p], [0, 2, 4, 5])
        self.assertEqual(len([p for p in calls if '$offset' not in p]), 2)

    def test_repeated_page_missing_rows_and_changed_counts_fail(self):
        for outcomes in [
            [[{'count': '2'}], [self.row('a')], [self.row('a')]],
            [[{'count': '2'}], [self.row('a')], [], [{'count': '2'}]],
            [[{'count': '1'}], [self.row('a')], [], [{'count': '2'}]],
            [[{'count': '0'}]],
            [[{'count': '1'}], [{'address': 'MARKET ST'}]],
        ]:
            with self.subTest(outcomes=outcomes), patch.object(eas, 'query', side_effect=outcomes):
                with self.assertRaises(RuntimeError):
                    eas.download(page_size=1)

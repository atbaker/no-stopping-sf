import unittest
from prepare_data import choose_photo


class PhotoSelectionTests(unittest.TestCase):
    def photo(self, rid, date, kind='tow_sign_submission'):
        return {'id': rid, 'uploaded_at': date, 'kind': kind}

    def test_zero_or_one_photo_from_newest_eligible_upload(self):
        old = self.photo('old', '2026-04-02T19:20:15.000Z')
        new = self.photo('new', '2026-04-03T19:20:15.000Z')
        unrelated = self.photo('unrelated', '2026-10-04T19:20:15.000Z', 'permit')
        self.assertEqual(choose_photo([new, unrelated, old]), new)
        self.assertIsNone(choose_photo([]))
        self.assertIsNone(choose_photo([unrelated]))

    def test_timestamp_ties_are_deterministic_and_unknown_dates_rank_last(self):
        first = self.photo('a', '2026-04-03T19:20:15.000Z')
        second = self.photo('b', '2026-04-03T19:20:15.000Z')
        unknown = self.photo('z', None)
        self.assertEqual(choose_photo([second, first, unknown]), second)
        self.assertEqual(choose_photo([unknown, first, second]), second)

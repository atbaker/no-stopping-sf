import unittest
from prepare_data import build_address_index, choose_photo, normalize


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


class AddressIndexTests(unittest.TestCase):
    def test_groups_by_street_and_delta_encodes_in_number_order(self):
        index = {normalize('20 Valencia Street'): (37.77001, -122.42201, 'Mission'),
                 '10 VALENCIA ST': (37.77, -122.422, 'Mission'),
                 '5 A MARKET ST': (37.79, -122.4, 'SoMa'),
                 '7 AMBIGUOUS ST': None}
        built = build_address_index(index)
        self.assertEqual(sorted(built['streets']), ['A MARKET ST', 'VALENCIA ST'])
        base_lat, base_lng = built['base']
        first, second = built['streets']['VALENCIA ST'].split(';')
        number, dlat, dlng = first.split(',')
        self.assertEqual((number, int(dlat) + base_lat, int(dlng) + base_lng), ('10', 3777000, -12242200))
        self.assertEqual(second, '20,1,-1')

import unittest
from unittest.mock import patch

from download_segments import RELATED_LIST, fetch_segments
from segment_schedules import normalize_segment, permit_schedule_status


class SegmentScheduleTests(unittest.TestCase):
    def segment(self, days='Mon;Wed;Fri', start='7:00 AM', end='5:30 PM', all_day=False, signs_needed=True):
        return normalize_segment({
            'Id': 'segment',
            'Tow_Away_Signs_Needed__c': signs_needed,
            'Tow_Away_Days__c': days,
            'Tow_Away_Start_Time__c': start,
            'Tow_Away_End_Time__c': end,
            'Tow_Away_24x7__c': all_day,
        })

    def test_daytime_and_confirmed_all_day_schedules(self):
        listed = self.segment()
        self.assertEqual(listed['weekdays'], ['Mon', 'Wed', 'Fri'])
        self.assertEqual((listed['start_time'], listed['end_time']), ('07:00', '17:30'))
        self.assertEqual(listed['status'], 'listed')
        all_day = self.segment('Mon;Tue;Wed;Thu;Fri;Sat;Sun', '12:00 AM', '12:00 AM', all_day=True)
        self.assertEqual(all_day['status'], 'all_day')
        self.assertEqual(permit_schedule_status([listed, all_day]), 'complete')

    def test_conflicting_and_ambiguous_hours_keep_listed_values(self):
        self.assertEqual(self.segment(all_day=True)['issue'], '24x7_conflict')
        overnight = self.segment(start='8:00 AM', end='5:00 AM')
        self.assertEqual((overnight['status'], overnight['issue']), ('needs_verification', 'overnight_hours'))
        self.assertEqual((overnight['start_time'], overnight['end_time']), ('08:00', '05:00'))
        self.assertEqual(self.segment(start='12:00 PM', end='12:00 PM')['issue'], 'same_time')
        self.assertEqual(permit_schedule_status([self.segment(), overnight]), 'needs_verification')

    def test_empty_and_missing_data_are_distinct_from_no_tow_signs(self):
        no_signs = self.segment(days=None, signs_needed=False)
        missing = self.segment(end=None)
        self.assertEqual(permit_schedule_status([no_signs]), 'no_tow_signs')
        self.assertEqual(permit_schedule_status([no_signs, missing]), 'unavailable')
        self.assertEqual(permit_schedule_status([]), 'unavailable')


class SegmentDownloadTests(unittest.TestCase):
    def responses(self, pages):
        def call_batches(_context, batches, _concurrency):
            for actions in batches:
                results = []
                for action in actions:
                    permit_id = action['params']['parentRecordId']
                    request_token = action['params']['listRecordsQuery']['pageToken']
                    ids, next_token = pages[(permit_id, request_token)]
                    results.append({'id': action['id'], 'returnValue': {
                        'listReference': {'inContextOfRecordId': permit_id, 'relatedListId': RELATED_LIST},
                        'records': [{'id': segment_id, 'fields': {'Id': {'value': segment_id}}}
                                    for segment_id in ids],
                        'nextPageToken': next_token,
                    }})
                yield actions, {'actions': results}
        return call_batches

    @patch('download_segments.time.sleep')
    def test_paginates_and_preserves_empty_permits(self, _sleep):
        pages = {('p1', '0'): (['s1'], 'next'), ('p1', 'next'): (['s2'], None), ('p2', '0'): ([], None)}
        with patch('download_segments.api.call_batches', self.responses(pages)):
            self.assertEqual(fetch_segments({}, ['p1', 'p2']), {'p1': [{'Id': 's1'}, {'Id': 's2'}], 'p2': []})

    @patch('download_segments.time.sleep')
    def test_repeated_segment_or_cursor_fails_refresh(self, _sleep):
        for ids, token, message in [(['s1'], None, 'repeated street segment'), (['s2'], '0', 'did not advance')]:
            with self.subTest(ids=ids), self.assertRaisesRegex(RuntimeError, message):
                pages = {('p1', '0'): (['s1'], 'next'), ('p1', 'next'): (ids, token)}
                with patch('download_segments.api.call_batches', self.responses(pages)):
                    fetch_segments({}, ['p1'])

#!/usr/bin/env python3
"""Fetch the public street segments for every permit in this snapshot."""
import json
import time
from datetime import datetime, timezone

import download_permits as api

DATA = api.ROOT / 'data'
RELATED_LIST = 'Street_Segments__r'
DESCRIPTOR = 'aura://RelatedListUiController/ACTION$postRelatedListRecords'
FIELDS = (
    'Id', 'Friendly_Name__c', 'Side_of_the_Street__c', 'Tow_Away_Signs_Needed__c',
    'Tow_Away_Days__c', 'Tow_Away_Start_Time__c', 'Tow_Away_End_Time__c',
    'Tow_Away_24x7__c',
)
BATCH_SIZE = 25


def segment_action(permit_id, token, index):
    return api.action(DESCRIPTOR, {
        'parentRecordId': permit_id,
        'relatedListId': RELATED_LIST,
        'listRecordsQuery': {
            'fields': [f'Street_Segments__c.{field}' for field in FIELDS],
            'pageSize': 100,
            'pageToken': token,
            'sortBy': ['Street_Segments__c.Id'],
        },
    }, index)


def fetch_segments(context, permit_ids, concurrency=api.DEFAULT_CONCURRENCY):
    segments = {permit_id: [] for permit_id in permit_ids}
    if len(segments) != len(permit_ids):
        raise RuntimeError('Repeated permit ID in segment lookup')
    pending = [(permit_id, '0') for permit_id in segments]
    seen_tokens = set(pending)
    seen_segments = set()
    while pending:
        wave, pending = pending[:BATCH_SIZE * concurrency], pending[BATCH_SIZE * concurrency:]
        batches = [wave[start:start + BATCH_SIZE] for start in range(0, len(wave), BATCH_SIZE)]
        requests = [[segment_action(permit_id, token, index)
                     for index, (permit_id, token) in enumerate(batch, 1)] for batch in batches]
        for batch, (actions, response) in zip(batches, api.call_batches(context, requests, concurrency), strict=True):
            if len(response['actions']) != len(batch):
                raise RuntimeError('Missing street segment responses')
            for (permit_id, _), action, result in zip(batch, actions, response['actions'], strict=True):
                page = result['returnValue']
                reference = page['listReference']
                if (result['id'] != action['id'] or reference['inContextOfRecordId'] != permit_id
                        or reference['relatedListId'] != RELATED_LIST):
                    raise RuntimeError(f'Street segment response mismatch for {permit_id}')
                for record in page['records']:
                    segment = {field: item['value'] for field, item in record['fields'].items() if field in FIELDS}
                    segment_id = record['id']
                    if not segment_id or segment_id != segment.get('Id') or segment_id in seen_segments:
                        raise RuntimeError(f'Missing or repeated street segment ID for {permit_id}')
                    seen_segments.add(segment_id)
                    segments[permit_id].append(segment)
                if (token := page.get('nextPageToken')) is not None:
                    cursor = (permit_id, str(token))
                    if cursor in seen_tokens or not page['records']:
                        raise RuntimeError(f'Street segment pagination did not advance for {permit_id}')
                    seen_tokens.add(cursor)
                    pending.append(cursor)
        time.sleep(.2)
    return segments


def main():
    permits = json.loads((DATA / 'permits_raw.json').read_text())
    metadata = json.loads((DATA / 'download_metadata.json').read_text())
    with api.client_session():
        segments = fetch_segments(api.bootstrap(), [permit['Id'] for permit in permits])
    snapshot = {
        'metadata': {
            'fetched_at': datetime.now(timezone.utc).isoformat(),
            'permit_fetched_at': metadata['fetched_at'],
            'permit_count': len(segments),
            'segment_count': sum(map(len, segments.values())),
        },
        'permits': segments,
    }
    target = DATA / 'permit_segments.json'
    temporary = target.with_suffix('.tmp')
    temporary.write_text(json.dumps(snapshot, separators=(',', ':')))
    temporary.replace(target)
    print(json.dumps(snapshot['metadata'], indent=2))


if __name__ == '__main__':
    main()

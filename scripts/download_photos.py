#!/usr/bin/env python3
"""Index public images submitted as TOW sign photos; do not mirror images."""
import argparse
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import download_permits as api
from prepare_data import choose_photo

DATA = api.ROOT / 'data'
SUBMISSIONS = 'aura://RelatedListUiController/ACTION$postRelatedListRecords'
FILES = 'serviceComponent://ui.force.components.controllers.relatedList.RelatedListViewDataManagerController/ACTION$getItems'
IMAGE_TYPES = {'JPEG', 'JPG', 'PNG', 'GIF', 'WEBP'}
PHOTO_METHOD = 'Images attached to TOW sign photo submissions linked to the permit. Direct permit attachments and PDFs excluded. Submission metadata identifies purpose, not verified image content or address. Files are hotlinked, not mirrored.'


def save_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, separators=(',', ':')))
    temporary.replace(path)


def batches(items, size=25):
    for start in range(0, len(items), size):
        yield items[start:start + size]


def values(record):
    return {name: field['value'] for name, field in record['fields'].items()}


def records_from_context(response):
    """Legacy related-list rows live in the Aura $Record provider, not returnValue."""
    records = {}
    for provider in response.get('context', {}).get('globalValueProviders', []):
        if provider['type'] == '$Record':
            for rid, entities in provider['values'].get('records', {}).items():
                if 'CombinedAttachment' in entities:
                    records[rid] = values(entities['CombinedAttachment']['record'])
    return records


def file_params(parent, offset=0, locator=None):
    return {'filterName': 'CombinedAttachments', 'parentRecordId': parent,
            'pageSize': 500, 'limit': 500, 'sortBy': 'Id', 'getCount': True,
            'isPreview': False, 'enableRowActions': False, 'offset': offset,
            'useTimeout': False, 'queryLocator': locator, 'listViewFieldCriteria': []}


def fetch_submissions(context, permit_ids, concurrency=api.DEFAULT_CONCURRENCY):
    parents = {}
    pending = [(rid, '0') for rid in permit_ids]
    seen, tokens = set(), set()
    while pending:
        wave = list(batches(pending[:25 * concurrency]))
        requests = [[api.action(SUBMISSIONS, {'parentRecordId': rid,
            'relatedListId': 'MUSW__Submissions__r', 'listRecordsQuery': {
                'fields': ['MUSW__Submission__c.Id', 'MUSW__Submission__c.Name'],
                'pageSize': 500, 'pageToken': token, 'sortBy': ['MUSW__Submission__c.Id']}}, i + 1)
            for i, (rid, token) in enumerate(batch)] for batch in wave]
        for batch, (_, response) in zip(wave, api.call_batches(context, requests, concurrency)):
            if len(response['actions']) != len(batch):
                raise RuntimeError('Missing submission responses')
            for (rid, token), result in zip(batch, response['actions']):
                page = result['returnValue']
                reference = page['listReference']
                if reference['inContextOfRecordId'] != rid or reference['relatedListId'] != 'MUSW__Submissions__r':
                    raise RuntimeError('Submission parent mismatch')
                for record in page['records']:
                    sid = record['id']
                    if sid in seen:
                        raise RuntimeError('Repeated submission ID')
                    seen.add(sid)
                    if 'tow' in (values(record).get('Name') or '').lower() and 'photo' in (values(record).get('Name') or '').lower():
                        parents[sid] = {'permit_id': rid, 'kind': 'tow_sign_submission'}
                next_token = page.get('nextPageToken')
                if next_token is not None:
                    key = (rid, str(next_token))
                    if key in tokens or str(next_token) == token:
                        raise RuntimeError('Repeated submission page token')
                    tokens.add(key)
                    pending.append((rid, str(next_token)))
            pending = pending[len(batch):]
            print(f'Submissions: {len(seen)} read; {len(pending)} permit pages remaining', flush=True)
        time.sleep(.2)
    return parents


def fetch_files(context, parents, checkpoint=None, resume=False, concurrency=api.DEFAULT_CONCURRENCY):
    pending = [(rid, 0, None) for rid in parents]
    images, seen, cursors = {}, set(), set()
    if checkpoint and resume and checkpoint.exists():
        state = json.loads(checkpoint.read_text())
        if state['parent_ids'] != list(parents):
            raise RuntimeError('Attachment checkpoint belongs to a different snapshot')
        pending = state['pending']
        images = {(permit, rid): image for permit, rid, image in state['images']}
        seen = {tuple(key) for key in state['seen']}
        cursors = {tuple(key) for key in state['cursors']}
    while pending:
        wave = list(batches(pending[:25 * concurrency]))
        requests = [[api.action(FILES, file_params(rid, offset, locator), i + 1)
            for i, (rid, offset, locator) in enumerate(batch)] for batch in wave]
        for batch, (_, response) in zip(wave, api.call_batches(context, requests, concurrency)):
            if len(response['actions']) != len(batch):
                raise RuntimeError('Missing attachment responses')
            records = records_from_context(response)
            for (parent, offset, locator), result in zip(batch, response['actions']):
                page = result['returnValue']
                ids = [item['recordId'] for item in page['recordIdActionsList']]
                for rid in ids:
                    key = (parent, rid)
                    if key in seen:
                        raise RuntimeError('Repeated attachment ID; pagination failed')
                    seen.add(key)
                    record = records.get(rid)
                    if record is None or record.get('ParentId') != parent:
                        # Aura coalesces $Record values by file ID across a batch.
                        # A file shared with two parents can therefore carry the
                        # other parent's fields. Re-read this list in isolation.
                        isolated = api.call(context, [api.action(FILES, file_params(parent, offset, locator))])
                        isolated_ids = [item['recordId'] for item in isolated['actions'][0]['returnValue']['recordIdActionsList']]
                        record = records_from_context(isolated).get(rid)
                        if rid not in isolated_ids or record is None or record.get('ParentId') != parent:
                            raise RuntimeError(f'Attachment metadata missing or parent mismatch: parent={parent}, file={rid}, metadata_parent={record.get("ParentId") if record else None}')
                    if record.get('RecordType') == 'File' and record.get('FileType') in IMAGE_TYPES:
                        images[(parents[parent]['permit_id'], rid)] = {
                            'id': rid, 'title': record.get('Title') or 'Permit photo',
                            'extension': record.get('FileExtension'),
                            'uploaded_at': record.get('CreatedDate'),
                            'source_parent_id': parent, 'kind': parents[parent]['kind']}
                if page['hasMoreData']:
                    next_offset = page.get('offset')
                    next_locator = page.get('queryLocator')
                    key = (parent, next_offset, next_locator)
                    if not ids or key in cursors or (next_offset == offset and next_locator == locator):
                        raise RuntimeError('Attachment pagination did not advance')
                    cursors.add(key)
                    pending.append((parent, next_offset, next_locator))
                elif len(ids) == 500:
                    # A full last page may be a service limit, never silently certify it.
                    raise RuntimeError('Full attachment page marked final; verify source pagination')
            # Keep fetched-but-unvalidated batches pending in the checkpoint.
            pending = pending[len(batch):]
            if checkpoint:
                save_json(checkpoint, {'parent_ids': list(parents), 'pending': pending,
                    'images': [[permit, rid, image] for (permit, rid), image in images.items()],
                    'seen': list(seen), 'cursors': list(cursors)})
            print(f'Attachments: {len(seen)} read; {len(images)} images; {len(pending)} parent pages remaining', flush=True)
        time.sleep(.2)
    return images


def fetch_versions(context, images):
    documents = sorted({rid for _, rid in images})
    versions = {}
    # One bulk UI API read, rather than one server action for every image.
    for batch in batches(documents, 100):
        response = api.call(context, [api.action('aura://RecordUiController/ACTION$getRecordsWithFields',
            {'recordIds': batch, 'optionalFields': ['ContentDocument.Id', 'ContentDocument.LatestPublishedVersionId']})])
        results = response['actions'][0]['returnValue']['results']
        if len(results) != len(batch):
            raise RuntimeError('Missing file version responses')
        returned = set()
        for result in results:
            if result['statusCode'] != 200:
                raise RuntimeError(f'File version lookup failed: HTTP {result["statusCode"]}')
            record = result['result']
            rid = record['id']
            if rid not in batch or rid in returned:
                raise RuntimeError('File version response mismatch')
            returned.add(rid)
            version = values(record).get('LatestPublishedVersionId')
            if not re.fullmatch(r'068[A-Za-z0-9]{15}', version or ''):
                raise RuntimeError('Missing public file version')
            versions[rid] = version
        print(f'Image versions: {len(versions)}/{len(documents)}', flush=True)
        time.sleep(.2)
    return versions


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--concurrency', type=int, choices=range(1, api.MAX_CONCURRENCY + 1),
                        default=api.DEFAULT_CONCURRENCY, help='Concurrent metadata batches (default: 3; use 1 for serial)')
    parser.add_argument('--resume', action='store_true', help='Resume intermediate stages from this interrupted run')
    args = parser.parse_args()
    permits = json.loads((DATA / 'permits_raw.json').read_text())
    ids = sorted(p['Id'] for p in permits)
    context = api.bootstrap()
    checkpoint = DATA / 'photo_checkpoint.json'
    state = json.loads(checkpoint.read_text()) if args.resume and checkpoint.exists() else {'permit_ids': ids}
    if state['permit_ids'] != ids:
        raise RuntimeError('Permit snapshot changed; run without --resume')
    if 'parents' not in state:
        state['parents'] = fetch_submissions(context, ids, args.concurrency)
        save_json(checkpoint, state)
    if 'images' not in state:
        state['images'] = [[permit, rid, image] for (permit, rid), image in fetch_files(
            context, state['parents'], DATA / 'photo_files_checkpoint.json', args.resume, args.concurrency).items()]
        save_json(checkpoint, state)
    # Also enforce scope when resuming an older, broader photo checkpoint.
    images = {(permit, rid): image for permit, rid, image in state['images']
              if image['kind'] == 'tow_sign_submission'}
    by_permit = {rid: [] for rid in ids}
    for (permit, rid), image in images.items():
        by_permit[permit].append(image)
    selected = {(permit, photo['id']): photo for permit, candidates in by_permit.items()
                if (photo := choose_photo(candidates)) is not None}
    versions = fetch_versions(context, selected)
    for (_, rid), image in images.items():
        if rid in versions:
            image['version_id'] = versions[rid]
    for photos in by_permit.values():
        photos.sort(key=lambda p: (p['uploaded_at'] or '', p['id']), reverse=True)
    metadata = {'fetched_at': datetime.now(timezone.utc).isoformat(), 'permit_count': len(ids),
                'permits_with_photos': sum(bool(photos) for photos in by_permit.values()),
                'image_count': len(images), 'complete': True,
                'selected_image_count': len(selected),
                'method': PHOTO_METHOD}
    output = DATA / 'permit_photos.json'
    save_json(output, {'metadata': metadata, 'permits': by_permit})
    print(json.dumps(metadata, indent=2))


if __name__ == '__main__':
    with api.client_session():
        main()

#!/usr/bin/env python3
"""Download the public Salesforce list and selected public detail fields; no login."""
import argparse
import csv
import json
import logging
import re
import ssl
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import httpx
from tenacity import retry, retry_if_exception, stop_after_attempt, stop_before_delay, wait_random_exponential

ROOT = Path(__file__).resolve().parents[1]
SOURCE = 'https://sf-row.my.site.com/s/guest-permit-list'
ENDPOINT = 'https://sf-row.my.site.com/s/sfsites/aura'
ENTITY = 'MUSW__Permit2__c'
DEFAULT_CONCURRENCY = 3
MAX_CONCURRENCY = 8
_client = None
LIST_DESCRIPTOR = 'serviceComponent://ui.force.components.controllers.lists.listViewDataManager.ListViewDataManagerController/ACTION$getItems'
LIST_QUERY_DESCRIPTOR = 'aura://ListUiController/ACTION$postListRecordsByName'
LIST_FIELDS = ['Id', 'Name', 'LastModifiedDate', 'Search_Address__c', 'Tow_Status__c',
               'MUSW__Type2__c', 'MUSW__Phase__c', 'MUSW__Status__c',
               'MUSW__Expiration_Date__c', 'Account_Name__c']
DETAIL_FIELDS = ['Start_Date__c', 'End_Date_Calculated__c', 'Tow_Away_Start_Date__c',
                 'Tow_Away_End_Date__c', 'MUSW__Issue_Date__c', 'Linear_Feet_Rollup__c',
                 'Total_Number_of_Tow_Signs__c', 'Scope_Description__c', 'Search_Address__c']

def is_transient(error):
    if isinstance(error, httpx.HTTPStatusError):
        return error.response.status_code in (408, 429) or 500 <= error.response.status_code < 600
    cause, seen = error, set()
    while cause is not None and id(cause) not in seen:
        if isinstance(cause, ssl.SSLCertVerificationError):
            return False
        seen.add(id(cause))
        cause = cause.__cause__ or cause.__context__
    return isinstance(error, (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError))


def new_client():
    limits = httpx.Limits(max_connections=MAX_CONCURRENCY,
                          max_keepalive_connections=MAX_CONCURRENCY)
    return httpx.Client(headers={'User-Agent': 'No-Stopping-SF/0.1', 'Referer': SOURCE},
                        timeout=60, follow_redirects=True,
                        transport=httpx.HTTPTransport(retries=0, limits=limits))


@contextmanager
def client_session():
    """One thread-safe connection pool for the entire download process."""
    global _client
    previous = _client
    with new_client() as client:
        _client = client
        try:
            yield client
        finally:
            _client = previous


_backoff = wait_random_exponential(multiplier=1, min=1, max=30)


def retry_wait(state):
    delay = _backoff(state)
    error = state.outcome.exception()
    if isinstance(error, httpx.HTTPStatusError):
        value = error.response.headers.get('Retry-After')
        if value:
            try:
                seconds = float(value)
            except ValueError:
                try:
                    seconds = (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds()
                except (ValueError, TypeError, OverflowError):
                    seconds = 0
            delay = max(delay, seconds)
    return delay


def log_retry(state):
    error = state.outcome.exception()
    label = f'HTTP {error.response.status_code}' if isinstance(error, httpx.HTTPStatusError) else type(error).__name__
    logging.getLogger(__name__).warning('Public source request failed (%s), attempt %s/5; retrying in %.1fs',
                                       label, state.attempt_number, state.next_action.sleep)


@retry(retry=retry_if_exception(is_transient), wait=retry_wait,
       stop=stop_after_attempt(5) | stop_before_delay(300), before_sleep=log_retry, reraise=True)
def request(url, data=None):
    headers = {}
    if data is not None:
        headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
    # All current requests (including Aura POSTs) only read public data, so
    # transport retries cannot duplicate a source-side mutation.
    if _client is None:
        # Standalone calls own a local client; never publish a temporary pool
        # that another worker could borrow just before it closes.
        with new_client() as client:
            return _request(client, url, data, headers)
    return _request(_client, url, data, headers)


def _request(client, url, data, headers):
    response = client.request('GET' if data is None else 'POST', url, content=data, headers=headers)
    response.raise_for_status()
    return response.text

def bootstrap():
    html = request(SOURCE)
    for encoded in re.findall(r'/s/sfsites/l/([^/]+)/', html):
        context = json.loads(urllib.parse.unquote(encoded))
        if 'fwuid' in context:
            return {key: context[key] for key in ['mode', 'fwuid', 'app', 'loaded']}
    raise RuntimeError('Could not discover Salesforce public page context')

def call(context, actions):
    form = {'message': json.dumps({'actions': actions}), 'aura.context': json.dumps(context),
            'aura.pageURI': '/s/guest-permit-list', 'aura.token': 'null'}
    response = json.loads(request(ENDPOINT, urllib.parse.urlencode(form).encode()))
    for action in response.get('actions', []):
        if action['state'] != 'SUCCESS':
            raise RuntimeError(json.dumps(action.get('error', action)))
    if not response.get('actions'):
        raise RuntimeError(f'Unexpected API response: {str(response)[:500]}')
    return response

def action(descriptor, params, i=1):
    return {'id': f'{i};a', 'descriptor': descriptor, 'callingDescriptor': 'UNKNOWN', 'params': params}


def call_batches(context, batches, concurrency=DEFAULT_CONCURRENCY):
    """Fetch one bounded wave, yielding in input order; validation stays on the main thread."""
    if not 1 <= concurrency <= MAX_CONCURRENCY:
        raise ValueError(f'Concurrency must be between 1 and {MAX_CONCURRENCY}')
    if len(batches) > concurrency:
        raise ValueError('A request wave cannot exceed the concurrency limit')
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        yield from zip(batches, pool.map(lambda batch: call(context, batch), batches))

def list_count(context, list_id):
    response = call(context, [action(LIST_DESCRIPTOR, {'filterName': list_id, 'entityName': ENTITY,
        'pageSize': 1, 'layoutType': 'LIST', 'sortBy': 'Name', 'getCount': True,
        'enableRowActions': False, 'offset': 0})])
    value = response['actions'][0]['returnValue']
    if value.get('isErrorListView'):
        raise RuntimeError(value.get('message', 'List view unavailable'))
    count = value.get('totalCount')
    if not isinstance(count, int) or count < 0:
        raise RuntimeError('API did not return an independent source count')
    return count

def fetch_list(context, list_id, page_size=500):
    """Walk immutable record IDs, never increasing Salesforce's capped offset."""
    if not 1 <= page_size <= 2000:
        raise ValueError('Page size must be between 1 and 2000')
    info_response = call(context, [action('aura://ListUiController/ACTION$getListUiById',
        {'listViewId': list_id, 'pageSize': 1, 'fields': ['Id']})])
    info = info_response['actions'][0]['returnValue']['info']
    reference = info['listReference']
    if reference['id'] != list_id or reference['objectApiName'] != ENTITY:
        raise RuntimeError('List metadata refers to a different source')
    # The route's filter name is an alias, not the list's actual API name.
    api_name = reference['listViewApiName']
    expected = list_count(context, list_id)
    records, pages, cursor = {}, [], None
    while True:
        query = {'fields': LIST_FIELDS, 'pageSize': page_size, 'pageToken': '0', 'sortBy': ['Id']}
        if cursor:
            query['where'] = '{ Id: { gt: ' + json.dumps(cursor) + ' } }'
        response = call(context, [action(LIST_QUERY_DESCRIPTOR, {'objectApiName': ENTITY,
            'listViewApiName': api_name, 'listRecordsQuery': query})])
        value = response['actions'][0]['returnValue']
        if value.get('where') != query.get('where') or value.get('sortBy') != 'Id':
            raise RuntimeError('API did not apply the cursor filter and ID sort')
        if value.get('listReference', {}).get('id') != list_id:
            raise RuntimeError('Query returned a different list')
        rows = value['records']
        if value['count'] != len(rows) or len(rows) > page_size:
            raise RuntimeError('Unexpected page size')
        for row in rows:
            rid = row['id']
            if not re.fullmatch(r'[A-Za-z0-9]{18}', rid):
                raise RuntimeError('Unexpected record ID')
            if rid in records:
                raise RuntimeError('Repeated record IDs: cursor failed or source changed; retry export')
            fields = {key: field['value'] for key, field in row['fields'].items()}
            if any(field not in fields for field in LIST_FIELDS) or fields['Id'] != rid:
                raise RuntimeError('API omitted required fields or returned a mismatched ID')
            records[rid] = fields
        next_cursor = rows[-1]['id'] if rows else None
        pages.append({'after_id': cursor, 'returned': len(rows), 'next_cursor': next_cursor,
                      'offset': int(value['currentPageToken'])})
        if pages[-1]['offset'] != 0:
            raise RuntimeError('Cursor query unexpectedly used an offset')
        print(f'List: {len(records)}/{expected} records (ID cursor, offset 0)', flush=True)
        # Request a final empty page rather than trusting the old service's
        # hasMoreData flag, or assuming a short page must be the end.
        if not rows:
            break
        cursor = next_cursor
        time.sleep(.2)
    final_count = list_count(context, list_id)
    if final_count != expected:
        raise RuntimeError('Source count changed during export; rerun for a consistent snapshot')
    if len(records) != expected:
        raise RuntimeError(f'Incomplete pagination: {len(records)} of {expected}')
    return records, pages, expected, api_name

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--skip-details', action='store_true')
    args = parser.parse_args()
    data = ROOT / 'data'
    data.mkdir(exist_ok=True)
    context = bootstrap()
    # Resolve the same list selected by the page instead of hardcoding a list ID.
    discovery = call(context, [action('serviceComponent://ui.communities.components.aura.components.forceCommunity.objectHome.ObjectHomeCommunitiesController/ACTION$getListViewIdObject',
        {'filterName': 'TOW_Sign_Permits', 'scope': ENTITY, 'layout': 'FULL', 'showPinnedList': False, 'useFilterNameFromRoute': False})])
    list_id = discovery['actions'][0]['returnValue']['listViewId']
    records, pages, expected, api_name = fetch_list(context, list_id)
    (data / 'permits_raw.json').write_text(json.dumps(list(records.values()), indent=2))
    if not args.skip_details:
        cache_path = data / 'permit_details.json'
        cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
        missing = [rid for rid in records if cache.get(rid, {}).get('_source_modified') != records[rid].get('LastModifiedDate')]
        for start in range(0, len(missing), 25):
            batch = missing[start:start + 25]
            response = call(context, [action('aura://RecordUiController/ACTION$getRecordWithFields',
                {'recordId': rid, 'optionalFields': [ENTITY + '.' + f for f in DETAIL_FIELDS]}, i + 1)
                for i, rid in enumerate(batch)])
            for rid, result in zip(batch, response['actions']):
                value = result['returnValue']
                if value['id'] != rid:
                    raise RuntimeError('Detail response ID mismatch')
                cache[rid] = {k: v['value'] for k, v in value['fields'].items()}
                cache[rid]['_source_modified'] = records[rid].get('LastModifiedDate')
            cache_path.write_text(json.dumps(cache, indent=2))
            print(f'Details: {min(start + len(batch), len(missing))}/{len(missing)}', flush=True)
            time.sleep(.2)
        for rid, record in records.items():
            record.update({k: v for k, v in cache[rid].items() if not k.startswith('_')})
    rows = sorted(records.values(), key=lambda r: r['Name'])
    (data / 'permits_raw.json').write_text(json.dumps(rows, indent=2))
    fields = sorted({field for row in rows for field in row})
    with (data / 'permits_raw.csv').open('w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    meta = {'source': SOURCE, 'endpoint': ENDPOINT, 'list_id': list_id,
            'list_name': 'All TOW Sign Permits', 'list_api_name': api_name,
            'pagination_method': 'ID keyset; Id > last_seen_id; offset always 0',
            'fetched_at': datetime.now(timezone.utc).isoformat(),
            'record_count': len(rows), 'source_count': expected, 'pagination_complete': len(rows) == expected,
            'pages': pages, 'detail_fields_fetched': not args.skip_details,
            'scope_note': 'All entries in this public list, which has source-side filters on expiration date, phase and requested tow-away rights; not every historical SF parking permit.'}
    (data / 'download_metadata.json').write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta, indent=2))

if __name__ == '__main__':
    with client_session():
        main()

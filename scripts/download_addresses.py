#!/usr/bin/env python3
"""Download the complete public EAS dataset, validating before replacing the cache."""
import json
from pathlib import Path
from urllib.parse import urlencode

from download_permits import ROOT, client_session, request

SOURCE = 'https://data.sf.gov/resource/3mea-di5p.json'
PAGE_SIZE = 50000


def query(params):
    result = json.loads(request(SOURCE + '?' + urlencode(params)))
    if not isinstance(result, list):
        raise RuntimeError('Unexpected EAS response')
    return result


def source_count():
    rows = query({'$select': 'count(*) AS count'})
    if len(rows) != 1 or not str(rows[0].get('count', '')).isdigit():
        raise RuntimeError('Missing EAS source count')
    return int(rows[0]['count'])


def download(page_size=PAGE_SIZE):
    if not 1 <= page_size <= PAGE_SIZE:
        raise ValueError('EAS page size must be between 1 and 50000')
    before = source_count()
    if before == 0:
        raise RuntimeError('EAS dataset unexpectedly empty')
    addresses, seen = [], set()
    while True:
        # Socrata permits offsets beyond 2000. Explicit row-ID ordering keeps
        # traversal deterministic; IDs and counts detect incomplete exports.
        page = query({'$select': ':id,address,latitude,longitude,nhood',
                      '$order': ':id', '$limit': page_size, '$offset': len(addresses)})
        if not page:
            break
        if len(page) > page_size:
            raise RuntimeError('EAS ignored the requested page size')
        for row in page:
            rid = row.get(':id')
            if not isinstance(rid, str) or not rid or rid in seen or not row.get('address'):
                raise RuntimeError('EAS repeated a row or omitted required fields')
            seen.add(rid)
            addresses.append({k: v for k, v in row.items() if k != ':id'})
        if len(addresses) > before:
            raise RuntimeError('EAS count changed during pagination')
        print(f'EAS addresses: {len(addresses)}/{before}', flush=True)
    after = source_count()
    if before != after or len(addresses) != before:
        raise RuntimeError(f'Incomplete or changed EAS export: {before}, {len(addresses)}, {after}')
    return addresses


def main():
    with client_session():
        addresses = download()
    destination = ROOT / 'data/sf_addresses.json'
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(addresses, separators=(',', ':')))
    temporary.replace(destination)
    print(f'Saved {len(addresses)} address rows to {destination}')


if __name__ == '__main__':
    main()

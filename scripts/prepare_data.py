#!/usr/bin/env python3
"""Join permits to official SF EAS address points; never invent locations."""
import csv
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data'
PUBLIC = ROOT / 'site/dist/data'

def normalize(value):
    value = re.sub(r'\s+', ' ', (value or '').upper().strip())
    value = re.sub(r'\b0+(\d+(?:ST|ND|RD|TH))\b', r'\1', value)
    for original, short in [('STREET', 'ST'), ('AVENUE', 'AVE'), ('BOULEVARD', 'BLVD'),
                            ('LANE', 'LN'), ('DRIVE', 'DR'), ('COURT', 'CT'),
                            ('ROAD', 'RD'), ('TERRACE', 'TER'), ('PLACE', 'PL')]:
        value = re.sub(r'\b' + original + r'\b', short, value)
    return value

def main():
    PUBLIC.mkdir(parents=True, exist_ok=True)
    index = {}
    addresses = json.loads((DATA / 'sf_addresses.json').read_text())
    for address in addresses:
        if address.get('latitude') and address.get('longitude'):
            key = normalize(address['address'])
            point = (float(address['latitude']), float(address['longitude']), address.get('nhood', ''))
            if key not in index:
                index[key] = point
            elif index[key] is not None and abs(index[key][0] - point[0]) + abs(index[key][1] - point[1]) > .001:
                index[key] = None  # Ambiguous address: leave unmapped rather than guess.
    permits = []
    raw = json.loads((DATA / 'permits_raw.json').read_text())
    for row in raw:
        address = normalize(row.get('Search_Address__c'))
        point = index.get(address)
        tow_start, tow_end = row.get('Tow_Away_Start_Date__c'), row.get('Tow_Away_End_Date__c')
        start = tow_start or row.get('Start_Date__c')
        end = tow_end or row.get('End_Date_Calculated__c') or row.get('MUSW__Expiration_Date__c')
        permits.append({
            'id': row['Id'], 'number': row['Name'], 'address': address,
            'tow_status': row.get('Tow_Status__c') or 'Unknown',
            'type': row.get('MUSW__Type2__c') or 'Unknown',
            'phase': row.get('MUSW__Phase__c') or 'Unknown', 'status': row.get('MUSW__Status__c') or 'Unknown',
            'account': row.get('Account_Name__c') or '',
            'start_date': start, 'end_date': end,
            'tow_start_date': tow_start, 'tow_end_date': tow_end,
            'permit_start_date': row.get('Start_Date__c'), 'permit_end_date': row.get('End_Date_Calculated__c'),
            'expiration_date': row.get('MUSW__Expiration_Date__c'),
            'date_basis': 'Tow-away dates' if tow_start and tow_end else 'Permit dates (fallback)',
            'linear_feet': row.get('Linear_Feet_Rollup__c'), 'sign_count': row.get('Total_Number_of_Tow_Signs__c'),
            'scope': row.get('Scope_Description__c') or '', 'last_modified': row.get('LastModifiedDate'),
            'lat': point[0] if point else None, 'lng': point[1] if point else None,
            'neighborhood': point[2] if point else 'Unmapped',
            'location_basis': 'SF EAS address point' if point else 'No exact address match',
            'source_url': 'https://sf-row.my.site.com/s/permit2/' + row['Id'],
        })
    meta = json.loads((DATA / 'download_metadata.json').read_text())
    meta.update({'mapped_count': sum(p['lat'] is not None for p in permits),
                 'geocoder_source': 'https://data.sfgov.org/d/3mea-di5p',
                 'geocoder_method': 'Exact normalized address match; address points are not precise tow-zone boundaries.',
                 'tow_status_counts': dict(Counter(p['tow_status'] for p in permits)),
                 'missing_date_count': sum(not p['start_date'] or not p['end_date'] for p in permits),
                 'date_method': 'Inclusive tow-away start/end dates, falling back to proposed permit start, permit end, then expiration. Missing or invalid intervals are excluded from date-filtered counts. No time-of-day data is exposed. Tow Status is current at download time; changing the date does not reconstruct historical enforcement.'})
    (PUBLIC / 'permits.json').write_text(json.dumps({'metadata': meta, 'permits': permits}, separators=(',', ':')))
    for destination in [DATA / 'permits.csv', PUBLIC / 'permits.csv']:
        with destination.open('w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=list(permits[0]))
            writer.writeheader()
            writer.writerows({k: "'" + v if isinstance(v, str) and re.match(r'^[=+\-@\t\r]', v) else v for k, v in p.items()} for p in permits)
    (PUBLIC / 'metadata.json').write_text(json.dumps(meta, indent=2))
    print(json.dumps({k: meta[k] for k in ['record_count', 'mapped_count', 'tow_status_counts', 'missing_date_count']}, indent=2))

if __name__ == '__main__':
    main()

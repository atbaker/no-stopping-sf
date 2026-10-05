# SF Tow Signs

A local, mobile-friendly proof of concept for exploring San Francisco Public Works tow sign permits. Includes a map, address/company/permit search, tow status, permit type, neighborhood and date filters, permit details, summary counts, and full/filtered CSV export. No deployment or credentials required.

The credit below the page title names the creator, [Andrew Baker](https://x.com/andrewtorkbaker), and links to [Greg Long's post on SF street space permits](https://www.instagram.com/reel/Dd6pwYGB5vG/), which inspired this project. The reel's authorship was verified directly on Instagram; the credit acknowledges inspiration, while the permit counts come from Public Works records.

## Run

Requires Python 3.10+. No Python packages or npm installation needed; MapLibre GL JS is included locally.

```sh
python3 scripts/serve.py
```

Open **http://127.0.0.1:3000**. The server exposes only `site/dist`, not the workspace or raw data cache. To use another port: `python3 scripts/serve.py --port 3001`.

For a temporary public tunnel, run separately:

```sh
ngrok http 3000
```

The site uses same-origin relative URLs, so the map, filters and CSV exports work through the tunnel. For the reserved development URL, use `ngrok http 3000 --url https://atbaker.ngrok.io`. Map tiles are [OpenFreeMap](https://openfreemap.org) vector tiles (no API key), loaded from its Positron style and recolored at runtime in `app.mjs`; they need internet access and attribution is displayed. Do not bulk prefetch tiles. Fonts use Google Fonts with system fallbacks.

The visual design borrows from San Francisco's temporary "Tow-Away No Stopping" signs (red and white base, black print for site data). The site states it is unofficial and not affiliated with SFMTA or SF Public Works.

## Snapshot

Initial download October 4, 2026 at 7:16 PM Pacific; refreshed and verified with ID keyset pagination at 9:23 PM Pacific. See the snapshot metadata for the current fetch time.

| Scope | Total | Enforceable | Not Enforceable |
| --- | ---: | ---: | ---: |
| All downloaded entries | 2,531 | 642 | 1,889 |
| Tow date range covers October 4 | 1,658 | 642 | 1,016 |

**61.3% of permits covering October 4 report Not Enforceable.** 2,417 of the 2,531 permits (95.5%) match an official city address point. 114 remain unmapped, including 60 with no search address. All stay in CSV, list, and counts; the neighborhood filter labels these `Unmapped`.

## Data and reproducibility

- Public list: https://sf-row.my.site.com/s/guest-permit-list
- Public Salesforce Aura POST endpoint: `https://sf-row.my.site.com/s/sfsites/aura`
- Object: `MUSW__Permit2__c`; tow field: `Tow_Status__c`.
- The downloader discovers the public Aura context and list ID from the current page, then resolves the actual API name using `ListUiController/ACTION$getListUiById`. The route alias `TOW_Sign_Permits` currently points to `Copy_of_All_TOW_Sign_Permits`; this name is discovered rather than hardcoded. Selected date fields come from `RecordUiController/ACTION$getRecordWithFields`, in batches of 25.
- Salesforce accepts offset 2,000 but rejects larger offsets and can return misleading `hasMoreData` values on oversized pages. The export now uses **ID keyset pagination** through `ListUiController/ACTION$postListRecordsByName`: 500-record requests sorted by `Id`, with `where: { Id: { gt: "last_seen_id" } }` after the first batch. Every request uses offset zero, preserving the city's list filters without the old 4,000-record ceiling. It requests a final empty batch, rejects repeated IDs/ignored filters, and reconciles against independent source counts before and after the export. This is a live traversal, not a transactional database snapshot; equal counts cannot detect every concurrent source change.
- Live verification retrieved exactly the same 2,531 IDs as the original two-way export, with batch sizes 500, 500, 500, 500, 500, 31, 0. Regression tests exercise 5,001 records and reject ignored cursors, omitted records and changing counts. See `artifacts/pagination-verification.json` for the live audit.
- This is **every entry exposed by this particular public list**, which applies source-side filters on expiration, phase, and requested tow-away rights. It is not a citywide historical permit archive or a count of every physical sign. This includes Street Space, Temporary Occupancy and Sidewalk Repair permits; other SFMTA permit systems are outside this source.
- Address source: [San Francisco Enterprise Addressing System](https://data.sfgov.org/d/3mea-di5p). Exact matches normalize whitespace, standard street suffixes and leading zeros on ordinal streets. Ambiguous or unmatched addresses remain unmapped; no coordinates are invented. Points locate addresses, not curb-zone boundaries.

Files:

| File | Contents |
| --- | --- |
| `data/permits.csv` | Clean, map-ready CSV, 2,531 rows |
| `data/permits_raw.csv` / `data/permits_raw.json` | Original public Salesforce fields, including selected detail fields |
| `data/download_metadata.json` | Source count, pagination audit, fetch time and scope |
| `site/dist/data/permits.json` | Frontend snapshot, normalized fields and metadata |
| `site/dist/data/permits.csv` | Downloadable clean CSV |
| `site/dist/data/metadata.json` | Public snapshot and geocoding audit |

CSV free-text fields beginning with spreadsheet formula characters receive a leading apostrophe in the clean exports. JSON and raw CSV preserve the original values.

## What “today” means

Today is calculated in `America/Los_Angeles`, independently of the viewer's timezone. Date coverage uses **inclusive `Tow_Away_Start_Date__c` and `Tow_Away_End_Date__c`**. Where absent, it falls back to proposed permit start (`Start_Date__c`), permit end (`End_Date_Calculated__c`), then expiration. The UI identifies fallbacks. Every record in this snapshot has a valid tow-away date range, so no fallback is needed for current counts.

**Tow Status is copied exactly from the public record at download time.** It is not inferred from phase/status or merely from the appearance of a sign. Changing the date selects permits with matching date coverage, but does not reconstruct historical or predict future Tow Status. Hours, weekdays, physical posting conditions and exact curb limits are not represented. See [Public Works street space guidance](https://sfpublicworks.org/services/permits/street-space) for tow sign verification rules.

## Refresh

```sh
python3 scripts/download_permits.py
python3 scripts/prepare_data.py
```

Or `npm run refresh`. Reload the browser afterward. The refresh updates the list and re-fetches details for new/modified records; unchanged records use a cache keyed by the source's `LastModifiedDate`. The metadata shows the new download time. The script fails on incomplete pagination, changed source count, repeated IDs, ignored cursor filters, or API failures; the previously prepared site snapshot stays available until preparation succeeds.

The address cache is already present locally. To regenerate it (or after copying the project without its ignored cache):

```sh
curl -sSL --fail 'https://data.sfgov.org/resource/3mea-di5p.json?$limit=250000&$select=address,latitude,longitude,nhood' -o data/sf_addresses.json
python3 scripts/prepare_data.py
```

The current address dataset has 224,394 rows. Increase or paginate the address export if it reaches the requested limit. The runtime site does not need the large address cache.

## Validation

```sh
node --test scripts/test_model.mjs
node --check site/dist/app.mjs
```

Tests cover SF timezone handling around UTC midnight and DST, inclusive date boundaries, missing/inverted date intervals, exact Tow Status classification, and keeping unmatched records in totals. Browser checks cover desktop, 375px and 320px phone layouts, status/date/search filters, empty states, details, map location focus, CSV downloads, and responsive overflow. The browser tool `filter_sf_permits` is registered when WebMCP is available and uses the same visible filter state.

## License

Original project code is [MIT licensed](LICENSE). The bundled MapLibre GL JS 6.12.0 files retain their [BSD 3-Clause license](site/dist/vendor/maplibre/LICENSE.txt). City datasets and external map tiles remain subject to their respective source terms; the MIT license does not relicense those sources.

For optional analysis with DuckDB (not required to run the site):

```sql
CREATE TABLE permits AS SELECT * FROM read_csv_auto('data/permits.csv');
SELECT tow_status, count(*) FROM permits GROUP BY tow_status;
```

# No Stopping SF

Repository: [atbaker/no-stopping-sf](https://github.com/atbaker/no-stopping-sf). Production domain: [nostoppingsf.io](https://nostoppingsf.io).

A mobile-friendly static site for exploring San Francisco Public Works tow sign permits. Includes a map, address/company/permit search, tow status, permit type, neighborhood and date filters, permit details with public photo attachments, summary counts, and full/filtered CSV export. The bundled snapshot runs locally without credentials.

The credit below the page title names the creator, [Andrew Baker](https://x.com/andrewtorkbaker), and links to [Greg Long's post on SF street space permits](https://www.instagram.com/reel/Dd6pwYGB5vG/), which inspired this project. The reel's authorship was verified directly on Instagram; the credit acknowledges inspiration, while the permit counts come from Public Works records.

## Run

Targets [Python 3.14.8](https://www.python.org/downloads/release/python-3148/), the latest stable release verified October 4, 2026. [uv](https://docs.astral.sh/uv/getting-started/installation/) manages Python and dependencies. The exact interpreter is pinned in `.python-version`; `pyproject.toml` declares dependencies and `uv.lock` pins all resolved packages. Serving the bundled snapshot uses only the standard library; MapLibre GL JS is included locally.

```sh
uv run --locked python scripts/serve.py
```

Open **http://127.0.0.1:3000**. The server exposes only `site/dist`, not the workspace or raw data cache. To use another port: `uv run --locked python scripts/serve.py --port 3001`.

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
- Address search: typing a house number and street suggests matching EAS addresses entirely in the browser (no third-party geocoder; typed addresses never leave the device). Choosing one centers the map there (about 600 m across the map's narrower side) and lists the permits in the map view, nearest first; panning or zooming updates the results. Queries without a house number search permit addresses, permit numbers and applicants as text.

Files:

| File | Contents |
| --- | --- |
| `data/permits.csv` | Clean, map-ready CSV, 2,531 rows |
| `data/permits_raw.csv` / `data/permits_raw.json` | Original public Salesforce fields, including selected detail fields |
| `data/download_metadata.json` | Source count, pagination audit, fetch time and scope |
| `data/permit_photos.json` | Public image metadata, current file version IDs, source parents and photo index audit |
| `site/dist/data/permits.json` | Frontend snapshot, normalized fields and metadata |
| `site/dist/data/permits.csv` | Downloadable clean CSV |
| `site/dist/data/metadata.json` | Public snapshot and geocoding audit |
| `site/dist/data/addresses.json` | Compact EAS address index for searching any SF address (~0.9 MB gzipped, loaded only on the first address search) |

CSV free-text fields beginning with spreadsheet formula characters receive a leading apostrophe in the clean exports. JSON and raw CSV preserve the original values.

## Public photos

The Files tab contains generated PDFs directly attached to a permit and photo uploads attached to related `TOW Away Sign Photo` submissions. `download_photos.py` follows only those tow-sign submissions. It indexes image file types (JPEG, PNG, GIF, WebP), excludes direct permit attachments, PDFs and other documents, deduplicates files per permit and retrieves `ContentDocument.LatestPublishedVersionId` for the selected images via bulk UI API reads (100 IDs per request). It stores no uploader profile data or original image bytes. The current index has 4,362 candidate uploads across 1,048 permits.

Submission lists use the public related-list UI API and follow its next-page tokens. Attachments use `RelatedListViewDataManagerController/ACTION$getItems`; row metadata comes from Aura's `$Record` provider. It follows returned offsets/query locators while checking for repeated pages, missing metadata and parent mismatches. This legacy attachment service has not been demonstrated to support arbitrarily large lists for an individual parent: API errors or a full 500-row page marked final fail the refresh instead of silently publishing that result. The permit list itself still uses the verified ID keyset traversal described above.

A permit can have multiple tow-sign submissions, with several images in each. The frontend data model exposes a single nullable `photo` field: the image with the newest upload timestamp, with file ID as a deterministic tie breaker. The full candidate index remains in `data/permit_photos.json`, with file-version lookups required only for the selected photos. This is a selection heuristic, not a determination of which physical sign is currently posted.

The static frontend hotlinks Salesforce's `THUMB240BY180` renditions in opened map popups and `THUMB720BY480` in details. Images are loaded on demand; opening the app does not fetch every permit photo. A sample anonymous request returned a 28 KB thumbnail and a 129 KB larger preview versus a 6.2 MB original. Tapping a photo opens the original, with a separate link to its official source submission/permit. Missing renditions display a fallback and retain the source link. File version IDs determine the URLs; attachment text cannot inject arbitrary image hosts.

Photos are labeled “Submitted tow-sign photo.” The submission links the upload to its permit and address, but it does not independently verify the pictured sign or location. Images may show an earlier posting and are not used to infer Tow Status. Files remain hosted by the city, so availability can change. Every normal refresh re-indexes attachments, because a file can change without changing the permit's modification timestamp. The photo fetch time and coverage counts are included in the snapshot metadata. The CSV `photo` cell contains JSON metadata for the selected image, or is blank.

## What “today” means

Today is calculated in `America/Los_Angeles`, independently of the viewer's timezone. Date coverage uses **inclusive `Tow_Away_Start_Date__c` and `Tow_Away_End_Date__c`**. Where absent, it falls back to proposed permit start (`Start_Date__c`), permit end (`End_Date_Calculated__c`), then expiration. The UI identifies fallbacks. Every record in this snapshot has a valid tow-away date range, so no fallback is needed for current counts.

**Tow Status is copied exactly from the public record at download time.** It is not inferred from phase/status or merely from the appearance of a sign. Changing the date selects permits with matching date coverage, but does not reconstruct historical or predict future Tow Status. Hours, weekdays, physical posting conditions and exact curb limits are not represented. See [Public Works street space guidance](https://sfpublicworks.org/services/permits/street-space) for tow sign verification rules.

## Refresh

```sh
uv sync --locked
npm run refresh
```

The first `uv sync --locked` installs the pinned Python if needed and creates `.venv` with the locked dependencies. Use `uv add` / `uv remove` to change dependencies, and include the resulting `pyproject.toml` and `uv.lock` changes together. Update `.python-version` and the supported Python range when adopting a newer stable Python release. All npm commands invoke `uv run --locked`, which refuses to silently change the dependency lockfile.

Run `npm run refresh` for subsequent refreshes, then reload the browser. It downloads permits, indexes photos and prepares the static snapshot. Details for unchanged records use a cache keyed by the source's `LastModifiedDate`. The scripts fail on incomplete pagination, changed source count, repeated IDs, ignored cursor filters, mismatched photo coverage or API failures; the previously prepared site snapshot stays available until preparation succeeds. An interrupted photo run can resume completed stages with `uv run --locked python scripts/download_photos.py --resume`; this is only for the same interrupted snapshot, not normal nightly refreshes.

Each download process uses one shared [HTTPX](https://www.python-httpx.org/advanced/clients/) client, reusing connections to Salesforce and closing its pool on exit. Photo submission and attachment pages are fetched in bounded waves of three concurrent requests, each containing up to 25 Salesforce actions. Permit ID cursor pages, detail batches and bulk file-version reads remain sequential. Use `uv run --locked python scripts/download_photos.py --concurrency 1` for serial retrieval; the supported range is 1–8. Results are validated and merged in input order on the main thread. Attachment checkpoints remove a batch only after validation succeeds, keeping other in-flight or unprocessed work pending for resume. Images remain hotlinked; these requests retrieve metadata only.

Live HTTPX verification retrieved all 2,531 permit IDs and matched the existing snapshot. A 75-permit photo sample (116 submissions, 338 candidate images, 75 selected file versions) returned identical metadata with serial and concurrent retrieval: 21.64 seconds at concurrency 1 versus 10.91 seconds at concurrency 3. These are sample timings, not a full nightly-job benchmark or a comparison against the previous urllib implementation. See `artifacts/httpx-verification.json`.

All permit, detail, attachment and file-version requests share a [Tenacity](https://github.com/jd/tenacity) policy: at most five attempts, exponential jitter (1–30 seconds), a 300-second retry budget and 60-second HTTPX connect/read/write/pool timeouts. HTTPX transport retries are disabled so attempts are governed by a single policy. It retries connection failures/timeouts, interrupted responses, HTTP 408/429 and 5xx responses; it honors numeric or HTTP-date `Retry-After` headers. A delay that would exceed the retry budget causes failure instead of retrying earlier than requested. The budget is checked between attempts, not a hard deadline that interrupts an active request. Retry warnings report the failure class/status, attempt and delay. HTTP 400/401/403/404, certificate verification failures, malformed data and pagination validation failures are not retried. After exhaustion the original exception is raised and the process exits unsuccessfully, suitable for a future GitHub Actions job. This policy retries reads only, including read-only Aura POSTs; it does not provide workflow scheduling or durable execution.

`npm run refresh` also downloads the complete Enterprise Addressing System dataset. The address downloader uses the same HTTPX/Tenacity policy, stable Socrata row-ID ordering, 50,000-row pages and an explicit final empty page. It rejects duplicate IDs, missing rows and changes in the independent source count, then atomically replaces the ignored address cache. There is no fixed total-record cap. Equal counts cannot detect every concurrent source edit; this remains a live traversal. The runtime site does not need the address cache.

## Deployment

Cloudflare **Workers Static Assets** serves `site/dist`, with no Worker script or live database. `wrangler.jsonc` binds `nostoppingsf.io` as a custom domain; Wrangler provisions the domain's DNS and certificate. Static asset requests use Cloudflare's CDN, automatic compression and browser revalidation defaults. Missing files return 404, including missing data URLs.

The `Refresh and deploy` GitHub Actions workflow runs on pushes to `main`, manually, and nightly at **10:37 UTC (3:37 AM PDT / 2:37 AM PST)**. GitHub schedules can be delayed. Every deployment checks out current `main`, installs the locked Python dependencies with uv, runs tests, fetches addresses and permits, indexes tow-sign photo metadata, prepares the snapshot, and uploads only `site/dist`. Permit details are cached by source modification date; attachments are re-indexed on every run. Photos stay hotlinked. Runs are serialized, with a 45-minute timeout.

A retrieval or validation failure prevents publication, keeping the previous deployment online. Each successful refresh archives its public data for 14 days; failed runs retain available public metadata and photo checkpoints for seven days. Generated snapshots are published directly, without daily bot commits. After deployment, a smoke check compares the public HTML, JavaScript, JSON and CSV to the files from that run.

Repository secrets required in [GitHub Actions settings](https://github.com/atbaker/no-stopping-sf/settings/secrets/actions):

- `CLOUDFLARE_ACCOUNT_ID`: the account ID in `wrangler.jsonc` (an identifier, not a credential).
- `CLOUDFLARE_API_TOKEN`: a scoped token with **Account → Workers Scripts → Edit**, plus **Zone → Zone → Read** and **Zone → Workers Routes → Edit** for `nostoppingsf.io`, allowing Wrangler to manage the custom domain. A local `wrangler login` does not configure GitHub's credentials.

For a manual deployment with an authenticated local Wrangler:

```sh
npm test
npm run refresh
npx wrangler@4.148.0 deploy
uv run --locked python scripts/verify_deployment.py https://nostoppingsf.io
```

To refresh and publish from GitHub instead:

```sh
gh workflow run deploy.yml --ref main
```

Pull requests run the separate `Validate` workflow without Cloudflare secrets, public-source downloads or deployment. Cloudflare configuration stays in the repository; a separate Cloudflare Git integration is unnecessary.

## Validation

```sh
npm test
node --check site/dist/app.mjs
```

Tests cover SF timezone handling around UTC midnight and DST, inclusive date boundaries, missing/inverted date intervals, exact Tow Status classification, keeping unmatched records in totals, safe photo URLs, attachment pagination, choosing one eligible photo, transient retry recovery, permanent failures, attempt exhaustion, `Retry-After`, concurrent HTTP requests, ordered result merging and resuming unvalidated batches after a failure. Browser checks cover desktop, 375px and 320px phone layouts, status/date/search filters, empty states, details, map location focus, CSV downloads, and responsive overflow. The browser tool `filter_sf_permits` is registered when WebMCP is available and uses the same visible filter state.

## License

Original project code is [MIT licensed](LICENSE). The bundled MapLibre GL JS 6.12.0 files retain their [BSD 3-Clause license](site/dist/vendor/maplibre/LICENSE.txt). City datasets and external map tiles remain subject to their respective source terms; the MIT license does not relicense those sources.

For optional analysis with DuckDB (not required to run the site):

```sql
CREATE TABLE permits AS SELECT * FROM read_csv_auto('data/permits.csv');
SELECT tow_status, count(*) FROM permits GROUP BY tow_status;
```

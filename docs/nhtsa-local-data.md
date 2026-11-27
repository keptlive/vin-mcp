# Local NHTSA recalls, complaints and safety ratings

Reports answer recall, complaint and 5-Star Safety Rating questions from mcp.vin's own copies of NHTSA's public data,
the same way VINs are decoded from a local vPIC database. NHTSA's live API (api.nhtsa.gov) is only the fallback.
Why: api.nhtsa.gov timed out about 60 times a day on 24-26 November 2026, and every timeout dropped a section from a
report. Code: `lib/nhtsa-local.mjs` (lookups), `lib/nhtsa.mjs` (local first, live fallback), `scripts/import-nhtsa-*.py`
and `scripts/harvest-nhtsa-*.py` (the data), `scripts/nhtsa-build.sh`, `scripts/nhtsa-install.py`, `scripts/nhtsa_datasets.py`
and `deploy/systemd/` (refresh of every NHTSA-derived file, not installed).

## What is kept

| File | Built from | Size (27 Nov 2026) | Build |
| --- | --- | --- | --- |
| `data/nhtsa-recalls.db` | NHTSA's recall flat files `FLAT_RCL_PRE_2010.zip` and `FLAT_RCL_POST_2010.zip` (static.nhtsa.gov/odi/ffdd/rcl/, republished daily around 08:00 UTC; 22.6 MB zipped, 314 MB of text, 330,408 rows), plus one record per campaign from NHTSA's recall API (below) | 79 MB: 30,494 campaigns, 196,260 vehicle and component rows, 85,252 make/model/years | about 40 s |
| `data/nhtsa-complaints.db` | NHTSA's complaint flat file `FLAT_CMPL.zip` (static.nhtsa.gov/odi/ffdd/cmpl/, republished daily around 10:15 UTC; 378 MB zipped, 1.63 GB of text, 2,270,753 rows) | 1.72 GB: 1,710,088 complaints under 1,635,489 complaint numbers, 36,992 make/model/years | about 2-3 min, 720 MB of memory, about 4 GB of temporary files |
| `data/nhtsa-ratings.db` | a crawl of NHTSA's 5-Star Safety Ratings API (no bulk file has what the API answers) | 22 MB: 17,721 rated variants of 12,627 models, model years 1990-2027 (31,767 requests, 10.7 hours) | 3 s |

The files are not in git. They are built on a server, never on the phone. The complaint copy keeps only what a report
shows: make, model, year, complaint number, crash, fire, injuries, deaths, incident and received dates, components and
the complaint text. The flat file's personal fields (VIN, city, state, dealer and owner details) are not stored.

## How a lookup answers

`getRecalls`, `getComplaints` and `getSafetyRatings` (and the related recall names of `getRelatedModelRecalls`) ask the
local copy first. Every answer carries `data_source`: `source` (`mcp_vin_nhtsa_local` or `nhtsa_api`), a label, the
NHTSA file date (`file_date`), the newest report or complaint in the copy, and `fallback_reason` when the live API
answered instead:

- `local_data_off` (`NHTSA_LOCAL_DB=off`, used by the tests), `dataset_not_installed`, `dataset_unreadable`;
- `dataset_stale`: the copy's NHTSA file date is more than 7 days old (recalls, complaints) or its last complete crawl
  more than 45 days old (ratings), so the refresh has stopped working;
- `not_crawled` (ratings only): the crawl has no clean answer for that make, model and year, or for one of its
  variants.

If the live API then fails, the local copy answers anyway, with `live_api: "failed"` and a note.
`NHTSA_COMPLAINTS_FIRST=live` turns the order around for complaints only: the live API first, the local copy when
it fails (`data_source.mode: "live_first"`). The complaint flat file cannot reproduce which vehicle NHTSA's API
files every complaint under (see Parity), so this keeps the live lists exact while the API works and still answers
when it does not; the default is local first. `NHTSA_RECALLS_DB`,
`NHTSA_COMPLAINTS_DB` and `NHTSA_RATINGS_DB` replace a file path. The server opens the files read-only and reopens a
file within a minute after the refresh replaces it; no restart is needed. With the recall copy in use, related model
names come from it too, and NHTSA's products API is not asked.

## How local rows match the live API

The lookups return rows in the live API's own shape, so `lib/nhtsa.mjs` maps local and live answers with the same
code. These rules were measured against live answers (pilot of 121 recall and 129 complaint keys, then the parity run
below).

**Recalls** (`recallsByVehicle`):

- Make and model match ignoring case and nothing else, like the API (`F150` does not find `F-150`).
- One row per campaign. The flat files list every recalled component for each vehicle; the API names ONE component
  per campaign, the same for every vehicle, by no rule visible in the flat files. Campaign text, dates and advisories
  are the same on every flat-file row of a campaign (0 of 30,494 differ).
- `Manufacturer` is the flat file's MFGNAME. `parkIt` and `parkOutSide` are the flat file's DO_NOT_DRIVE and
  PARK_OUTSIDE, only for vehicle campaigns (the API gives equipment, tire and child-seat campaigns neither).
- What only the API has comes from a gentle crawl of `api.nhtsa.gov/recalls/campaignNumber`, one request per
  campaign (`scripts/harvest-nhtsa-recall-campaigns.py`): the over-the-air flag (in no NHTSA bulk file, not in DOT's
  datahub copy either), the API's one component, its report date (one day after the flat file's on about 6% of
  campaigns; the flat file and DOT's datahub agree with each other) and the texts' line breaks (the flat files turn
  them into spaces) and its `?` for characters outside ASCII (the flat files carry the raw Windows-1252 byte). The
  build takes the API's component as it is (on 3 of 30,152 campaigns it is a component the flat files do not recall
  in that campaign, e.g. 22V037000), its date only within 3 days of the flat file's (all 634 differing dates are), and
  a text only when it differs from the flat file's in whitespace or non-ASCII characters alone. A campaign the crawl
  has not reached yet shows the first recalled component in file order and the flat file's date, and has no
  over-the-air flag (null, never false). The first full crawl (27 Nov 2026, 0.5 s apart, 4 h 57 min) fetched all
  30,494 campaigns: 30,152 answered, 342 absent from the API (equipment and old campaigns), 0 failed.
- `components` (not in the API) lists every component the flat files recall for that vehicle when there are several.
- Order: the API's campaign order follows no rule found (not by date, number or component). Local rows are newest
  report first.

**Complaints** (`complaintsByVehicle`):

- One complaint per complaint number and text: one number can hold several complaints with different texts (21,000
  numbers, all but 2 filed before 2003).
- `components` is the top-level part (before the first `:`) of every component the complaint names, across every
  product it names: the API lists a tire or equipment component of the same complaint too. The API's order of those
  components follows no rule found (file order fits 43% of multi-component complaints, alphabetical 42%); local
  order is file order.
- Dates are month first. `dateComplaintFiled` is the flat file's LDATE (4,028 of 4,028 in the pilot). A missing
  incident date is null.
- Order: newest filed first, then complaint number.
- The API answers HTTP 400 with an empty success body when it has no complaints, and also for some vehicles the flat
  file has complaints for (2010 Nissan Frontier: 77; repeatable). The live code treated every 400 as "unavailable";
  the local copy answers them.

**Safety ratings** (`SafetyRatings`): the crawl stores exactly what the live code asks, so the local answer is the
live answer of the day of the crawl. It walks model years, makes, models, variants and each variant's ratings, one
request at a time with a 1 s pause, and keeps the API's variant order (the report's primary rating is the first
variant). Models whose name contains `/` answer HTTP 400 to the API's own list call; those (and any path that never
ran clean) are recorded as gaps and left to the live API. NHTSA's bulk file
(`static.nhtsa.gov/nhtsa/downloads/Safercar/Safercar_data.csv`) cannot replace the crawl: it has no vehicle ids or
variant descriptions, not the API's order, and had not been updated since 7 August 2026 (no model year 2027).

## Parity with the live API

Method: 5,500 make/model/year triples drawn from 25,073 vPIC-decoded VINs (4,000 random, 1,500 of the most common
makes) plus 1,000 recall triples filed under another model name, each asked of the live API by origin/main's own
code on 27 November 2026 (one request at a time, 1 s apart; items hit by timeouts or errors were retried up to 4
rounds) and answered by this branch's local lookups with a network that throws. Tools and raw results:
`/root/vin-mcp-research/nhtsa-local-2026-11-27/` and the storage server's `/root/nhtsa-local/parity/`.

**Complaints** (5,500 triples, flat file of 26 November):

| | Items |
| --- | --- |
| Live API answered | 3,032 |
| ... same complaints listed | 2,163 (71%) |
| ... live lists complaints the local copy does not | 732 |
| ... local lists complaints the live API does not | 100 |
| Live API answered HTTP 400 (shown as unavailable by the live code) | 2,468 |
| ... local copy also has none | 2,112 |
| ... local copy has complaints | 356 |

Complaints listed: live 555,524, local 514,094; 50,461 only live (9.1%), 9,031 only local. Why, from the flat
rows of 3,506 live-only complaints (68 vehicles early in the run): NHTSA's API files complaints under a model the flat file
does not show: old rows whose model text is the make (`CHEVROLET` `CHEVROLET` 1996, listed by the API under TAHOE),
odd model text (`TRAILBLAZER EXT 370`, listed under TRAILBLAZER), model families (`MERCEDES BENZ` `GL450`, listed
under `MERCEDES-BENZ` `GL-CLASS`); some old complaint numbers are listed more than once by the API; a few complaints
are not in the flat file at all. No matching rule on the flat file reproduces this: allowing longer names, hyphens or
`-CLASS` families fixes some vehicles and adds wrong complaints to others. Of 505,063 complaints in both lists:
components are the same set in another order for 68,391 (the API's order follows no rule found) and differ for 222
(old numbers the API lists twice); texts differ for 1,099 (the flat file cuts texts at 2,048 characters, 1,735
complaints in all; the API drops `$` and emoji); dates differ for 45 and crash, fire or injury flags for 4 (all old
numbers the API lists twice). Complaint order differs in 566 of 1,702 lists with the same complaints.

**Recalls** (6,500 triples: 4,000 random, 1,500 common makes, 1,000 filed under another model name; flat files of 26
November with the campaign crawl of 27 November):

| | Items |
| --- | --- |
| Same campaigns listed | 6,424 (98.8%) |
| ... and in the same order too | 4,351 |
| Live lists campaigns the local copy does not | 48 (39 none at all locally, 9 more) |
| Local lists campaigns the live API does not | 28 (11 none at all live, 17 more) |

Every field of every campaign both sides list is identical: 14,662 of 14,662 campaign rows equal in campaign number,
component, summary, consequence, remedy, report date, manufacturer, park-it, park-outside and over-the-air flag.
Before the campaign crawl the same rows differed in the over-the-air flag (null locally on 12,929), the component of
multi-component campaigns (948), the report date (one day earlier on 766), whitespace in texts (1,069) and one
Windows-1252 character. The 76 items whose campaign lists differ come from the API's own model assignment, which
the flat files do not show: models the flat files file under `REDUNDANT` names (`YAMAHA` `redundant YZF-R3`), model
families and spellings (`MERCEDES-BENZ` `GLA 250` and `C 300`, `THOR MOTOR COACH` `FOUR WINDS` against `FOUR WINDS
5000`), recent campaigns the flat file of 26 November did not have yet (`LAND ROVER` `Range Rover Sport` 2026), and
two campaigns the API lists that no flat file holds (96V178010, 19V762000). A rule mapping `REDUNDANT` names fixed 12
items and broke 4, so it is not used. Order: in 2,073 of 2,580 lists with the same two or more campaigns the API's
order differs from the local newest-report-first order; no simple rule reproduces the API's (campaign number
ascending, the best, fits 762; flat-file record order 524).

**5-Star Safety Ratings** (5,500 triples): all 5,453 that the live API answered are identical, field for field and in
variant order (2,318 rated, 3,135 not rated). The other 47 are model names with `/` (`C/K Pickup`, trailers, golf
cars), which the live API answers with HTTP 400 and the live code shows as unavailable; the local copy answers "not
rated" (NHTSA lists no such model). 84 of the crawl's paths never answered cleanly, all models whose name contains
`/` (`C/K` 1993-1998, `911 CARRERA/CARRERA CABRIO` 2002): those vehicles go to the live API, which answers them
HTTP 400 too. Many vehicles show no rating on both sides because NCAP names models differently from vPIC
(`ACCORD SEDAN`, `CIVIC SEDAN` against vPIC's `Accord`); this branch does not change that.

## Refresh

The refresh covers every NHTSA-derived file the site serves, not only the three above: `nhtsa-recalls.db`,
`recall-labels.db`, `nhtsa-complaints.db`, `investigations.db`, `communications.db`, `nhtsa-ratings.db` and `vpic.db`.
Until this branch none of them refreshed (on 27 Nov 2026 the web server's `investigations.db` and `communications.db`
dated from 24 Oct, `recall-labels.db` from 17 Nov, `vpic.db` from 18 Nov). The registry of all seven, with each one's
tables, row floors, cadence and alert limits, is `scripts/nhtsa_datasets.py`.

**Build on the build server, never on the web server.** `scripts/nhtsa-build.sh` runs on storage (104.37.188.237):

- `odi`, daily 12:30 UTC, after NHTSA's morning updates (Last-Modified on 27 Nov: FLAT_RCL 08:03, FLAT_INV 09:05,
  FLAT_CMPL 10:08, the seven TSB archives 11:04-11:10 UTC). Each file is fetched only when it changed: a HEAD request
  first, and when its ETag (the file's MD5) equals the copy on hand nothing is downloaded; otherwise a GET with
  If-Modified-Since (static.nhtsa.gov ignores If-None-Match). NHTSA regenerates all seven TSB zips every day (new
  timestamps inside, so new MD5s: on 27 Nov every archive differed from the 24 Oct copies, while only the newest one,
  2025-2026, had gained rows: 814,313 to 854,132), so the bulletin archives (about 88 MB) are downloaded and the
  bulletin index rebuilt (about 7.5 min) every day. A download must match its ETag and
  test clean as a zip. Then the recall campaign crawl (new, amended and recent campaigns plus 200 older ones, at most
  2,500 a run, 1 s apart), and a rebuild of only the datasets whose files changed. The newest TSB archive is named by
  its end year (`TSBS_RECEIVED_2025-2026.zip`); the build looks for this year's name, then last year's, and fails
  loudly (with the fix: `NHTSA_TSB_PERIODS`) if NHTSA renames it some other way.
- `ratings`, Sundays 05:00 UTC: the ratings crawl of the current and next model years (about 2,200 requests, under
  an hour); older years keep their stored answers. `NHTSA_FULL_CRAWL_DAYS` (off) can re-crawl every year.
  `Safercar_data.csv` is not used: it had not changed since 7 Aug 2026.
- `vpic`, daily 06:10 UTC: two HEAD requests for this and last month's `vPICList_lite_YYYY_MM.plain.zip`. On a new
  release, `scripts/vpic-refresh.sh` builds it and compares 20,000 decodes with NHTSA's own `spvindecode`; a release
  whose parity is not exact or whose rule fixes need review is not published and mails instead.
- One build at a time on that box (1 CPU, 3 GB): a mode waits up to 6 h for another.

**Gate before anything is published, and again before anything is installed** (`nhtsa_datasets.py gate`): the file
opens and passes `PRAGMA quick_check`; every table and column the site reads exists; row counts are above a floor and
not down more than 3% from the copy it would replace (the importers' own guard is 1%); and the site's own lookup code
gives known answers from it (`scripts/nhtsa-known-answers.mjs`: the 2003 Honda Accord's Takata recall 15V320000 and
1,800+ complaints, the 2005 Cobalt's 14V047000, a 5-star 2020 Camry, EA14001 on the 2011 Durango, 200+ bulletins for
the 2015 F-150, 1HGCM82633A004352 decoding to a 2003 Accord). The web server runs the gate with its own deployed code,
so a file built by newer or older code than the site runs is refused instead of breaking the site. A failed gate
keeps the live copy.

**Publish and pull.** A passing build is published on storage as `publish/<name>.<sha256-12>.db` with a manifest
`publish/<dataset>.json` (sha256, size, rows, NHTSA source files with Last-Modified and ETag, source date, built date,
builder commit); the previous version stays for pulls in flight. Every outcome (published, unchanged, failed,
gate_failed, needs_review, with NHTSA's newest Last-Modified seen) goes to `publish/builder-status.json`. The web
server pulls hourly (`scripts/nhtsa-install.py pull`) over WireGuard with a read-only rsync key (`rrsync -ro`, like
the write-only key the listing crawler ships with): the manifests first, then only a dataset whose published sha256
differs from the installed one. The file is copied by rsync against a hard link of the live file, so only changed
blocks travel, then checked against the manifest's sha256 and gated.

**Atomic swap, one-step rollback.** The live file is hard-linked to `data/<file>.prev`, then the new file is renamed
over `data/<file>` (one `rename`, so a reader sees the old or the new file, never half of one). The site needs no
restart: the research lookups open the file per request; recalls, complaints, ratings and vPIC notice a replaced file
within a minute. `nhtsa-install.py rollback <dataset>` renames `.prev` back and marks the rolled-back build so it is
never pulled again; the next build is.

**Status lines.** `/var/lib/vin-mcp-nhtsa/status.jsonl` on the web server: one line per dataset with its state
(installed, manual = put there by hand, missing), source date, built date, installed date, rows, sha256 and
`confirmed_at` (the last time the build server checked NHTSA and found this copy current), plus the build server's
last outcome. Files installed by hand before this refresh are read from their own metadata.

**Freshness alert.** `nhtsa_datasets.py check` (web server, every 6 h) mails the owner through
`/opt/host-alert/notify.py`, each problem at most once per 20 h, when:

| Dataset | NHTSA changes it | Refresh | Stale (not confirmed against NHTSA for) | Source alert (NHTSA's file unchanged for) |
| --- | --- | --- | --- | --- |
| nhtsa-recalls, recall-labels | daily | daily build, hourly install | 48 h | 3 days (the site asks NHTSA live first at 7) |
| nhtsa-complaints | daily | daily build, hourly install | 48 h | 3 days (live first at 7) |
| investigations | daily | daily build, hourly install | 48 h | 3 days |
| communications | daily (all 7 zips regenerated; the newest gains rows) | daily build | 48 h | 3 days |
| nhtsa-ratings | a few ratings a month | weekly crawl (current + next model year) | 15 days | 15 days since the last complete crawl (live first at 45) |
| vpic | monthly | daily release check; build + parity on a new release | 48 h (the daily check) | 63 days since NHTSA's release |

and also at once when a download, build or gate failed or a vPIC release needs review (build server report), when the
web server refused or could not install a published build for 6 h, when pulls from the build server failed for 6 h,
or when the build server has not reported for 36 h. `check --dry-run` prints what it would mail.

Install steps, schedules and rollback: `deploy/systemd/README.md` (not installed). The first install brings the
three new files to the web server (about 1.8 GB) and replaces the four existing ones with fresh builds.

## Still asked live

NHTSA's live API is still asked for: a lookup with a fallback reason above; the 5-Star Safety Ratings of vehicles the
crawl has as gaps; the products API for related recall names when the recall copy is not in use; VIN decodes the
local vPIC decoder cannot answer; and Canadian specifications (`GetCanadianVehicleSpecifications`, research
dimensions), which have no local copy.

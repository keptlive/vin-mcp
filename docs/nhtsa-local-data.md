# Local NHTSA recalls, complaints and safety ratings

Reports answer recall, complaint and 5-Star Safety Rating questions from mcp.vin's own copies of NHTSA's public data,
the same way VINs are decoded from a local vPIC database. NHTSA's live API (api.nhtsa.gov) is only the fallback.
Why: api.nhtsa.gov timed out about 60 times a day on 24-26 November 2026, and every timeout dropped a section from a
report. Code: `lib/nhtsa-local.mjs` (lookups), `lib/nhtsa.mjs` (local first, live fallback), `scripts/import-nhtsa-*.py`
and `scripts/harvest-nhtsa-*.py` (the data), `scripts/nhtsa-refresh.sh` and `deploy/systemd/` (refresh, not installed).

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
  them into spaces). The build uses each crawled value only where it still fits the flat files: the component only
  when the flat files recall it in that campaign, the date only within 3 days of the flat file's, a text only when it
  differs from the flat file's in whitespace alone. A campaign the crawl has not reached yet shows the first recalled
  component in file order and the flat file's date, and has no over-the-air flag (null, never false).
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

RECALL_PARITY

**5-Star Safety Ratings** (5,500 triples): all 5,453 that the live API answered are identical, field for field and in
variant order (2,318 rated, 3,135 not rated). The other 47 are model names with `/` (`C/K Pickup`, trailers, golf
cars), which the live API answers with HTTP 400 and the live code shows as unavailable; the local copy answers "not
rated" (NHTSA lists no such model). 84 of the crawl's paths never answered cleanly, all models whose name contains
`/` (`C/K` 1993-1998, `911 CARRERA/CARRERA CABRIO` 2002): those vehicles go to the live API, which answers them
HTTP 400 too. Many vehicles show no rating on both sides because NCAP names models differently from vPIC
(`ACCORD SEDAN`, `CIVIC SEDAN` against vPIC's `Accord`); this branch does not change that.

## Refresh

`scripts/nhtsa-refresh.sh flat` (daily) downloads the three flat files only when NHTSA changed them (static.nhtsa.gov
answers If-Modified-Since with 304; it ignores If-None-Match), checks each download against its ETag (an MD5) and
tests the zip, crawls the recall campaigns that are new, amended (their flat-file values changed), recent (reported
in the last 120 days, again every 14 days) or longest unchecked (200 a day), at most 2,500 a run, and rebuilds what
changed. `scripts/nhtsa-refresh.sh ratings` (weekly) re-crawls the model years from two years back onward and,
every 90 days, every model year. Every build writes a new file and renames it over the old one, refuses a result
with over 1% fewer campaigns, complaints or rated variants than the file it replaces, and the script refuses to start
with less than 8 GB free. Outcomes go to `/var/lib/vin-mcp-nhtsa/status.json` and the journal. Timers and install
steps: `deploy/systemd/README.md` (not installed).

First deploy (with the owner's go): copy the three `.db` files built on the storage server into `/opt/vin-mcp/data/`
(the server picks them up within a minute), and seed `/var/lib/vin-mcp-nhtsa/` with the crawl states
(`recall-campaigns.db`, `ratings-crawl.db`) so the timers continue the crawls instead of starting over.

## Still asked live

NHTSA's live API is still asked for: a lookup with a fallback reason above; the 5-Star Safety Ratings of vehicles the
crawl has as gaps; the products API for related recall names when the recall copy is not in use; VIN decodes the
local vPIC decoder cannot answer; and Canadian specifications (`GetCanadianVehicleSpecifications`, research
dimensions), which have no local copy.

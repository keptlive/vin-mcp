# Data sources and coverage - v1.6.0

Sources and implementation reviewed 24 October 2026. Public research requires no paid data
provider. Hosting, maintenance and upstream availability remain operational considerations.

| Source | Use | Scope |
| --- | --- | --- |
| [NHTSA vPIC](https://vpic.nhtsa.dot.gov/api/) | VIN decoding, manufacturer-submitted attributes and Canadian specifications | US-oriented coverage; Canadian dimensions describe model variants. |
| [FuelEconomy.gov](https://www.fueleconomy.gov/feg/ws/) | Explicit EPA test configurations, emissions, price assumptions and voluntary owner MPG | Configuration-level data; owner reports are not a representative fleet sample. |
| [NHTSA datasets](https://www.nhtsa.gov/nhtsa-datasets-and-apis) | Manufacturer communications and defect investigations | Dated local snapshots; model-year associations do not establish VIN applicability or repair completion. |
| [Federal Reserve G.19](https://www.federalreserve.gov/releases/g19/20261007/) | New-car loan benchmark context | August 2026 observations from the October 7 release; manually refreshed, not a lender offer. |

The communication index has 5,834,958 vehicle/component association rows across seven
received-date archives. This is not a count of unique bulletins. The optional compact layout
retains every logical row and its metadata behind the same SQL view; its builder verifies
the ordered row digest before publishing a new target file.

The investigation snapshot has 154,439 source associations and 5,351 distinct action IDs.
Different reports under the same action ID are retained. Unknown model years are excluded
from exact-year searches. A missing closing date is not asserted to mean an active case.

The 2003 Honda Accord V6 automatic example, EPA ID 18657, returned 22 combined EPA MPG
and 23.5 owner-reported harmonic mean MPG from 29 submitted records (range 15-34 MPG).
The measures use different methods and samples. Counts reflect the dated verification.

Full auto.dev parity is incomplete. There is no verified nationwide plate-to-VIN API,
inventory feed, universal factory build-sheet source or universal VIN repair-status coverage
in this release. Tesla, Ford, GM and Honda VIN status and Mopar open records are integrated with the limits below; Nissan supplies positive VIN-matched safety recalls; Toyota, Hyundai and Kia use official interactive verification links. Cost results use explicit assumptions;
resale, maintenance and insurance values are not predictions.

Source availability, timestamps, limits and exports accompany research results. The capability
register and printable sheets describe the current implementation without implying equivalent
coverage or service performance to another provider.

## NHTSA model-year campaigns

`recallsByVehicle` answers a make/model/year with no campaigns with HTTP 400 and the body `{"Count":0,"Message":"Results returned successfully","results":[]}`. Only that exact body counts as zero campaigns; any other non-200 response stays unavailable. `ReportReceivedDate` is day-first (`15/10/2024`); `report_received_date` gives the same date as ISO `YYYY-MM-DD`, and `report_date` keeps NHTSA's original text. NHTSA's `parkIt`, `parkOutSide` and `overTheAirUpdate` campaign advisories become `park_it`, `park_outside` and `over_the_air_update`, or null when missing.

vPIC and NHTSA recall data often use different model names, and `recallsByVehicle` matches the model name exactly (case is ignored, punctuation and spacing are not: `F150` returns nothing for 2018 while `F-150` returns 19 campaigns). A 2024 CR-V hybrid decodes as `CR-V`, while three of its campaigns are filed only under `CR-V HYBRID`. A November 16, 2026 comparison of vPIC model names (30 makes, model years 2012-2025) with NHTSA's recall flat files found campaigns filed under another name for about one vPIC model name in six, in these patterns:

| Pattern (`match`) | vPIC name | NHTSA name |
| --- | --- | --- |
| `longer_name` | CR-V, Silverado, ES | CR-V HYBRID, SILVERADO 1500, ES350 |
| `spelling` | Mustang Mach-E, F 800 GS | MUSTANG MACH E, F800 GS |
| `parenthetical` | Prius Prime (PHEV) | PRIUS PRIME |
| `family_name` | C-Class, EQS-Class Sedan | C 300, AMG C63, EQS 450 |
| `make_name` | Nissan Z | Z |
| `shorter_name` | Expedition MAX, Wrangler JK | EXPEDITION, WRANGLER |
| `trailing_name` | Golf GTI | GTI |

`shorter_name` and `trailing_name` are used only when NHTSA has never filed a campaign under the decoded name itself; otherwise the shorter name is usually another vehicle (Transit Connect and TRANSIT). Names that share only a first word (Silverado LD and SILVERADO 1500) are not matched.

Reports therefore add `recalls.related_models`: campaigns filed under related NHTSA model names for the same make and year, excluding campaigns already listed, each model tagged with its `match`. They may or may not apply to the vehicle and never count as VIN status or toward `recalls.count`. Up to eight related names are looked up per make, model and year, one at a time; any others are listed in `unchecked_labels`. `/api/vin/{vin}/recalls`, MCP `lookup_recalls` and full reports all carry the same block.

The related names come from two places. NHTSA's `/products/vehicle/models?issueType=r` list returns only part of a make's model names (5-20 rows per make and year, alphabetical and cut short; the same reply on repeat), so on its own it misses most related names; `label_sources.products_api` says `partial_list`. `scripts/import-recall-labels.py` builds `data/recall-labels.db` from NHTSA's recall flat files (`FLAT_RCL_PRE_2010.zip` and `FLAT_RCL_POST_2010.zip`): every model name per make and model year, with its campaign numbers. When it is installed, `label_sources.flat_file_index` gives the newest report date in the snapshot. Campaign details still come from the live API.

The live API sometimes files a campaign under other text than the flat file (`GLE350` for the flat file's `GLE 350`; `RAM` `1500` for the flat file's `DODGE` `RAM 1500` in 2012; nothing for `C 300` in 2017, where the flat file lists 15 campaigns, because the live API files them as `C300`). In a November 16, 2026 sample of 150 campaigns, 99% of flat-file rows for other makes appeared with the same text in the live API, but only 73% of Mercedes-Benz rows did: the live API also uses the make text `MERCEDES BENZ` without the hyphen (`recallsByVehicle` for `MERCEDES-BENZ` `GL350` 2012 returns nothing; `MERCEDES BENZ` returns 3 campaigns). Campaigns the index lists under the exact or a checked related name that no live answer returned appear by number in `related_models.flat_file_only`, never in the counts.

`recalls.count` stays the exact-name count. `recalls.related_campaigns_found` is `true` when related names carry campaigns (live or flat-file only), `false` when none were found, and `null` when related names could not be checked. `recalls.count_note` explains a count that may understate: related campaigns found, related names not checked, or (`related_models.decoded_name_in_recall_data: false`) a decoded model name under which NHTSA has never filed a campaign for that make. The web report shows related campaigns under their own heading and does not show a green zero in those cases.

## VIN-specific recall repair status

Tesla Service's [official VIN recall search](https://service.tesla.com/en-US/vin-recall-search) exposes manufacturer-reported statuses including “Recall Completed” and “Recall Incomplete.” The adapter uses the same public Tesla endpoint, requires no account or paid feed, and provides checked timestamps, original status text, campaign details and manufacturer bulletin links. Successful responses are cached for up to 15 minutes; failures are not cached. This endpoint is not a documented third-party API and may change.

`GET /api/vin/{vin}/recall-status`, `VinClient.recallStatus(vin)` and MCP `vin_recall_status` expose this data. VIN reports and printable comparisons include the summary. Tesla and Ford supply open/completed states. Subaru supplies completed and incomplete safety recalls, with emissions campaigns listed separately. Volkswagen, Audi and Land Rover report open recalls, and completed ones only where their lookup returns them. Acura is covered through the Honda lookup. (Added 2026-11-16 in `lib/more-manufacturer-recalls.mjs`; open records have been seen live for Volkswagen and Audi; completed records for those two, and any Land Rover or Jaguar record, have only been read from the makers' page code. Jaguar shares Land Rover's lookup. BMW's lookup did not answer plain requests and is not used.) GM supplies open/completed or administratively closed records, and explicit repair dates where supplied. Honda supplies active safety recalls; Nissan supplies positive open safety recalls and Mopar supplies VIN-matched open recall/campaign records, with the limitations below. Toyota, Lexus, Scion, Hyundai and Kia require interactive verification; other manufacturers return unknown with an official lookup link. Unknown response statuses never count as zero open recalls; recall dates never become repair completion dates. Results are not a complete service history or a guarantee of safety. Successful results are cached for up to 15 minutes; failures are retried. Public manufacturer interfaces are undocumented for third-party integration and can change.

### Ford: open/completed recalls and separate programs

The [official Ford VIN page](https://www.ford.com/support/recalls/) serves its VIN-specific status in the same public page used by the browser. The adapter parses the serialized data as JSON; it never executes downloaded JavaScript. Both the page VIN and the returned vehicle VIN must match. The success flag, validation flag, arrays and declared record counts must agree. `O` means open and `C` means completed; other values remain unknown. Safety/environmental recall records and customer-satisfaction programs are separate. Coverage begins January 1, 2004. No repair date is supplied, so `repair_completed_at` remains null. The same official checker accepts Ford, Lincoln and Mercury; upstream confirmation still controls availability.

### GM: completed status is not always a physical repair

The [official GM Recall and Warranty Center](https://experience.gm.com/ownercenter/recalls) provides a free guest VIN request, `/ownercenter/api/{vin}/gfas`, without an account or paid feed. The response must confirm the full VIN and contain no upstream errors. Product-safety (`ZPSR`), noncompliance (`ZNCR`) and emissions (`ZPER`) recalls contribute to the recall counts. Customer-satisfaction (`ZCSP`) and special-coverage (`ZSPP`) records appear separately in `service_campaigns`; unfamiliar classifications fail closed. The client identifies itself as `vin-mcp/1.6.0`.

GM `complete` can mean **Dealer Repaired** or **Manual Complete - OTHER**. The original completion basis is retained in `completion_description`. `repair_completed_at` uses only an explicit `repairDate`; `manufacturer_closed_at` uses the separate `closingDate`. An administrative closure never fabricates a repair date. Multiple GM program numbers may share one NHTSA campaign; these are manufacturer record counts, not counts of distinct defects. The official site's stated coverage begins August 20, 1999. The lookup covers current and legacy GM brands subject to upstream recognition.

### Honda: active safety recalls, not completed history

The [official Honda MyGarage checker](https://mygarage.honda.com/s/recall-search?brand=honda) exposes a free guest action, `OwnAPIController.getRecallsByProductIdentifier`, used by the public vehicle lookup. The adapter discovers the current public framework version from the guest page and submits the VIN with automobile division `A`, without credentials, browser session tokens, login or CAPTCHA. It accepts only a successful action, explicit non-error response and a full matching VIN. `Recall INCOMPLETE` is an open record; unrecognized status strings remain unknown.

A recognized Honda VIN with no active recalls comes back as `campaignType: {}` with no `campaign` array, together with `division_cd` and `model_group_name` (verified November 16, 2026). A VIN Honda does not recognize also returns `campaignType: {}`, but without `division_cd` or `model_group_name`. The adapter therefore reports zero active recalls only when the VIN, division `A` and a model group all confirm the vehicle; otherwise the result stays unconfirmed. Coverage is U.S. Honda automobile safety recalls announced in the past 15 calendar years. `completed_count` remains null because this is an active-recall feed, not completed repair history. A confirmed empty array can establish zero returned active recalls within that scope; an error, missing array or VIN mismatch cannot. Campaign dates never become repair dates. Acura and Honda powersports coverage is not claimed by this adapter.

NHTSA’s [interactive VIN lookup](https://www.nhtsa.gov/recalls) identifies unrepaired recalls, but explicitly excludes completed repairs and has age, manufacturer and timing limitations. Its [API use policy](https://api.nhtsa.gov/) does not support using its consumer VIN API for bulk third-party lookups. [Toyota](https://www.toyota.com/recall/) and [Mopar](https://www.mopar.com/en-us/my-vehicle/recalls/search.html) also offer free official VIN checks.

### Nissan: positive open safety recalls

The [Nissan U.S. public checker](https://www.nissanusa.com/owners/recalls-vin.html) posts `vinNums`, a JSON VIN array, to the same-origin `recallinfo.json` URL declared by its recall component. The adapter discovers that URL from the current page, restricts its host/path, and never executes downloaded scripts. Every returned row must match the full VIN and Nissan brand. Only the verified `Recall Campaign` classification with a U.S. government recall identifier is accepted; unfamiliar classifications fail closed. Identical records are deduplicated; conflicting records fail.

The public sample returned R21A6 / 20V-315 as open. Coverage is U.S. safety recalls initiated after March 15, 1994. This is a **positive-record source**, not a completed-history feed. `completed_count` and all repair dates remain null. Empty arrays, HTTP 404, mismatched VINs, blocks and errors never become zero open recalls: the endpoint does not identify the VIN in an empty result. The coverage flags explicitly set `zero_open_verifiable:false` and `positive_records_only:true`. Unrecognized campaign types are not guessed to be safety recalls.

### Hyundai and Kia: official interactive verification

The [Hyundai U.S. checker](https://autoservice.hyundaiusa.com/campaignhome) requires reCAPTCHA before the VIN form submission. [MyHyundai guidance](https://owners.hyundaiusa.com/us/en/resources/general-information/recall-293-information-and-implementation) sends owners to that checker. The [Recall 239 microsite](https://autoservice.hyundaiusa.com/Campaign239/) has a separate unprotected campaign-specific VIN form, but its generic affected/remedy-available page does not establish completed repairs or an exhaustive VIN recall inventory. It is not used as an automated repair-status source.

The [Kia U.S. checker](https://owners.kia.com/us/en/recalls.html) exposes completed/incomplete labels and separate safety/service campaigns in its application, but its normal public VIN form requires reCAPTCHA. A direct guest request returned `Forbidden request`, not usable recall data. Those protected flows are not automated. Hyundai and Kia VINs now return `interactive_verification_required`, null counts and their own official checker links through REST, MCP, full reports and comparisons.

The [Hyundai Canada checker](https://www.hyundaicanada.com/en/owners-section/recalls) explicitly limits its results to vehicles retailed in Canada; [Kia Canada](https://www.kia.ca/en/owners/recalls) is a separate market lookup. They cannot establish U.S. coverage or justify zero for a U.S. VIN. No Canadian fallback is silently applied.

### Mopar: verified open records, narrower than completed repair history

The [official fleet lookup](https://wrecall.extra.chrysler.com/fleetreports/restricted/wrecall/RecallInq?task=display), linked by Mopar’s consumer site, permits an on-screen last-eight VIN query without an account, email submission or paid feed. The adapter reconstructs each full VIN from the first-nine and last-eight fields and only accepts exact matches. It never selects another vehicle with the same suffix. Successful positive responses are cached for 15 minutes; failures, empty results and VIN mismatches are retried.

This feed’s RC classification includes safety recalls **and other campaigns**. For example, the public sample vehicle’s K03 record is a customer-satisfaction notice in Mopar’s consumer checker. Therefore `open_record_count` counts the returned open records, `campaigns` retains their source classifications, and `open_count` (verified safety-recall count) remains null. `completed_count` also remains null: absence is not evidence of completed repairs. RR rapid-response records remain identified separately in `service_campaigns`. Placeholder dates such as 1900-01-01 become null. STOP DRIVE wording is retained.

The consumer checker can show completed repairs, but direct access is currently blocked from this environment. Those completed records are not imported into the automated app. The fleet lookup is an undocumented public interface, may change and does not establish universal make/year/market coverage.

### Toyota, Lexus and Scion: interactive verification required

The U.S. Toyota checker requests a reCAPTCHA token, and the Canadian checker requires interactive reCAPTCHA plus a CSRF token. Follow-up source review on October 24, 2026 also traced the [Toyota Owners recall page](https://www.toyota.com/owners/recalls/): its `getSafetyCampaigns` path obtains an enterprise reCAPTCHA token, including the guest flow. The [Lexus lookup](https://www.lexus.com/recall/) redirects to Toyota; the [public TIS page](https://techinfo.toyota.com/) and [Southeast Toyota Finance guidance](https://www.setf.com/help-center/checking-your-account-status-and-information/recall-information) direct users to the same consumer check. None established an additional free, unprotected U.S. VIN repair-status source.

No automated adapter is claimed for those protected flows. Toyota-family VINs return `interactive_verification_required`, null counts and an official Toyota verification link. The app does not automate CAPTCHA solving, reuse browser tokens, or substitute model-year campaign counts for VIN repair status. Canadian source: [official recall checker](https://www.toyota.ca/en/owners/recalls/).

Further review on October 24 traced [Toyota Hawaii](https://www.toyotahawaii.com/), whose recall link returns to Toyota's protected U.S. checker, and [Toyota Puerto Rico](https://www.toyotapr.com/); no independent free U.S. VIN repair-status feed was established. Toyota's [Spanish Owners page](https://www.toyota.com/espanol/owners/recalls/) directs users to the same consumer recall service. These additional channels did not resolve the automation gap.

The National Safety Council's [Check To Protect FAQ](https://www.checktoprotect.org/faqs/) describes a free CARFAX bulk-check account request for qualified organizations. That is a potential access application, not an established unauthenticated integration or permission to reuse its data in this product. No paid source, private account, CAPTCHA bypass or unsupported zero-count fallback was added.

## Owner facts on the car information sheet (checked 16 November 2026)

- **Tire pressures, tire sizes, load index.** FMVSS No. 110 (49 CFR 571.110 S4.3) puts the
  recommended cold pressures and original tire sizes on the Tire and Loading Information
  placard on the driver's side B-pillar. No federal dataset publishes them per VIN:
  vPIC's 145 variables include only wheel diameter, number of wheels and TPMS type; EPA
  and Canadian specification records have no tire fields. The sheet shows the wheel
  diameter and TPMS type when vPIC has them and leaves write-in fields for the placard.
  Above those fields it shows the placard values of a vehicle NHTSA tested (crash or compliance test), the
  closest match by model year and version, with the match stated in words (next section).
- **Fuse layout, oil, fluids, towing.** These are in the copyrighted owner's manual. (The
  usable fuel tank of NHTSA's test vehicle is shown, labelled: see `test_vehicle_specs` below.)
  The sheet links to the maker's official manual library and copies nothing.
  Verified with a plain request: Chevrolet, GMC, Buick and Cadillac `manuals-guides`,
  Toyota, Honda and Acura MyGarage, Nissan. Ford and Tesla refuse scripted requests;
  their pages are confirmed in search results only. No Subaru or Lexus library is listed.
- **Dimensions.** Transport Canada's model-variant specifications (via vPIC) are shown
  on the sheet, labelled as not VIN-specific. Some model names differ from vPIC's
  ("Bolt EV" is "BOLT 4DR HATCHBACK"), so an empty lookup is retried once with the first
  word of the model and the matched record names are printed.


## NHTSA test-vehicle tire placard (`tire_placard`, added 17 November 2026)

- **Source.** NHTSA's vehicle crash-test database (`nrd.api.nhtsa.dot.gov`, public, no key)
  lists every NCAP and FMVSS compliance test with its report PDFs on `nrd-static.nhtsa.dot.gov`.
  Data Sheet No. 1 of each report copies the test vehicle's Tire and Loading Information
  placard: recommended tire size front and rear, cold pressure front and rear in kPa, load
  index and speed symbol. The test vehicle's VIN is printed in the same report.
- **Second source: compliance test reports (`source: "nhtsa_compliance_test"`, added 17 November
  2026).** NHTSA's Office of Vehicle Safety Compliance publishes its FMVSS test reports on
  `static.nhtsa.gov/odi/ctr/`. The FMVSS 110, 138 and 537 reports copy the same placard block
  ("Tire Size: Front P235/55R18 ; Rear ... Tire Inflation Pressure: Front 220 kPa (32 psi)"), the
  certification label and the test vehicle's VIN. They pass the same validation, vPIC decode of the
  test vehicle's VIN (the decode's year and make must equal the report's), match kinds and wording.
  Such a row has no crash `test_no`; it is linked by its report number ("NHTSA compliance test
  report 639465"; newer numbers look like `110-2360530-TEST`). Scanned reports without a text layer
  are skipped, never OCRed. A variant seen in both sources is one row with the other report listed;
  where both sources cover the same model, year and size the compliance kPa equalled the crash
  report's in 71 of 74 overlaps (the 3 others: 240 against 241.3 kPa on a 2014 Jeep Patriot, a
  rounding; a 2011 Camry with no trim against a Base trim, 220 against 230 kPa).
  Hand check: 20 compliance reports, 0 wrong values.
- **Build (offline, not at request time).** The research pipeline downloads each report once,
  extracts the data sheet text, deletes the PDF, and keeps the matched lines as evidence. Each
  test vehicle's own VIN is decoded with vPIC `DecodeVINValuesBatch` to get the key: vPIC make,
  model and model year, the same names a decoded VIN gets on this site. Rows are rejected (and
  listed for review, never fixed by hand) when a size is malformed (a load-range letter such as
  `LT265/70R18E` is kept as printed), a pressure is missing or
  outside 180-420 kPa (620 for LT tires), the report disagrees with itself, the VIN fails its
  check digit, or the VIN's model year differs from the report's. Two reports for the same
  vehicle that agree give `confidence: high`; one report gives `normal`; two that disagree are
  excluded. Versions of one model year (4x2 and AWD, two trims) are compared only with themselves:
  two versions with different pressures are two rows, not a disagreement.
- **Complete set (17 November 2026).** 1,728 of 1,729 main-queue crash reports and all 538 extra NCAP side and
  pole reports processed (one main-queue test could not be fetched): 1,245 rows (1,133 from crash reports, 112
  from compliance reports) for 1,062 make/model/year/powertrain keys, 2,270 reports used, 331 rows rejected. Older data
  sheets (2005-2012) print the cold pressure in five more labelled forms ("221 kpa FRONT; 207 kpa REAR",
  "Cold Pressure (from tire placard - kPa)* 210 210", a wrapped label, "210 kPa 210 kPa", and a row whose
  table states kPa); 24 of their values were read by hand against the reports, 0 wrong. Left empty on
  purpose: Karco 2010-2011 sheets whose text layer separates the values from their labels (18 reports), and
  sheets with two cold pressures, "(2 persons)" and "(max)" (13). The extra side and pole reports are in:
  where NHTSA's test vehicles of one version and year carried different tire sizes (wheel options, or a
  misprint; 95 rows) those rows stay excluded. Keeping them when every report confirms its size was tested by
  the accuracy test below and dropped: of the 82 vehicles it added, 17 got the right size, 23 a set with it,
  41 a wrong one. Rejected after the accuracy test's hand check: a passenger-tire placard pressure of 290 kPa
  or more equal to the tire's own sidewall maximum on both axles, from a single report (a copied maximum: a
  2012 Elantra printed 300/300 kPa for both; two other 2012 Elantras print 220). psi is kPa / 6.894757 rounded; reports print kPa.
- **Shipped file.** `data-src/tire-placards.jsonl` (+ `.meta.json`) is the cleaned list.
  `python3 scripts/import-tire-placards.py` validates every row (sizes, ranges, psi/kPa
  agreement, NHTSA report URL, confidence rules) and atomically writes `data/tire-placards.db`;
  one bad row fails the whole import. `lib/tire-placards.mjs` reads it.
- **Matching: closest match, stated (owner rule 17 November 2026).** Same vPIC make and model,
  case- and space-insensitive and nothing else (`F150` does not match `F-150`). Every vehicle
  shown carries `match {kind, tested_model_year, vin_model_year, year_gap, differences,
  generation_check}` and the sheet says it in words. Kinds, closest first:
  1. `exact`: same model year, and no visible difference in trim, series, body, drive or
     electrification between the two vPIC decodes ("Same model year.");
  2. `nearest_model_year`, same version: another tested year within `MAX_YEAR_GAP` (2), the
     nearest one; on a tie (one year older, one newer) both are shown ("NHTSA tested the 2023
     model (yours is 2025). Tires and pressures can change between years.");
  3. `different_variant`: same model year, but a visible difference, listed;
  4. `nearest_model_year` that also differs in version;
  5. a nearest year whose Transport Canada wheelbase differs from the VIN year's (likely another
     generation) is not used at all (since the accuracy test below; before, it was ranked last). When
     only such years were tested the block says `reason: "other_generation_only"`.
  Only the closest kind present is returned; among equally close vehicles the matching rules below keep
  the ones that match the VIN, or all of them (the set) when nothing separates them. Values are never estimated, blended or averaged:
  each is one tested vehicle's printed value. The generation check (`generation_check`:
  `same_wheelbase`, `different_wheelbase`, `unknown`; `null` for the same year) compares the
  Transport Canada wheelbases (via vPIC `GetCanadianVehicleSpecifications`, the sheet's dimension
  source, cached one hour) of the two years; when the tested year has no record it uses the
  wheelbase NHTSA measured on the test vehicle (within 15 mm same, over 30 mm different). It only
  runs when no exact match exists. Transport Canada has no records yet for many 2026 models, so
  `unknown` is common for the newest years.
- **Reach (`MAX_YEAR_GAP` = 2), re-measured 17 November 2026 on the full main crash-report set**
  (1,248 tire rows, 2,094 capacity rows; `scripts/measure_stability.py`, `scripts/stability_wheelbase.py` in
  the research folder). Share of pairs of tested vehicles of one model with equal values, by year gap:

  | gap | bare tire size | cold pressures | usable fuel tank (within 1 L) |
  |---|---|---|---|
  | 1 year | 195 of 338 (58%); same trim 86 of 109 (79%) | 212 of 338 (63%); same trim 74 of 109 (68%) | 405 of 626 (65%); same trim 137 of 192 (71%) |
  | 2 years | 167 of 323 (52%); same trim 55 of 74 (74%) | 184 of 323 (57%); same trim 51 of 74 (69%) | 400 of 728 (55%); same trim 86 of 136 (63%) |
  | 3 years | 128 of 313 (41%) | 160 of 313 (51%) | 363 of 750 (48%) |

  Split by the generation check (wheelbase NHTSA measured on both vehicles, within 15 mm): same
  wheelbase 1-2 years apart agreed in 60-83% of pairs (tank 82-83%); different wheelbase in 8-40%. So a
  different-wheelbase year is a weak match, and a 2-year gap with an unknown generation agrees about half
  the time. Settled by the accuracy test below: reach stays 2 years, and a year with a different wheelbase
  is no longer used.
- **How a VIN is matched: the accuracy test (17 November 2026, owner request).** Every NHTSA test vehicle
  in the index (2,382 VINs) played a visitor: its own reports were held out, its own VIN's vPIC decode went
  through the site's lookup, and what the sheet would show was compared with that vehicle's own printed
  values (research folder `scripts/loo_eval.mjs`; Transport Canada wheelbases offline, so the generation
  check is rarer than on the site). Right = equal (tire size ignoring load index; pressure within 1 psi;
  tank within 1 L; weights within 1%); set = several values shown, the right one among them.

  | field (all vehicles) | before: right / set / wrong / nothing | after: right / set / wrong / nothing |
  |---|---|---|---|
  | tire size | 73.2 / 5.7 / 11.3 / 9.8% | 74.9 / 3.5 / 11.6 / 10.0% |
  | cold pressure, front | 80.7 / 3.1 / 6.5 / 9.8% | 82.0 / 1.5 / 6.6 / 10.0% |
  | fuel tank | 84.3 / 4.2 / 6.1 / 5.4% | 84.7 / 3.7 / 5.8 / 5.8% |
  | payload | 69.0 / - / 17.4 / 13.6% | 70.2 / - / 15.6 / 14.2% |
  | seating | 82.0 / - / 4.1 / 13.9% | 81.9 / - / 3.6 / 14.5% |
  | GVWR | 67.3 / - / 19.7 / 13.1% | 61.5 / - / 7.0 / 31.5% (another version's GVWR withheld) |

  Rules added (each keeps, among equally close tested vehicles, those that match the VIN, only when some
  do and some do not; gain = right-share lost when the rule alone is removed): tires: fewest visible
  differences (+0.3 size, +0.3 pressure), vPIC wheel diameter against the tested tire's rim (+0.3, +0.2),
  engine displacement and cylinders (+0.5, +0.3), cab type (+0.1, +0.2); capacities: cab (+0.4 payload,
  +0.3 GVWR, wrong -0.6 / -0.3), engine (wrong -0.2 payload), vPIC GVWR class against the tested vehicle's
  printed GVWR (+0.1 / +0.2, wrong -0.2 / -0.3); tank: fewest differences, GVWR class. Withheld: GVWR and
  GAWR of another version (it was right 39-40% of the time). Shown as a set: payload, seating and GVWR
  when equally close vehicles differ. Tried and dropped: the same features as version differences (they
  push a same-year vehicle below a nearest-year one: as many losses as gains); doors and plant (no gain);
  cab and engine for the tank (more wrong single values than right ones). What no rule can fix: in about
  9% (size) to 15% (GVWR) of cases no tested vehicle within reach had the vehicle's own value.

  Accuracy per kind of match after the rules (share of vehicles shown a value that got the right one; the
  sheet and the API's `accuracy` quote these):

  | match | tire size | pressures | fuel tank | payload | seating | GVWR |
  |---|---|---|---|---|---|---|
  | exact (1,136 vehicles shown tires) | 92% | 96% | 92% | 87% | 98% | 93% |
  | same year, other version (398) | 74% | 84% | 86% | 68% | 92% | withheld |
  | other year, same version (272) | 75% | 84% | 87% | 70% | 92% | 71% |
  | other year, other version (114) | 54% | 70% | 91% (22 vehicles) | 67% | 84% | withheld |

  Reach, settled by the same test: allowing years 2 apart (not just 1) adds 4.9% of vehicles at about 76%
  right (size; pressures 78%, tank 79%); years 3 apart would add 1.6% at about 13% (pressures 35%, tank
  about 33%), so `MAX_YEAR_GAP` stays 2. A year
  whose wheelbase differs is dropped: in NHTSA's repeat tests 1-2 years apart with a different measured
  wheelbase the tire size agreed in 31% of pairs, pressures 41%, tank 20%, payload 26%, GVWR 6% (same
  wheelbase: 70, 70, 83, 46, 60%). A hand check of 26 same-version errors found 0 extraction errors and 3
  report errors, now rejected (above); 5 were a test-harness error (sizes printed with a space before R,
  fixed before the numbers above); the other 18 are real differences between tested vehicles of one
  version (option wheels, load ranges, cab and drive). Missing values here are not tested or not indexed. Research notes: `LOO_PLAN.md`,
  `data/loo/handcheck_loo_verdicts.json`.
- **Powertrain guard.** vPIC gives gasoline and battery-electric versions one model name (the
  2025 Silverado EV test truck decodes as `Silverado`, with LT tires at 420 kPa). Each row keeps
  its test vehicle's class from vPIC `FuelTypePrimary` + `ElectrificationLevel`
  (`battery_electric`, `not_battery_electric`; hybrids and plug-ins are not battery-electric;
  `unknown` when vPIC gives neither, as for some 2013 decodes). A test vehicle whose known class
  differs from the decoded VIN's is never shown; if that leaves nothing, the block says
  `reason: "other_powertrain_only"`.

- **Meaning.** These are the values of the one vehicle NHTSA tested, not of the decoded VIN.
  The owner's own door placard governs; it can differ by year, trim and tire size. No match
  within reach means not tested or not indexed, never zero (`reason: "no_close_match"`).
  `available: false` means the index was not present.
- **Corrections.** "Doesn't match your door placard?" on the sheet (screen only) posts the
  reader's own tire sizes, cold pressures and fuel tank (gal or L) with an optional note to
  `POST /api/placard-corrections` (5 a minute per address, validated, length-capped). Stored in
  `vin.db` table `placard_corrections` with what the VIN decodes to, the test vehicles shown and
  their match kind, the VIN's first 11 characters only, and the time; no IP address, no account;
  kept up to one year. Never shown to other readers and never applied automatically; listed for
  review at `GET /api/admin/placard-corrections` (ADMIN_KEY). Privacy policy: "When you send a
  placard or fuel tank correction".
- **Refresh.** NHTSA adds tests every model year. Re-running the research pipeline and the
  importer picks them up; nothing is fetched by the site itself.

## NHTSA test-vehicle capacities and weights (`test_vehicle_specs`, added 17 November 2026)

- **Source.** The crash reports' Data Sheet No. 1: certification label GVWR and GAWR front/rear
  (unit as printed; a value printed without a unit is kept only when it is plausible as kg against
  the measured axle weights), the seating table, vehicle capacity weight (payload), usable
  capacity of the standard (and optional) fuel tank, and the weight as delivered per axle (curb
  weight with fluids, before dummies and ballast). Built by the research pipeline's Stage A
  extractor; each field records its extraction method, and a field failing a plausibility rule
  (GVWR against the measured weight and twice it, GAWR sum against GVWR, kg/lb agreement, ranges,
  no tank on a battery-electric vehicle; since 17 November also a tank under 28 L on a car that is not a
  plug-in, or outside 0.015-0.09 L per kg of measured weight: two reports printed gallons under a litre
  heading) is left out, never corrected. Hand check: 30 reports
  stratified by lab, test type and year, 10 more out of sample for the shown fields, and 20
  server-extracted reports (3 wrong values of 779 on the first pass, all fixed and re-checked
  across every report).
- **Compliance reports.** The FMVSS 110/138/537 reports add GVWR and GAWR (kg, checked against
  the printed lb within 2%), the occupant and cargo weight from the placard (= vehicle capacity
  weight) and the seating total (no per-row split; shown as the total alone). One test vehicle
  (one VIN) often has several compliance reports: they form one row, `field_reports` names the
  report(s) that printed each value, every report is linked, and a value two reports print
  differently is left out (2 cases). They list no fuel tank.
- **Stopping distance (full report only, not on the one-page sheet).** The FMVSS 135 brake
  compliance report prints the cold-effectiveness stop from 100 km/h (pedal force 65-500 N,
  limit 70 m), lightly loaded and at GVWR: `test_vehicle_specs.stopping_distance` gives the closest
  tested vehicle's values in metres as printed and feet converted, with its match and report.
  The report page shows it under the safety ratings ("Brake test of an NHTSA test vehicle (FMVSS
  No. 135)"), labelled as one vehicle's compliance test, not a rating and not this VIN. Every one
  of the 44 lightly loaded and 38 GVWR values was read by hand against its printed row. The
  measured maximum speed is kept in the API (`maximum_speed_kmh`), not displayed.
- **Shipped file.** `data-src/test-vehicle-specs.jsonl` (+ `.meta.json`), one row per crash
  report or per compliance-tested vehicle (`source` says which).
  `npm run import:test-vehicles` (= `python3 scripts/import-tire-placards.py`) rebuilds
  `data/tire-placards.db` with both tables in one atomic step; one bad row fails the import.
- **Matching.** The closest-match rule above, preferring a tested vehicle with the same
  electrification (none, hybrid, mild hybrid, plug-in hybrid, battery-electric) as the VIN. The
  sheet shows one vehicle (the best match; with more of the capacity fields first) in "Size and
  weight": fuel tank, payload, seating capacity, GVWR, GAWR, and curb weight as delivered with its
  front/rear split, in lb and kg, linked to the report. When equally close tested vehicles print
  different payload, seating or GVWR values and no matching rule separates them, every value is shown
  with its vehicle (`values_differ`; "926 lb or 992 lb ... NHTSA's equally close test vehicles differ").
  GVWR and GAWR come only from a tested vehicle of the same version: from another version they are
  withheld (`withheld`, with the reason), because another version's GVWR was right in only about 4 of
  10 cases in the accuracy test.
- **Fuel tank.** From the closest tested vehicle that lists a tank (it can be another report than
  the capacities, for example when the closest vehicle is a compliance test; the sheet then links
  the tank's own report). Always one tested vehicle's printed usable standard tank, litres converted to US
  gallons with the litres kept (`gallons = L / 3.785411784`), never averaged. Not an exact match:
  "Fuel tank (best guess)" with "From NHTSA's 2023 test vehicle (yours is 2025); tank size can
  differ by year, trim and options." When the tested vehicle's electrification differs from the
  VIN's (or the VIN's is unknown) no tank is shown and the sheet says why. Two equally close tested
  vehicles with different tanks are both shown; an optional tank listed by the report is named;
  when this model's tested vehicles list more than one tank size, they are listed with their years.
- **Not shown.** Crash results (injury measures, crush, post-test observations) are extracted into
  a research dataset only; NCAP star ratings are not in these reports and are not derived.

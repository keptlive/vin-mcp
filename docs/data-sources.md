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
  placard on the driver's side B-pillar. No federal dataset publishes them per vehicle:
  vPIC's 145 variables include only wheel diameter, number of wheels and TPMS type; EPA
  and Canadian specification records have no tire fields. The sheet shows the wheel
  diameter and TPMS type when vPIC has them and leaves write-in fields for the placard.
- **Fuse layout, oil, fluids, tank size, towing.** These are in the copyrighted owner's
  manual. The sheet links to the maker's official manual library and copies nothing.
  Verified with a plain request: Chevrolet, GMC, Buick and Cadillac `manuals-guides`,
  Toyota, Honda and Acura MyGarage, Nissan. Ford and Tesla refuse scripted requests;
  their pages are confirmed in search results only. No Subaru or Lexus library is listed.
- **Dimensions.** Transport Canada's model-variant specifications (via vPIC) are shown
  on the sheet, labelled as not VIN-specific. Some model names differ from vPIC's
  ("Bolt EV" is "BOLT 4DR HATCHBACK"), so an empty lookup is retried once with the first
  word of the model and the matched record names are printed.

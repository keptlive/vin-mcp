# Data sources and coverage - v1.4.0

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
in this release. Tesla VIN status and Mopar open records are integrated; Toyota uses an official interactive verification link. Cost results use explicit assumptions;
resale, maintenance and insurance values are not predictions.

Source availability, timestamps, limits and exports accompany research results. The capability
register and printable sheets describe the current implementation without implying equivalent
coverage or service performance to another provider.

## VIN-specific recall repair status

Tesla Service's [official VIN recall search](https://service.tesla.com/en-US/vin-recall-search) exposes manufacturer-reported statuses including “Recall Completed” and “Recall Incomplete.” The adapter uses the same public Tesla endpoint, requires no account or paid feed, and provides checked timestamps, original status text, campaign details and manufacturer bulletin links. Successful responses are cached for up to 15 minutes; failures are not cached. This endpoint is not a documented third-party API and may change.

`GET /api/vin/{vin}/recall-status`, `VinClient.recallStatus(vin)` and MCP `vin_recall_status` expose this data. VIN reports and printable comparisons include the summary. Tesla supplies open/completed recall states. Mopar supplies VIN-matched open recall/campaign records, with the limitations below. Toyota, Lexus and Scion require interactive verification; other manufacturers return unknown with an official lookup link. Unknown response statuses never count as zero open recalls; recall dates never become repair completion dates. Results are not a complete service history or a guarantee of safety.

NHTSA’s [interactive VIN lookup](https://www.nhtsa.gov/recalls) identifies unrepaired recalls, but explicitly excludes completed repairs and has age, manufacturer and timing limitations. Its [API use policy](https://api.nhtsa.gov/) does not support using its consumer VIN API for bulk third-party lookups. [Toyota](https://www.toyota.com/recall/) and [Mopar](https://www.mopar.com/en-us/my-vehicle/recalls/search.html) also offer free official VIN checks.

### Mopar: verified open records, narrower than completed repair history

The [official fleet lookup](https://wrecall.extra.chrysler.com/fleetreports/restricted/wrecall/RecallInq?task=display), linked by Mopar’s consumer site, permits an on-screen last-eight VIN query without an account, email submission or paid feed. The adapter reconstructs each full VIN from the first-nine and last-eight fields and only accepts exact matches. It never selects another vehicle with the same suffix. Successful positive responses are cached for 15 minutes; failures, empty results and VIN mismatches are retried.

This feed’s RC classification includes safety recalls **and other campaigns**. For example, the public sample vehicle’s K03 record is a customer-satisfaction notice in Mopar’s consumer checker. Therefore `open_record_count` counts the returned open records, `campaigns` retains their source classifications, and `open_count` (verified safety-recall count) remains null. `completed_count` also remains null: absence is not evidence of completed repairs. RR rapid-response records remain identified separately in `service_campaigns`. Placeholder dates such as 1900-01-01 become null. STOP DRIVE wording is retained.

The consumer checker can show completed repairs, but direct access is currently blocked from this environment. Those completed records are not imported into the automated app. The fleet lookup is an undocumented public interface, may change and does not establish universal make/year/market coverage.

### Toyota, Lexus and Scion: interactive verification required

The U.S. Toyota checker requests a reCAPTCHA token, and the Canadian checker requires interactive reCAPTCHA plus a CSRF token. No automated adapter is claimed for those protected flows. Toyota-family VINs return `interactive_verification_required`, null counts and an official Toyota verification link. The app does not automate CAPTCHA solving, reuse browser tokens, or substitute model-year campaign counts for VIN repair status. Canadian source: [official recall checker](https://www.toyota.ca/en/owners/recalls/).

# Data sources and coverage - v1.3.0

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
inventory feed, universal factory build-sheet source or VIN-specific unrepaired-recall feed
in this release. Official recall lookup remains linked. Cost results use explicit assumptions;
resale, maintenance and insurance values are not predictions.

Source availability, timestamps, limits and exports accompany research results. The capability
register and printable sheets describe the current implementation without implying equivalent
coverage or service performance to another provider.

## VIN-specific recall repair status

Tesla Service's [official VIN recall search](https://service.tesla.com/en-US/vin-recall-search) exposes manufacturer-reported statuses including “Recall Completed” and “Recall Incomplete.” The adapter uses the same public Tesla endpoint, requires no account or paid feed, and provides checked timestamps, original status text, campaign details and manufacturer bulletin links. Successful responses are cached for up to 15 minutes; failures are not cached. This endpoint is not a documented third-party API and may change.

`GET /api/vin/{vin}/recall-status`, `VinClient.recallStatus(vin)` and MCP `vin_recall_status` expose this data. VIN reports and printable comparisons include the summary. Current automated coverage is Tesla only. Other manufacturers return unknown, with an official lookup link. Unknown response statuses never count as zero open recalls; recall dates never become repair completion dates. Results are not a complete service history or a guarantee of safety.

NHTSA’s [interactive VIN lookup](https://www.nhtsa.gov/recalls) identifies unrepaired recalls, but explicitly excludes completed repairs and has age, manufacturer and timing limitations. Its [API use policy](https://api.nhtsa.gov/) does not support using its consumer VIN API for bulk third-party lookups. [Toyota](https://www.toyota.com/recall/) and [Mopar](https://www.mopar.com/en-us/my-vehicle/recalls/search.html) also offer free official VIN checks; automated adapters are not yet verified.

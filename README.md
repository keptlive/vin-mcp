# VIN MCP

**Free VIN decoder for humans and AI. No API keys or accounts required for public vehicle lookups. Rate limits apply.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io)
[![Smithery](https://smithery.ai/badge/@keptlive/vin-mcp)](https://smithery.ai/server/@keptlive/vin-mcp)

[mcp.vin](https://mcp.vin) -- Try it now

---

## What It Does

Enter a 17-character VIN and get a comprehensive vehicle report by aggregating six free data sources into a single response:

| Source | Data Provided |
|--------|--------------|
| **NHTSA vPIC** | Make, model, year, trim, body class, engine specs, transmission, drive type, weight, plant info, 140+ decoded fields |
| **NHTSA Recalls** | Model-year recall campaigns with component, summary, consequence, and remedy; not VIN repair status |
| **NHTSA Complaints** | Consumer complaints with crash, fire, injury, and death statistics |
| **NHTSA Safety Ratings** | NCAP star ratings for overall, frontal, side, and rollover crash tests |
| **EPA Fuel Economy** | City/highway/combined MPG, annual fuel cost, CO2 emissions, EV range and charge time |
| **NHTSA Vehicle Crash Test Database** | Photos of a vehicle NHTSA tested (same make, model, body style and generation): before the test and after NHTSA's crash tests. Never the decoded vehicle and never stock photos; mcp.vin serves resized copies itself |

Additionally, VIN validation (checksum, WMI country/manufacturer decode, model year) is computed locally with zero API calls.

---

## Quick Start -- Connect via MCP

### Remote HTTP (nothing to install, no API key)

Use the hosted MCP endpoint:

```
https://mcp.vin/mcp
```

Add to your MCP client config:

```json
{
  "mcpServers": {
    "vin-mcp": {
      "url": "https://mcp.vin/mcp"
    }
  }
}
```

---

### Smithery (one command)

```bash
npx -y @smithery/cli install @keptlive/vin-mcp --client claude
```

### Claude Code (stdio)

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "vin-mcp": {
      "command": "npx",
      "args": ["-y", "vin-mcp"]
    }
  }
}
```

Or if you have the repo cloned locally:

```json
{
  "mcpServers": {
    "vin-mcp": {
      "command": "node",
      "args": ["/path/to/vin-mcp/server.mjs"]
    }
  }
}
```


## MCP Tools

The 22 tools are organized into three groups. The live directory at [`/api/tools`](https://mcp.vin/api/tools) and MCP `tools/list` come from the same registry. See [service organization](docs/architecture.md) for extension and testing guidance.

| Group | Tools |
| --- | --- |
| Vehicle reports | `decode_vin`, `validate_vin`, `lookup_recalls`, `batch_decode` |
| Research and analysis | `explore_capabilities`, `vin_recall_status`, `vehicle_catalog`, `epa_vehicle`, `vehicle_emissions`, `fuel_price_assumptions`, `owner_reported_mpg`, `defect_investigations`, `auto_loan_benchmarks`, `vehicle_dimensions`, `manufacturer_communications`, `compare_vehicles`, `ownership_scenario` |
| Saved vehicles and preferences | `list_saved_vins`, `save_vin`, `remove_saved_vin`, `get_output_preferences`, `update_output_preferences` |

Account tools require the user's website login token. Public lookup tools require no API key. Source coverage and unknown values are part of the returned data.

| Tool | Description | Input |
|------|-------------|-------|
| `decode_vin` | Full VIN decode with specs, recalls, complaints, safety ratings, fuel economy, and NHTSA test-vehicle photos | `{ vin: string }` |
| `validate_vin` | Quick local validation -- checksum, WMI country/manufacturer, model year. No external API calls | `{ vin: string }` |
| `lookup_recalls` | Look up recalls by VIN or by make/model/year | `{ vin?: string, make?: string, model?: string, year?: number }` |
| `batch_decode` | Decode up to 50 VINs in a single request via NHTSA batch API | `{ vins: string[] }` |

---

## REST API

All endpoints are available at `https://mcp.vin` or on your self-hosted instance.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/tools` | Grouped MCP tool directory |
| `GET` | `/api/vin/:vin` | Full decode -- all 6 sources aggregated |
| `GET` | `/api/vin/:vin/validate` | Quick checksum and format validation |
| `GET` | `/api/vin/:vin/recalls` | Recall data only |
| `GET` | `/api/vin/:vin/complaints` | Consumer complaints only |
| `GET` | `/api/vin/:vin/safety` | NCAP safety ratings only |
| `GET` | `/api/vin/:vin/fuel` | EPA fuel economy only |
| `GET` | `/api/vin/:vin/photo` | Redirects (302) to the first photo of NHTSA's test car, before the test; 404 when no tested vehicle matches |
| `POST` | `/api/batch` | Batch decode (body: `{ "vins": ["VIN1", "VIN2", ...] }`, max 50) |

Rate limits: 30 requests/minute per IP for most endpoints, 60/minute for validation and photos, 5/minute for batch.

**Example:**

```bash
curl https://mcp.vin/api/vin/1HGCM82633A004352
```

Direct VIN URLs also work -- visit `https://mcp.vin/1HGCM82633A004352` to see the web report.

### Photos (`photos` in a report)

Photos come only from NHTSA's vehicle crash-test database: the test lab's own photos of a vehicle NHTSA bought and
tested. They are never the decoded vehicle and there are no stock photos. The vehicle is the closest NHTSA test vehicle
(same matching as `test_vehicle_specs`: exact model year first, then the nearest year of the same generation, or the
same year in another trim), and never one with a different body style, cab or door count. `photos` is `null` when
nothing matches. Otherwise:

```json
"photos": {
  "scope": "nhtsa_test_vehicle", "vin_specific": false, "note": "Photos of a vehicle NHTSA bought and tested, ...",
  "items": [
    { "url": "https://mcp.vin/nhtsa-photos/14086/v14086P014-960.webp", "width": 960, "height": 640,
      "thumbnail_url": "https://mcp.vin/nhtsa-photos/14086/v14086P014-320.webp", "thumbnail_width": 320, "thumbnail_height": 213,
      "phase": "pre_test", "view": "front_34_right", "label": "Before the test: right front three-quarter view",
      "tested_as": "2022 Nissan Pathfinder four door SUV", "model_year": 2022, "test_no": 14086, "test_kind": "frontal",
      "test_label": "NHTSA frontal crash test 14086", "test_description": "The car was driven into a rigid barrier at 56 km/h (35 mph).",
      "test_type": "NEW CAR ASSESSMENT TEST",
      "match": { "kind": "exact", "tested_model_year": 2022, "vin_model_year": 2022, "year_gap": 0, "differences": [], "generation_check": null },
      "nhtsa_test_url": "https://nrd-static.nhtsa.dot.gov/reports/vehdb/v10000/v14000/v14086R001.pdf",
      "nhtsa_photo_url": "https://nrd-static.nhtsa.dot.gov/photos/vehdb/v10000/v14000/v14086P014.JPG",
      "original_file_name": "No. 014 Pre-Test Right Front 3-4 View.JPG" },
    { "url": "https://mcp.vin/nhtsa-photos/14086/v14086P015-960.webp", "phase": "post_test", "view": "front_34_right",
      "label": "After NHTSA's frontal crash test: right front three-quarter view", "...": "same fields" }
  ],
  "source": { "provider": "NHTSA vehicle crash-test database: test-lab photos of the tested vehicles (nrd-static.nhtsa.dot.gov), resized and served by mcp.vin",
              "indexed_at": "...", "dataset_generated_at": "..." }
}
```

`items` lists up to three views of the test car before the test (`phase` `pre_test`), then up to three crash views,
one per NHTSA test of that model year (`post_test`: the car after that test), each with its own
test car (`tested_as`, `test_no`) and match. `nhtsa_test_url` is NHTSA's report for that test. Images are WebP, fit in
960 x 720 (thumbnails 320 x 240), with no metadata. Self-hosted servers show photos only when `data/nhtsa-photos/` and
the photo index are deployed (see `scripts/build-nhtsa-photos.py`); without them `photos` is `null`.

---

## Self-Hosting

```bash
git clone https://github.com/keptlive/vin-mcp.git
cd vin-mcp
npm install
node server.mjs --http --port 3200
```

The server starts in HTTP mode with:
- Web frontend at `http://localhost:3200`
- REST API at `http://localhost:3200/api/vin/{vin}`
- MCP endpoint at `http://localhost:3200/mcp`

For stdio mode (Claude Code integration without a web server):

```bash
node server.mjs
```

---

## How VINs Work

A VIN (Vehicle Identification Number) is a 17-character code assigned to every vehicle manufactured since 1981. Each position encodes specific information:

```
1 H G C M 8 2 6 3 3 A 0 0 4 3 5 2
|_____| |___| | | | |_| |_________|
  WMI    VDS  | | | |yr  Sequential
              | | | plant
              | | check digit
              | vehicle attributes
              manufacturer ID
```

- **Positions 1-3 (WMI):** World Manufacturer Identifier -- country and manufacturer
- **Positions 4-8 (VDS):** Vehicle Descriptor Section -- model, body, engine, transmission
- **Position 9:** Check digit -- validates the VIN using a weighted algorithm
- **Position 10:** Model year code (A-Y, 1-9 on a 30-year cycle)
- **Position 11:** Assembly plant
- **Positions 12-17:** Sequential production number

The letters I, O, and Q are never used in VINs to avoid confusion with 1, 0, and 9.

---

## Tech Stack

- **Runtime:** Node.js 22+
- **Server:** Express 5
- **MCP SDK:** `@modelcontextprotocol/sdk` with stdio and Streamable HTTP transports
- **Frontend:** Vanilla HTML, CSS, and JavaScript
- **Caching:** In-memory LRU with TTL (1h for decodes, 6h for recalls, 24h for ratings and fuel data)
- **External dependencies:** Zero API keys required -- all data sources are free public APIs

---

## Unified vehicle workspace (v1.7.0)

The main workspace combines VIN reports and saved vehicles with EPA configurations/emissions, Canadian dimensions,
manufacturer communications, defect investigations, owner-reported MPG, dated Federal Reserve
rate benchmarks, 2-4 VIN comparisons, ownership scenarios and developer tools. Existing `/research/`
links continue into the matching section, including their search parameters. Accounts,
preferences, educational pages and OAuth remain available. Public data coverage varies.

Research is available through REST, 22 MCP tools, the JavaScript client at `public/client.mjs`
and the source CLI `cli.mjs`. The hosted service is https://mcp.vin; set `VIN_BASE_URL` for CLI use.
This release does not publish an updated npm package.

See [data sources and scope](docs/data-sources.md) and the machine-readable guide at
`public/research/api.json`. Printable capability-comparison and methodology sheets are in
`public/research/sheets/`. These describe source scope; full auto.dev data parity is incomplete.

### Run and verify

Use Node.js 22 or later, run `npm ci`, then `npm start`. Run `npm test` and
`node --test test/transport.test.mjs` for the application and actual MCP transport checks.
The Python importer tests use only the standard library:
`python3 tests/investigations_test.py`, `python3 tests/communications_storage_test.py`,
`python3 tests/recall_labels_test.py` and `python3 tests/nhtsa_local_test.py`.

Install public indexes with `python3 scripts/import-communications.py`,
`python3 scripts/import-investigations.py` and `python3 scripts/import-recall-labels.py`.
Use `--refresh` for a new official snapshot. The recall label index (`data/recall-labels.db`,
about 10 MB, built in seconds from NHTSA's two recall flat files) lets reports find campaigns
NHTSA files under another model name; without it, reports say the related-name list is partial.
NHTSA updates the flat files daily; `scripts/nhtsa-build.sh odi` rebuilds the index when they change.
Recalls, complaints and 5-Star Safety Ratings are answered from local copies of NHTSA's public data when they are
installed (`data/nhtsa-recalls.db`, about 80 MB; `data/nhtsa-complaints.db`, about 1.7 GB; `data/nhtsa-ratings.db`),
with NHTSA's live API as the fallback; each answer's `data_source` says which. Every NHTSA-derived file (these three,
the recall label, investigation and bulletin indexes and `vpic.db`) is rebuilt on the build server when NHTSA changes
its source (`scripts/nhtsa-build.sh`), gated, and pulled and swapped in by the web server (`scripts/nhtsa-install.py`),
with a freshness check that mails the owner (`scripts/nhtsa_datasets.py check`); `deploy/systemd/` holds the timers,
not installed by default. See [local NHTSA data](docs/nhtsa-local-data.md).
The standard bulletin index needs about 3.4 GB plus archives. To reduce storage without
changing the API, run `python3 scripts/compact-communications.py data/communications.db data/communications-compact.db`.
The compact target is a separate file, verified row for row; deploy it under the name
`data/communications.db`. Never overwrite account data. No automatic source refresh is configured.

With the server and indexes running, `node scripts/research-smoke.mjs` verifies real sources,
pagination and MCP; set `VIN_BASE_URL` to select a server.

### Agent analysis

Agents can query the structured results, combine them with explicit assumptions, and use
charting or document tools to create figures and analysis. Custom chart rendering happens
in the agent's tools. The API supplies comparisons, scenario calculations, provenance and JSON.
Configuration/model-year data and VIN-specific facts retain their distinct scopes.

VIN recall repairs: mcp.vin does not check them and does not ask any manufacturer about a VIN. Every report's `recall_status` links to the manufacturer's own recall page (the VIN filled in where the page takes it from the link: Ford, Tesla, Honda, Acura, Subaru, Hyundai) and to NHTSA's VIN recall page, with `open_count` and `completed_count` null (unknown, never zero); `vin_recall_status`, `GET /api/vin/{vin}/recall-status` and `VinClient.recallStatus(vin)` return the same block. Makes without a listed page get NHTSA's link only. `?recall_wait` (REST) and `recall_wait` (MCP) are ignored. NHTSA's complaint list (5-17 s for a common model) can arrive after the report: `complaints.pending: true` with `status_url` `/api/vin/{vin}/complaints`. See the [source and coverage notes](docs/data-sources.md#vin-recall-repairs-links-only-since-18-november-2026).

mcp.vin is an independent free service, not affiliated with or endorsed by NHTSA, EPA, the U.S. Department of Energy, Transport Canada, the Federal Reserve or any vehicle manufacturer. Transport Canada dimensions: contains information licensed under the [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada).

Deployment caching: HTML must revalidate, API responses must not be stored by shared caches, and changed JavaScript/PDF links use a content-hash query version generated by `node scripts/version-assets.mjs`. API clients also bypass stored browser responses. Preserve these policies in any reverse proxy so updated recall records are rendered by the matching client code.

---

## License

MIT

---

Built for [mcp.vin](https://mcp.vin)

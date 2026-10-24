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
| **NHTSA Recalls** | Open recalls with campaign number, component, summary, consequence, and remedy |
| **NHTSA Complaints** | Consumer complaints with crash, fire, injury, and death statistics |
| **NHTSA Safety Ratings** | NCAP star ratings for overall, frontal, side, and rollover crash tests |
| **EPA Fuel Economy** | City/highway/combined MPG, annual fuel cost, CO2 emissions, EV range and charge time |
| **IMAGIN.studio** | Stock vehicle photos from multiple angles |

Additionally, VIN validation (checksum, WMI country/manufacturer decode, model year) is computed locally with zero API calls.

---

## Quick Start -- Connect via MCP

### Smithery (one command)

```bash
npx -y @smithery/cli install @keptlive/vin-mcp --client claude
```

### Claude Code (stdio)

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "vin": {
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
    "vin": {
      "command": "node",
      "args": ["/path/to/vin-mcp/server.mjs"]
    }
  }
}
```

### Claude Desktop / claude.ai (HTTP)

Use the hosted MCP endpoint:

```
https://mcp.vin/mcp
```

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "vin": {
      "url": "https://mcp.vin/mcp"
    }
  }
}
```

---

## MCP Tools

| Tool | Description | Input |
|------|-------------|-------|
| `decode_vin` | Full VIN decode with specs, recalls, complaints, safety ratings, fuel economy, and photos | `{ vin: string }` |
| `validate_vin` | Quick local validation -- checksum, WMI country/manufacturer, model year. No external API calls | `{ vin: string }` |
| `lookup_recalls` | Look up recalls by VIN or by make/model/year | `{ vin?: string, make?: string, model?: string, year?: number }` |
| `batch_decode` | Decode up to 50 VINs in a single request via NHTSA batch API | `{ vins: string[] }` |

---

## REST API

All endpoints are available at `https://mcp.vin` or on your self-hosted instance.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/vin/:vin` | Full decode -- all 6 sources aggregated |
| `GET` | `/api/vin/:vin/validate` | Quick checksum and format validation |
| `GET` | `/api/vin/:vin/recalls` | Recall data only |
| `GET` | `/api/vin/:vin/complaints` | Consumer complaints only |
| `GET` | `/api/vin/:vin/safety` | NCAP safety ratings only |
| `GET` | `/api/vin/:vin/fuel` | EPA fuel economy only |
| `GET` | `/api/vin/:vin/photo` | Redirects to vehicle photo URL |
| `POST` | `/api/batch` | Batch decode (body: `{ "vins": ["VIN1", "VIN2", ...] }`, max 50) |

Rate limits: 30 requests/minute per IP for most endpoints, 60/minute for validation and photos, 5/minute for batch.

**Example:**

```bash
curl https://mcp.vin/api/vin/1HGCM82633A004352
```

Direct VIN URLs also work -- visit `https://mcp.vin/1HGCM82633A004352` to see the web report.

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

## License

MIT

---

Built for [mcp.vin](https://mcp.vin)


## Public-data research workspace (v1.5.0)

The additive `/research/` workspace includes EPA configurations/emissions, Canadian dimensions,
manufacturer communications, defect investigations, owner-reported MPG, dated Federal Reserve
rate benchmarks, 2-4 VIN comparisons, ownership scenarios and developer tools. Existing decoder,
accounts, saved vehicles, preferences and OAuth remain available. Public data coverage varies.

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
`python3 tests/investigations_test.py` and `python3 tests/communications_storage_test.py`.

Install public indexes with `python3 scripts/import-communications.py` and
`python3 scripts/import-investigations.py`. Use `--refresh` for a new official snapshot.
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

VIN recall repair status: Tesla and Ford open/completed statuses, GM open/completed or administratively closed records, Honda active safety recalls, and Mopar VIN-matched open recall/campaign records are included in reports and comparisons, with `vin_recall_status`, `GET /api/vin/{vin}/recall-status` and `VinClient.recallStatus(vin)`. Mopar safety-recall count and completed history remain unknown because its feed mixes campaign types. GM repair dates are shown only when explicitly supplied; administrative closing dates remain separate. Ford customer-satisfaction and GM non-recall programs stay separate from recall counts. Honda covers active safety recalls from the past 15 calendar years and does not supply completed history. Toyota/Lexus/Scion require interactive official verification. Other makes remain unknown. See the [source and coverage notes](docs/data-sources.md#vin-specific-recall-repair-status).

Deployment caching: HTML must revalidate, API responses must not be stored by shared caches, and changed JavaScript/PDF links use a content-hash query version generated by `node scripts/version-assets.mjs`. API clients also bypass stored browser responses. Preserve these policies in any reverse proxy so updated recall records are rendered by the matching client code.

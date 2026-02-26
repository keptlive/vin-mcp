# VIN MCP

**Free VIN decoder for humans and AI. No API keys. No accounts. No limits.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io)

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

- **Runtime:** Node.js 18+
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

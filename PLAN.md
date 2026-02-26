# VIN Decoder MCP Server — Planning Doc

**Domain:** mcp.vin
**Stack:** Node.js + Express 5, vanilla JS frontend
**Pattern:** Same as qr-mcp (dual transport: stdio for Claude Code, HTTP for claude.ai + web frontend)

---

## Vision

One VIN in → a beautiful, comprehensive vehicle report out. Aggregates every free data source available into a single page that's more useful than any individual source. Also works as an MCP tool so Claude can decode VINs directly.

---

## Data Sources (All Free, No API Keys)

### 1. NHTSA vPIC — VIN Decode (Primary)
- **URL:** `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/{vin}?format=json`
- **Data:** 140+ fields — make, model, year, trim, engine (cylinders, displacement, HP, fuel type), transmission, drive type, body class, doors, weight (GVWR), plant city/country, EV info, TPMS, air bags, seat belts, ESC, ABS, and more
- **Batch:** `POST /vehicles/DecodeVINValuesBatch/` — up to 50 VINs
- **Rate limit:** None documented, but be respectful (cache results)
- **Latency:** ~200-500ms

### 2. NHTSA Recalls
- **URL:** `https://api.nhtsa.gov/recalls/recallsByVehicle?make={}&model={}&modelYear={}`
- **Data:** Campaign number, component, summary, consequence, remedy, report date
- **Also:** Count of recalls = useful "recall risk" metric
- **Note:** Uses make/model/year from VIN decode, not VIN directly

### 3. NHTSA Complaints
- **URL:** `https://api.nhtsa.gov/complaints/complaintsByVehicle?make={}&model={}&modelYear={}`
- **Data:** Component, description, crash (bool), fire (bool), injuries, deaths, date
- **Value:** "X complaints filed, Y involved crashes" is powerful safety info

### 4. NHTSA Safety Ratings
- **URL:** `https://api.nhtsa.gov/SafetyRatings/modelyear/{yr}/make/{mk}/model/{md}`
- **Data:** Overall rating (1-5 stars), frontal crash, side crash, rollover rating, side pole rating
- **Note:** Not all vehicles have ratings (trucks, older cars may not)

### 5. EPA Fuel Economy
- **URL:** `https://fueleconomy.gov/ws/rest/vehicle/menu/options?year={}&make={}&model={}`
- **Then:** `https://fueleconomy.gov/ws/rest/vehicle/{id}` for full details
- **Data:** MPG city/highway/combined, annual fuel cost, CO2 emissions, fuel type, range (EVs), charge time (EVs)
- **Note:** Two-step: first get vehicle options/IDs, then fetch details

### 6. IMAGIN.studio — Vehicle Photos
- **URL:** `https://cdn.imagin.studio/getImage?customer=demo&make={}&modelFamily={}&modelYear={}`
- **Data:** Stock photo of the vehicle (multiple angles available)
- **Free tier:** 400px width, no API key needed with `customer=demo`
- **Angles:** Add `angle=01` through `angle=29` for different views

### 7. Local Computation (No API)
- **VIN checksum validation** — digit 9 weighted algorithm
- **WMI decode** — first 3 chars → country + manufacturer
- **Year character decode** — position 10 → model year
- **Sequential number** — positions 12-17
- **Vehicle age** — calculated from decoded year

---

## Architecture

```
┌──────────────────────────────────────┐
│           vin-mcp/server.mjs         │
│                                      │
│  ┌──────────┐   ┌────────────────┐   │
│  │ MCP Tools│   │ REST API       │   │
│  │ (stdio + │   │ /api/vin/:vin  │   │
│  │  HTTP)   │   │ /api/batch     │   │
│  └────┬─────┘   └──────┬─────────┘   │
│       │                │             │
│       └──────┬─────────┘             │
│              │                       │
│  ┌───────────▼───────────────────┐   │
│  │      VIN Service Layer        │   │
│  │                               │   │
│  │  decode()    → NHTSA vPIC     │   │
│  │  recalls()   → NHTSA Recalls  │   │
│  │  complaints()→ NHTSA Compl.   │   │
│  │  safety()    → NHTSA Ratings  │   │
│  │  fuel()      → EPA FuelEcon   │   │
│  │  photo()     → IMAGIN.studio  │   │
│  │  validate()  → Local checksum │   │
│  │  report()    → All combined   │   │
│  │                               │   │
│  │  LRU Cache (1hr TTL)          │   │
│  └───────────────────────────────┘   │
│                                      │
│  ┌───────────────────────────────┐   │
│  │  express.static('public/')    │   │
│  │  index.html + style.css + app │   │
│  └───────────────────────────────┘   │
└──────────────────────────────────────┘
```

---

## MCP Tools

### `decode_vin`
Full VIN decode with all available data aggregated.
```
Input:  { vin: string }
Output: {
  valid: bool,
  validation: { checksum, wmi_country, wmi_manufacturer, year_char, ... },
  vehicle: { year, make, model, trim, body, ... },
  engine: { type, cylinders, displacement, hp, fuel, ... },
  transmission: { type, speeds, ... },
  safety: { overall_rating, frontal, side, rollover, ... },
  recalls: [ { campaign, component, summary, remedy, date }, ... ],
  complaints: { total, crashes, fires, injuries, deaths },
  fuel_economy: { city_mpg, highway_mpg, combined_mpg, annual_cost, co2, ... },
  photo_url: string,
  raw_nhtsa: { ... }  // full 140+ fields
}
```

### `validate_vin`
Quick validation only — no external API calls.
```
Input:  { vin: string }
Output: {
  valid: bool,
  checksum_valid: bool,
  country: string,
  manufacturer: string,
  model_year: number,
  errors: string[]
}
```

### `lookup_recalls`
Recall lookup for a VIN or make/model/year.
```
Input:  { vin?: string, make?: string, model?: string, year?: number }
Output: { count: number, recalls: [...] }
```

### `batch_decode`
Decode multiple VINs at once (up to 50).
```
Input:  { vins: string[] }
Output: { results: [...], errors: [...] }
```

---

## REST API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/vin/:vin` | Full decode (all sources aggregated) |
| GET | `/api/vin/:vin/validate` | Quick validation only |
| GET | `/api/vin/:vin/recalls` | Recalls only |
| GET | `/api/vin/:vin/complaints` | Complaints only |
| GET | `/api/vin/:vin/safety` | Safety ratings only |
| GET | `/api/vin/:vin/fuel` | Fuel economy only |
| GET | `/api/vin/:vin/photo` | Redirect to vehicle photo URL |
| POST | `/api/batch` | Batch decode (body: `{ vins: [...] }`) |
| GET | `/api/status` | Server status |
| GET | `/health` | Health check |

---

## Frontend Design

### Landing Page
- Big centered VIN input field with "Decode" button
- Example VIN link for demo
- Clean, dark theme (consistent with qr-mcp)
- Brief explainer: "Free VIN decoder powered by NHTSA, EPA, and more"

### Results Page (single-page, renders below input)

#### Hero Section
- Vehicle photo (IMAGIN.studio) — large, prominent
- Year Make Model Trim — big heading
- VIN displayed with each section color-coded (WMI | VDS | VIS)
- Checksum badge (valid/invalid)

#### Info Cards Grid
Each card is a collapsible section:

**1. Vehicle Overview**
- Body type, doors, drive type, weight class
- Plant city, plant country
- Manufacturer

**2. Engine & Drivetrain**
- Engine type, cylinders, displacement
- Horsepower, fuel type
- Transmission type, speeds
- Drive type (FWD/RWD/AWD/4WD)

**3. Safety Ratings** ⭐
- Overall rating (big stars display)
- Frontal crash, side crash, rollover — individual star rows
- "Not rated" state for vehicles without data

**4. Fuel Economy** ⛽
- City / Highway / Combined MPG — big numbers
- Annual fuel cost
- CO2 emissions (g/mile)
- For EVs: range, charge time, kWh/100mi

**5. Recalls** ⚠️
- Count badge: "3 Recalls" (red if > 0, green if 0)
- Each recall: component, summary, consequence, remedy
- Expandable details

**6. Consumer Complaints** 📋
- Summary stats: total complaints, crashes, fires, injuries
- Severity indicator
- Most common components
- Expandable list of individual complaints (truncated)

**7. Safety Equipment** 🛡️
- Air bags (front, side, curtain, knee)
- ABS, ESC, traction control, TPMS
- Forward collision warning, lane departure
- Backup camera, parking assist
- Grid of checkmarks/x marks

**8. Raw Data** (collapsible)
- Full NHTSA decode dump in a searchable table
- 140+ fields, useful for enthusiasts

### Additional UI Features
- **VIN history** — last 10 decoded VINs stored in localStorage
- **Share link** — `mcp.vin/1HGCM82633A004352` direct link to results
- **Print/PDF** — clean print stylesheet
- **Copy report** — copy summary as text
- **QR code** — generate QR of the VIN (link to our qr-mcp!)

---

## Caching Strategy

- **In-memory LRU cache** with 1-hour TTL
- Key: VIN (uppercase, trimmed)
- Cache individual API responses separately (so partial refreshes work)
- Cache size: 1000 VINs max (~50MB estimated)
- VIN validation is always instant (no cache needed)

---

## Implementation Phases

### Phase 1: Core Service + MCP (MVP)
1. Project scaffold (package.json, .gitignore, CLAUDE.md)
2. VIN validation module (checksum, WMI tables, year decode)
3. NHTSA vPIC integration (decode)
4. MCP server with `decode_vin` and `validate_vin` tools
5. Stdio transport working with Claude Code
6. Basic REST API (`/api/vin/:vin`)

### Phase 2: Data Enrichment
7. NHTSA recalls integration
8. NHTSA complaints integration
9. NHTSA safety ratings integration
10. EPA fuel economy integration
11. IMAGIN.studio photo URLs
12. `lookup_recalls` and `batch_decode` MCP tools
13. LRU caching layer

### Phase 3: Frontend
14. Landing page with VIN input
15. Results page — hero + vehicle photo
16. Info cards: overview, engine, safety ratings
17. Info cards: fuel economy, recalls, complaints
18. Info cards: safety equipment, raw data
19. VIN history (localStorage)
20. Share links / direct URL routing
21. Print stylesheet

### Phase 4: Polish & Deploy
22. HTTP transport + OAuth (same pattern as qr-mcp)
23. Rate limiting (IP-based for REST, per-user for MCP)
24. Error handling polish (invalid VINs, API timeouts, partial failures)
25. Deploy to VPS (45.135.36.28)
26. Nginx config + SSL for mcp.vin
27. Register mcp.vin domain

---

## File Structure

```
~/projects/nodejs/vin-mcp/
├── server.mjs          # Main server (MCP + Express + REST)
├── lib/
│   ├── validate.mjs    # VIN checksum, WMI, year decode
│   ├── nhtsa.mjs       # NHTSA vPIC, recalls, complaints, safety
│   ├── epa.mjs         # EPA fuel economy
│   ├── photo.mjs       # IMAGIN.studio URLs
│   └── cache.mjs       # LRU cache
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── data/
│   └── wmi.json        # WMI → manufacturer lookup table
├── package.json
├── .env
├── .env.example
├── .gitignore
├── CLAUDE.md
└── PLAN.md             # This file
```

---

## Dependencies

```json
{
  "@modelcontextprotocol/sdk": "^1.27.1",
  "express": "^5.2.1",
  "cors": "^2.8.6",
  "dotenv": "^17.3.1"
}
```

No external VIN libraries — we build validation ourselves. All data comes from free APIs via native `fetch()`.

---

## Unique Selling Points

1. **Completely free** — no API keys, no accounts, no limits (reasonable use)
2. **MCP-native** — works directly with Claude Code and claude.ai
3. **Aggregated data** — 6 sources in one request, most decoders use only NHTSA
4. **Beautiful frontend** — not a government data dump
5. **VIN validation** — instant checksum + WMI decode before hitting any API
6. **Recall alerts** — prominent, actionable safety info
7. **Open and transparent** — shows exactly where each piece of data comes from

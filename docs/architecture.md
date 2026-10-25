# Service organization

The website, REST API and MCP server use the same report and source adapters. Tool names and existing API paths are stable.

- `server.mjs`: HTTP middleware, authentication, OAuth, MCP transport sessions and route wiring; stdio entry point.
- `lib/reports.mjs`: shared full vehicle reports, compact agent output and comparisons. Simultaneous requests for the same VIN share report assembly. Unavailable upstream results can be retried.
- `lib/mcp/index.mjs`: authoritative MCP registry, grouped discovery and tool annotations. `GET /api/tools` and `/api/status` derive their inventories from this registry.
- `lib/mcp/vehicle-tools.mjs`: VIN validation, decoding, model-year recalls and batch decoding.
- `lib/mcp/research-tools.mjs`: configuration research, VIN recall status, source coverage, comparisons and ownership calculations.
- `lib/mcp/account-tools.mjs`: saved vehicles and output preferences, scoped by a website login token.
- Other `lib/` modules: source adapters, validation, calculations, caching and persistence.
- `lib/version.mjs`: reads the version from `package.json` for all server transports and discovery.

## Adding a capability

Implement source normalization and its limits in a library module. Register its MCP tool in the relevant group and wire any REST endpoint to the same function. Add upstream fixture tests and a transport regression. Keep unknown values separate from zero and preserve source scope and retrieval dates.

Tool annotations describe side effects for agents. Read-only source tools do not change saved vehicles. Account mutations require explicit user intent and a login token. Removing a saved vehicle is marked destructive. Public discovery never contains user data or credentials.

## Compatibility and verification

All 22 existing tools retain their names. `GET /api/tools` adds grouped documentation; `/api/status` retains its `tools` array. Invalid saved VINs and invalid VINs sent to component endpoints return a JSON 400 before upstream access. The full decode and validation endpoints retain their structured validation responses.

Run `npm test` and `node --test test/transport.test.mjs`. Tests cover source failure/recovery, manufacturer status distinctions, HTTP and stdio MCP, OAuth, account isolation, report preferences, calculations and frontend state handling. Browser and printable-report checks complement these tests.

#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { validateVin, normalizeVin } from './lib/validate.mjs';
import { decodeVin as nhtsaDecode, batchDecode, getRecalls, getComplaints, getSafetyRatings } from './lib/nhtsa.mjs';
import { getFuelEconomy } from './lib/epa.mjs';
import { getPhotoUrl, getPhotoUrls } from './lib/photo.mjs';
import { vinCache, recallCache, ratingCache, fuelCache } from './lib/cache.mjs';

// ---- Full VIN report (aggregates all sources) ----

async function fullReport(vin) {
  vin = normalizeVin(vin);
  const cached = vinCache.get(vin);
  if (cached) return cached;

  const validation = validateVin(vin);
  if (!validation.valid) {
    return { valid: false, vin, validation, vehicle: null, engine: null, recalls: null, complaints: null, safety_ratings: null, fuel_economy: null, photos: null };
  }

  // Step 1: Decode VIN from NHTSA
  const decoded = await nhtsaDecode(vin);
  if (!decoded) {
    return { valid: true, vin, validation, vehicle: null, engine: null, error: 'NHTSA decode failed', recalls: null, complaints: null, safety_ratings: null, fuel_economy: null, photos: null };
  }

  const { year, make, model } = decoded.vehicle;

  // Step 2: Fetch enrichment data in parallel
  const cacheKey = `${make}|${model}|${year}`;

  const [recalls, complaints, ratings, fuel] = await Promise.all([
    recallCache.has(cacheKey) ? recallCache.get(cacheKey) : getRecalls(make, model, year).then(r => { if (r) recallCache.set(cacheKey, r); return r; }),
    getComplaints(make, model, year),
    ratingCache.has(cacheKey) ? ratingCache.get(cacheKey) : getSafetyRatings(make, model, year).then(r => { if (r) ratingCache.set(cacheKey, r); return r; }),
    fuelCache.has(cacheKey) ? fuelCache.get(cacheKey) : getFuelEconomy(year, make, model).then(r => { if (r) fuelCache.set(cacheKey, r); return r; }),
  ]);

  const photos = make && model && year ? getPhotoUrls(make, model, year) : null;

  const report = {
    valid: true,
    vin,
    validation,
    vehicle: decoded.vehicle,
    engine: decoded.engine,
    transmission: decoded.transmission,
    dimensions: decoded.dimensions,
    plant: decoded.plant,
    safety_equipment: decoded.safety,
    recalls: recalls || { count: 0, recalls: [] },
    complaints: complaints || { count: 0, complaints: [], summary: { crashes: 0, fires: 0, injuries: 0, deaths: 0 } },
    safety_ratings: ratings || { rated: false },
    fuel_economy: fuel || { available: false },
    photos,
    raw_nhtsa: decoded.raw,
  };

  vinCache.set(vin, report);
  return report;
}

// ---- MCP Server factory ----

function createMcpServer() {
  const server = new McpServer({ name: 'vin-mcp', version: '1.0.0' });

  // Tool: decode_vin
  server.tool('decode_vin',
    'Decode a VIN and return a comprehensive vehicle report with specs, recalls, complaints, safety ratings, fuel economy, and photos. Uses NHTSA, EPA, and IMAGIN.studio (all free).',
    { vin: z.string().describe('17-character Vehicle Identification Number') },
    async ({ vin }) => {
      const report = await fullReport(vin);
      return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
    }
  );

  // Tool: validate_vin
  server.tool('validate_vin',
    'Quickly validate a VIN without calling any external APIs. Checks format, checksum, decodes WMI (country + manufacturer), model year, and assembly plant.',
    { vin: z.string().describe('VIN to validate') },
    async ({ vin }) => {
      const result = validateVin(vin);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Tool: lookup_recalls
  server.tool('lookup_recalls',
    'Look up recalls for a vehicle. Provide either a VIN or make/model/year.',
    {
      vin: z.optional(z.string()).describe('VIN to look up recalls for'),
      make: z.optional(z.string()).describe('Vehicle make (e.g. Honda)'),
      model: z.optional(z.string()).describe('Vehicle model (e.g. Civic)'),
      year: z.optional(z.number()).describe('Model year (e.g. 2020)'),
    },
    async ({ vin, make, model, year }) => {
      if (vin) {
        const decoded = await nhtsaDecode(normalizeVin(vin));
        if (!decoded) return { content: [{ type: 'text', text: 'Failed to decode VIN' }] };
        make = decoded.vehicle.make;
        model = decoded.vehicle.model;
        year = decoded.vehicle.year;
      }
      if (!make || !model || !year) {
        return { content: [{ type: 'text', text: 'Provide a VIN or make + model + year' }] };
      }
      const recalls = await getRecalls(make, model, year);
      return { content: [{ type: 'text', text: JSON.stringify(recalls, null, 2) }] };
    }
  );

  // Tool: batch_decode
  server.tool('batch_decode',
    'Decode multiple VINs at once (up to 50). Returns basic decode info for each.',
    { vins: z.array(z.string()).describe('Array of VINs to decode (max 50)') },
    async ({ vins }) => {
      if (vins.length > 50) {
        return { content: [{ type: 'text', text: 'Maximum 50 VINs per batch' }] };
      }
      const results = await batchDecode(vins.map(normalizeVin));
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  return server;
}

// ---- Transport ----

const args = process.argv.slice(2);
const useHttp = args.includes('--http');
const portIdx = args.indexOf('--port');
const port = portIdx !== -1 ? Number(args[portIdx + 1]) : 3200;

if (useHttp) {
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const express = (await import('express')).default;
  const cors = (await import('cors')).default;
  const crypto = (await import('node:crypto')).default;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (origin.endsWith('.claude.ai') || origin === 'https://claude.ai' || origin.startsWith('http://localhost')) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
  }));

  app.use((req, res, next) => { console.error(`${new Date().toISOString()} ${req.method} ${req.path}`); next(); });

  // ---- MCP sessions ----
  const mcpSessions = new Map();
  const SESSION_TTL = 30 * 60 * 1000;

  setInterval(() => {
    const now = Date.now();
    for (const [id, s] of mcpSessions) {
      if (now > s.expires_at) { mcpSessions.delete(id); }
    }
    vinCache.prune();
  }, 60000);

  // ---- MCP endpoints ----
  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    let session;
    if (sessionId && mcpSessions.has(sessionId)) {
      session = mcpSessions.get(sessionId);
      session.expires_at = Date.now() + SESSION_TTL;
    } else {
      const mcpInstance = createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
      await mcpInstance.connect(transport);
      transport.onclose = () => {
        const sid = [...mcpSessions.entries()].find(([, v]) => v.transport === transport)?.[0];
        if (sid) mcpSessions.delete(sid);
      };
      session = { server: mcpInstance, transport, expires_at: Date.now() + SESSION_TTL };
      // We'll store after handling (transport generates session ID)
    }
    await session.transport.handleRequest(req, res);
    // Store session if new
    const newSid = res.getHeader('mcp-session-id');
    if (newSid && !mcpSessions.has(newSid)) {
      mcpSessions.set(newSid, session);
    }
  });

  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && mcpSessions.has(sessionId)) {
      await mcpSessions.get(sessionId).transport.handleRequest(req, res);
    } else {
      res.status(400).json({ error: 'No session. Send initialize first.' });
    }
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && mcpSessions.has(sessionId)) {
      const session = mcpSessions.get(sessionId);
      await session.transport.handleRequest(req, res);
      mcpSessions.delete(sessionId);
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  // ---- REST API ----

  const apiLimits = new Map();
  function checkRate(ip, max = 30) {
    const now = Date.now();
    const rl = apiLimits.get(ip);
    if (!rl || now > rl.reset) { apiLimits.set(ip, { count: 1, reset: now + 60000 }); return true; }
    if (rl.count >= max) return false;
    rl.count++;
    return true;
  }

  function rateGuard(max = 30) {
    return (req, res, next) => {
      const ip = req.headers['x-real-ip'] || req.ip;
      if (!checkRate(ip, max)) return res.status(429).json({ error: 'Rate limited. Try again in a minute.' });
      next();
    };
  }

  app.get('/api/vin/:vin', rateGuard(30), async (req, res) => {
    try {
      const report = await fullReport(req.params.vin);
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/vin/:vin/validate', rateGuard(60), (req, res) => {
    res.json(validateVin(req.params.vin));
  });

  app.get('/api/vin/:vin/recalls', rateGuard(30), async (req, res) => {
    try {
      const decoded = await nhtsaDecode(normalizeVin(req.params.vin));
      if (!decoded) return res.status(400).json({ error: 'Could not decode VIN' });
      const { make, model, year } = decoded.vehicle;
      const recalls = await getRecalls(make, model, year);
      res.json(recalls || { count: 0, recalls: [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/vin/:vin/complaints', rateGuard(30), async (req, res) => {
    try {
      const decoded = await nhtsaDecode(normalizeVin(req.params.vin));
      if (!decoded) return res.status(400).json({ error: 'Could not decode VIN' });
      const { make, model, year } = decoded.vehicle;
      const complaints = await getComplaints(make, model, year);
      res.json(complaints || { count: 0, complaints: [], summary: {} });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/vin/:vin/safety', rateGuard(30), async (req, res) => {
    try {
      const decoded = await nhtsaDecode(normalizeVin(req.params.vin));
      if (!decoded) return res.status(400).json({ error: 'Could not decode VIN' });
      const { make, model, year } = decoded.vehicle;
      const ratings = await getSafetyRatings(make, model, year);
      res.json(ratings || { rated: false });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/vin/:vin/fuel', rateGuard(30), async (req, res) => {
    try {
      const decoded = await nhtsaDecode(normalizeVin(req.params.vin));
      if (!decoded) return res.status(400).json({ error: 'Could not decode VIN' });
      const { make, model, year } = decoded.vehicle;
      const fuel = await getFuelEconomy(year, make, model);
      res.json(fuel || { available: false });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/vin/:vin/photo', rateGuard(60), async (req, res) => {
    const decoded = await nhtsaDecode(normalizeVin(req.params.vin));
    if (!decoded) return res.status(400).json({ error: 'Could not decode VIN' });
    const { make, model, year } = decoded.vehicle;
    const url = getPhotoUrl(make, model, year);
    res.redirect(url);
  });

  app.post('/api/batch', rateGuard(5), async (req, res) => {
    const { vins } = req.body;
    if (!Array.isArray(vins) || vins.length === 0) return res.status(400).json({ error: 'Provide { vins: [...] }' });
    if (vins.length > 50) return res.status(400).json({ error: 'Maximum 50 VINs' });
    try {
      const results = await batchDecode(vins.map(normalizeVin));
      res.json({ count: results.length, results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/status', (req, res) => {
    res.json({ status: 'ok', server: 'vin-mcp', version: '1.0.0', cache_size: vinCache.size, tools: ['decode_vin', 'validate_vin', 'lookup_recalls', 'batch_decode'] });
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', server: 'vin-mcp', version: '1.0.0' });
  });

  // Static files
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.use(express.static(path.join(__dirname, 'public')));

  // Direct VIN URL routing (e.g. /1HGCM82633A004352 → index.html)
  app.get('/:vin', (req, res, next) => {
    if (/^[A-HJ-NPR-Z0-9]{17}$/i.test(req.params.vin)) {
      return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    next();
  });

  app.listen(port, () => {
    console.error(`VIN MCP Server (HTTP) listening on port ${port}`);
    console.error(`  Frontend: http://localhost:${port}`);
    console.error(`  API: http://localhost:${port}/api/vin/{vin}`);
    console.error(`  MCP: http://localhost:${port}/mcp`);
  });

} else {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('VIN MCP Server (stdio) started');
}

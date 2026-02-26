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
import db from './lib/db.mjs';
import { hashPassword, verifyPassword, createToken, verifyJwt } from './lib/auth.mjs';
import crypto from 'node:crypto';

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  const s = crypto.randomBytes(32).toString('hex');
  console.error('WARNING: JWT_SECRET not set — sessions won\'t survive restarts');
  return s;
})();

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

  // Tool: list_saved_vins
  server.tool('list_saved_vins',
    'List VINs saved by a user. Requires a user_token from /api/auth/login.',
    { user_token: z.string().describe('JWT token from website login') },
    async ({ user_token }) => {
      const user = verifyJwt(user_token, JWT_SECRET);
      if (!user) return { content: [{ type: 'text', text: 'Invalid or expired token' }], isError: true };
      const vins = db.prepare('SELECT id, vin, label, year, make, model, created_at FROM saved_vins WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
      return { content: [{ type: 'text', text: JSON.stringify(vins, null, 2) }] };
    }
  );

  // Tool: save_vin
  server.tool('save_vin',
    'Save a VIN to a user\'s collection with an optional label.',
    {
      user_token: z.string().describe('JWT token from website login'),
      vin: z.string().describe('17-character VIN to save'),
      label: z.optional(z.string()).describe('Custom label (e.g. "Dad\'s truck")'),
    },
    async ({ user_token, vin, label }) => {
      const user = verifyJwt(user_token, JWT_SECRET);
      if (!user) return { content: [{ type: 'text', text: 'Invalid or expired token' }], isError: true };
      vin = normalizeVin(vin);
      const decoded = await nhtsaDecode(vin);
      try {
        db.prepare('INSERT INTO saved_vins (user_id, vin, label, year, make, model) VALUES (?, ?, ?, ?, ?, ?)').run(
          user.id, vin, label || null, decoded?.vehicle?.year || null, decoded?.vehicle?.make || null, decoded?.vehicle?.model || null
        );
        return { content: [{ type: 'text', text: `Saved VIN ${vin}${label ? ` as "${label}"` : ''}` }] };
      } catch (e) {
        if (e.message.includes('UNIQUE')) return { content: [{ type: 'text', text: 'VIN already saved' }], isError: true };
        throw e;
      }
    }
  );

  // Tool: remove_saved_vin
  server.tool('remove_saved_vin',
    'Remove a VIN from the user\'s saved collection.',
    {
      user_token: z.string().describe('JWT token from website login'),
      vin: z.string().describe('VIN to remove'),
    },
    async ({ user_token, vin }) => {
      const user = verifyJwt(user_token, JWT_SECRET);
      if (!user) return { content: [{ type: 'text', text: 'Invalid or expired token' }], isError: true };
      const result = db.prepare('DELETE FROM saved_vins WHERE user_id = ? AND vin = ?').run(user.id, normalizeVin(vin));
      return { content: [{ type: 'text', text: result.changes ? 'Removed' : 'VIN not found in saved list' }] };
    }
  );

  // Tool: get_output_preferences
  server.tool('get_output_preferences',
    'Get the user\'s VIN report output preferences (which sections to show/hide).',
    { user_token: z.string().describe('JWT token') },
    async ({ user_token }) => {
      const user = verifyJwt(user_token, JWT_SECRET);
      if (!user) return { content: [{ type: 'text', text: 'Invalid or expired token' }], isError: true };
      db.prepare('INSERT OR IGNORE INTO output_preferences (user_id) VALUES (?)').run(user.id);
      const prefs = db.prepare('SELECT * FROM output_preferences WHERE user_id = ?').get(user.id);
      return { content: [{ type: 'text', text: JSON.stringify(prefs, null, 2) }] };
    }
  );

  // Tool: update_output_preferences
  server.tool('update_output_preferences',
    'Update which sections appear in VIN reports. Pass only the sections you want to change.',
    {
      user_token: z.string().describe('JWT token'),
      show_overview: z.optional(z.boolean()),
      show_engine: z.optional(z.boolean()),
      show_safety_ratings: z.optional(z.boolean()),
      show_fuel_economy: z.optional(z.boolean()),
      show_recalls: z.optional(z.boolean()),
      show_complaints: z.optional(z.boolean()),
      show_safety_equipment: z.optional(z.boolean()),
      show_photos: z.optional(z.boolean()),
      show_raw_nhtsa: z.optional(z.boolean()),
    },
    async ({ user_token, ...prefs }) => {
      const user = verifyJwt(user_token, JWT_SECRET);
      if (!user) return { content: [{ type: 'text', text: 'Invalid or expired token' }], isError: true };
      db.prepare('INSERT OR IGNORE INTO output_preferences (user_id) VALUES (?)').run(user.id);
      const sets = Object.entries(prefs).filter(([, v]) => v !== undefined);
      if (sets.length === 0) return { content: [{ type: 'text', text: 'No changes provided' }] };
      const sql = `UPDATE output_preferences SET ${sets.map(([k]) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE user_id = ?`;
      db.prepare(sql).run(...sets.map(([, v]) => v ? 1 : 0), user.id);
      return { content: [{ type: 'text', text: 'Preferences updated' }] };
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

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (origin.endsWith('.claude.ai') || origin === 'https://claude.ai' || origin.startsWith('http://localhost')) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
  }));

  app.use((req, res, next) => { console.error(`${new Date().toISOString()} ${req.method} ${req.path}`); next(); });

  // ======== OAuth 2.0 (for Claude.ai / remote MCP) ========

  const BASE_URL = process.env.BASE_URL || `https://mcp.vin`;
  const clients = new Map();    // client_id -> { client_secret, redirect_uris, ... }
  const authCodes = new Map();  // code -> { client_id, redirect_uri, code_challenge, expires, ... }
  const tokens = new Map();     // access/refresh token -> { type, client_id, expires, ... }

  // Cleanup expired auth codes and tokens every 5 min
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of authCodes) { if (now > v.expires) authCodes.delete(k); }
    for (const [k, v] of tokens) { if (now > v.expires) tokens.delete(k); }
  }, 300000);

  // -- Discovery: Protected Resource Metadata (RFC 9728) --
  const protectedResourceHandler = (req, res) => {
    res.json({
      resource: `${BASE_URL}/mcp`,
      authorization_servers: [BASE_URL],
      scopes_supported: ['mcp:tools'],
      bearer_methods_supported: ['header'],
    });
  };
  app.get('/well-known/oauth-protected-resource', protectedResourceHandler);
  app.get('/well-known/oauth-protected-resource/mcp', protectedResourceHandler);
  app.get('/.well-known/oauth-protected-resource', protectedResourceHandler);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceHandler);

  // -- Discovery: Authorization Server Metadata (RFC 8414) --
  const authServerHandler = (req, res) => {
    res.json({
      issuer: BASE_URL,
      authorization_endpoint: `${BASE_URL}/oauth/authorize`,
      token_endpoint: `${BASE_URL}/oauth/token`,
      registration_endpoint: `${BASE_URL}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      scopes_supported: ['mcp:tools'],
    });
  };
  app.get('/well-known/oauth-authorization-server', authServerHandler);
  app.get('/well-known/oauth-authorization-server/mcp', authServerHandler);
  app.get('/.well-known/oauth-authorization-server', authServerHandler);
  app.get('/.well-known/oauth-authorization-server/mcp', authServerHandler);

  // -- Dynamic Client Registration (DCR) --
  app.post('/oauth/register', (req, res) => {
    const { client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method } = req.body;
    const client_id = crypto.randomUUID();
    const client_secret = crypto.randomBytes(32).toString('hex');
    const client = {
      client_id,
      client_secret,
      client_name: client_name || 'Unknown',
      redirect_uris: redirect_uris || [],
      grant_types: grant_types || ['authorization_code', 'refresh_token'],
      response_types: response_types || ['code'],
      token_endpoint_auth_method: token_endpoint_auth_method || 'client_secret_post',
    };
    clients.set(client_id, client);
    res.status(201).json(client);
  });

  // -- Authorization (consent page — no login needed, it's a free service) --
  app.get('/oauth/authorize', (req, res) => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, scope, response_type } = req.query;
    if (!client_id || !redirect_uri || !code_challenge) {
      return res.status(400).send('Missing required OAuth parameters');
    }
    // Render consent page
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Authorize — mcp.vin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',-apple-system,sans-serif;background:#0a0a0f;color:#e8e8ed;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#12121a;border:1px solid #2a2a3a;border-radius:16px;padding:2.5rem;max-width:420px;width:90%;text-align:center}
h1{font-size:2rem;font-weight:800;letter-spacing:-1px;margin-bottom:.25rem}
h1 .dot{color:#6366f1}
.desc{color:#8888a0;font-size:.95rem;margin:.75rem 0 1.5rem}
.tools{text-align:left;background:#0a0a0f;border:1px solid #2a2a3a;border-radius:8px;padding:1rem;margin-bottom:1.5rem}
.tools h3{font-size:.8rem;text-transform:uppercase;letter-spacing:1px;color:#55556a;margin-bottom:.5rem}
.tools li{color:#8888a0;font-size:.85rem;padding:.2rem 0;list-style:none}
.tools li::before{content:'\\2713';color:#22c55e;margin-right:.5rem}
form{display:flex;gap:.75rem;justify-content:center}
button{padding:.75rem 2rem;border:none;border-radius:10px;font-size:1rem;font-weight:600;cursor:pointer;font-family:inherit}
.allow{background:#6366f1;color:#fff}
.allow:hover{background:#4f46e5}
.deny{background:transparent;border:1px solid #2a2a3a;color:#8888a0}
.deny:hover{border-color:#ef4444;color:#ef4444}
</style></head><body>
<div class="card">
  <h1>mcp<span class="dot">.</span>vin</h1>
  <p class="desc">An application wants to access the VIN decoder tools.</p>
  <div class="tools">
    <h3>Permissions</h3>
    <ul>
      <li>Decode vehicle VINs</li>
      <li>Look up recalls &amp; complaints</li>
      <li>Check safety ratings &amp; fuel economy</li>
    </ul>
  </div>
  <form method="POST" action="/oauth/approve">
    <input type="hidden" name="client_id" value="${client_id}">
    <input type="hidden" name="redirect_uri" value="${encodeURIComponent(redirect_uri)}">
    <input type="hidden" name="state" value="${state || ''}">
    <input type="hidden" name="code_challenge" value="${code_challenge}">
    <input type="hidden" name="code_challenge_method" value="${code_challenge_method || 'S256'}">
    <input type="hidden" name="scope" value="${scope || 'mcp:tools'}">
    <button type="submit" class="allow">Allow</button>
    <button type="button" class="deny" onclick="window.close()">Deny</button>
  </form>
</div>
</body></html>`);
  });

  // -- Approval handler (consent form POST) --
  app.post('/oauth/approve', (req, res) => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, scope } = req.body;
    const decodedUri = decodeURIComponent(redirect_uri);

    // Validate client
    const client = clients.get(client_id);
    if (!client) return res.status(400).send('Unknown client');

    // Generate auth code
    const code = crypto.randomBytes(32).toString('hex');
    authCodes.set(code, {
      client_id,
      redirect_uri: decodedUri,
      code_challenge,
      code_challenge_method: code_challenge_method || 'S256',
      scope: scope || 'mcp:tools',
      expires: Date.now() + 10 * 60 * 1000, // 10 min
    });

    // Redirect back to client
    const url = new URL(decodedUri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  // -- Token exchange --
  app.post('/oauth/token', (req, res) => {
    const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier, refresh_token } = req.body;

    if (grant_type === 'authorization_code') {
      const authCode = authCodes.get(code);
      if (!authCode) return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired auth code' });
      if (Date.now() > authCode.expires) { authCodes.delete(code); return res.status(400).json({ error: 'invalid_grant' }); }
      if (authCode.redirect_uri !== redirect_uri) return res.status(400).json({ error: 'invalid_grant', error_description: 'Redirect URI mismatch' });

      // Verify PKCE
      if (code_verifier) {
        const expected = crypto.createHash('sha256').update(code_verifier).digest('base64url');
        if (expected !== authCode.code_challenge) {
          return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
        }
      }

      authCodes.delete(code); // one-time use

      const access_token = crypto.randomBytes(32).toString('hex');
      const rt = crypto.randomBytes(32).toString('hex');

      tokens.set(access_token, { type: 'access', client_id: authCode.client_id, expires: Date.now() + 3600000 });
      tokens.set(rt, { type: 'refresh', client_id: authCode.client_id, expires: Date.now() + 30 * 86400000 });

      return res.json({ access_token, token_type: 'Bearer', expires_in: 3600, refresh_token: rt, scope: authCode.scope });
    }

    if (grant_type === 'refresh_token') {
      const rt = tokens.get(refresh_token);
      if (!rt || rt.type !== 'refresh' || Date.now() > rt.expires) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired refresh token' });
      }
      const access_token = crypto.randomBytes(32).toString('hex');
      tokens.set(access_token, { type: 'access', client_id: rt.client_id, expires: Date.now() + 3600000 });
      return res.json({ access_token, token_type: 'Bearer', expires_in: 3600, scope: 'mcp:tools' });
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  });

  // -- Auth middleware for MCP endpoints --
  function verifyToken(req) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return false;
    const t = tokens.get(auth.slice(7));
    return t && t.type === 'access' && Date.now() < t.expires;
  }

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

  // ---- MCP endpoints (auth optional — verified if Bearer token present) ----
  function mcpAuth(req, res, next) {
    const auth = req.headers.authorization;
    // If Bearer token provided, verify it
    if (auth?.startsWith('Bearer ')) {
      if (!verifyToken(req)) {
        res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`);
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
    }
    // Allow through — free service, auth is optional for direct API access
    next();
  }

  app.post('/mcp', mcpAuth, async (req, res) => {
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
    }
    await session.transport.handleRequest(req, res);
    const newSid = res.getHeader('mcp-session-id');
    if (newSid && !mcpSessions.has(newSid)) {
      mcpSessions.set(newSid, session);
    }
  });

  app.get('/mcp', mcpAuth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && mcpSessions.has(sessionId)) {
      await mcpSessions.get(sessionId).transport.handleRequest(req, res);
    } else {
      res.status(400).json({ error: 'No session. Send initialize first.' });
    }
  });

  app.delete('/mcp', mcpAuth, async (req, res) => {
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

  // ---- User Auth & Account API ----

  function userAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Login required' });
    const payload = verifyJwt(auth.slice(7), JWT_SECRET);
    if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
    req.user = payload;
    next();
  }

  app.post('/api/auth/register', rateGuard(5), async (req, res) => {
    const { email, password, display_name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });
    const { hash, salt } = await hashPassword(password);
    const result = db.prepare('INSERT INTO users (email, password_hash, salt, display_name) VALUES (?, ?, ?, ?)').run(email, hash, salt, display_name || null);
    const token = createToken({ id: result.lastInsertRowid, email }, JWT_SECRET);
    res.status(201).json({ token, user: { id: result.lastInsertRowid, email, display_name: display_name || null } });
  });

  app.post('/api/auth/login', rateGuard(5), async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = db.prepare('SELECT id, email, password_hash, salt, display_name FROM users WHERE email = ?').get(email);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const valid = await verifyPassword(password, user.password_hash, user.salt);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
    const token = createToken({ id: user.id, email: user.email }, JWT_SECRET);
    res.json({ token, user: { id: user.id, email: user.email, display_name: user.display_name } });
  });

  app.get('/api/auth/me', userAuth, (req, res) => {
    const user = db.prepare('SELECT id, email, display_name, created_at FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  });

  // ---- Saved VINs API ----

  app.get('/api/user/vins', userAuth, (req, res) => {
    const vins = db.prepare('SELECT id, vin, label, year, make, model, created_at FROM saved_vins WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
    res.json(vins);
  });

  app.post('/api/user/vins', userAuth, rateGuard(30), async (req, res) => {
    const { vin, label } = req.body;
    if (!vin) return res.status(400).json({ error: 'VIN required' });
    const normalized = normalizeVin(vin);
    const decoded = await nhtsaDecode(normalized);
    try {
      const result = db.prepare('INSERT INTO saved_vins (user_id, vin, label, year, make, model) VALUES (?, ?, ?, ?, ?, ?)').run(
        req.user.id, normalized, label || null, decoded?.vehicle?.year || null, decoded?.vehicle?.make || null, decoded?.vehicle?.model || null
      );
      res.status(201).json({ id: result.lastInsertRowid, vin: normalized, label: label || null, year: decoded?.vehicle?.year, make: decoded?.vehicle?.make, model: decoded?.vehicle?.model });
    } catch (e) {
      if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'VIN already saved' });
      throw e;
    }
  });

  app.put('/api/user/vins/:id', userAuth, (req, res) => {
    const { label } = req.body;
    const result = db.prepare('UPDATE saved_vins SET label = ? WHERE id = ? AND user_id = ?').run(label || null, req.params.id, req.user.id);
    if (!result.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  app.delete('/api/user/vins/:id', userAuth, (req, res) => {
    const result = db.prepare('DELETE FROM saved_vins WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    if (!result.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  // ---- Output Preferences API ----

  app.get('/api/user/preferences', userAuth, (req, res) => {
    db.prepare('INSERT OR IGNORE INTO output_preferences (user_id) VALUES (?)').run(req.user.id);
    const prefs = db.prepare('SELECT * FROM output_preferences WHERE user_id = ?').get(req.user.id);
    res.json(prefs);
  });

  app.put('/api/user/preferences', userAuth, (req, res) => {
    db.prepare('INSERT OR IGNORE INTO output_preferences (user_id) VALUES (?)').run(req.user.id);
    const allowed = ['show_overview', 'show_engine', 'show_safety_ratings', 'show_fuel_economy', 'show_recalls', 'show_complaints', 'show_safety_equipment', 'show_photos', 'show_raw_nhtsa'];
    const sets = Object.entries(req.body).filter(([k, v]) => allowed.includes(k) && typeof v === 'boolean');
    if (sets.length === 0) return res.status(400).json({ error: 'No valid preferences provided' });
    const sql = `UPDATE output_preferences SET ${sets.map(([k]) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE user_id = ?`;
    db.prepare(sql).run(...sets.map(([, v]) => v ? 1 : 0), req.user.id);
    const prefs = db.prepare('SELECT * FROM output_preferences WHERE user_id = ?').get(req.user.id);
    res.json(prefs);
  });

  app.get('/api/status', (req, res) => {
    res.json({ status: 'ok', server: 'vin-mcp', version: '1.1.0', cache_size: vinCache.size, tools: ['decode_vin', 'validate_vin', 'lookup_recalls', 'batch_decode', 'list_saved_vins', 'save_vin', 'remove_saved_vin', 'get_output_preferences', 'update_output_preferences'] });
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

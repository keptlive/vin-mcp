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
import db, { logRequest, logSecurityEvent, pruneOldLogs } from './lib/db.mjs';
import { hashPassword, verifyPassword, createToken, verifyJwt } from './lib/auth.mjs';
import crypto from 'node:crypto';

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  const s = crypto.randomBytes(32).toString('hex');
  console.error('WARNING: JWT_SECRET not set — sessions won\'t survive restarts');
  return s;
})();

const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(32).toString('hex');
if (!process.env.ADMIN_KEY) console.error(`ADMIN_KEY (auto-generated): ${ADMIN_KEY}`);

// ---- HTML escaping (prevent XSS) ----
function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
}

// ---- Full VIN report (aggregates all sources) ----

async function fullReport(vin) {
  vin = normalizeVin(vin);
  const cached = vinCache.get(vin);
  if (cached) return cached;

  const validation = validateVin(vin);
  if (!validation.valid) {
    return { valid: false, vin, validation, vehicle: null, engine: null, recalls: null, complaints: null, safety_ratings: null, fuel_economy: null, photos: null };
  }

  const decoded = await nhtsaDecode(vin);
  if (!decoded) {
    return { valid: true, vin, validation, vehicle: null, engine: null, error: 'NHTSA decode failed', recalls: null, complaints: null, safety_ratings: null, fuel_economy: null, photos: null };
  }

  const { year, make, model } = decoded.vehicle;
  const cacheKey = `${make}|${model}|${year}`;

  const [recalls, complaints, ratings, fuel] = await Promise.all([
    recallCache.has(cacheKey) ? recallCache.get(cacheKey) : getRecalls(make, model, year).then(r => { if (r) recallCache.set(cacheKey, r); return r; }),
    getComplaints(make, model, year),
    ratingCache.has(cacheKey) ? ratingCache.get(cacheKey) : getSafetyRatings(make, model, year).then(r => { if (r) ratingCache.set(cacheKey, r); return r; }),
    fuelCache.has(cacheKey) ? fuelCache.get(cacheKey) : getFuelEconomy(year, make, model).then(r => { if (r) fuelCache.set(cacheKey, r); return r; }),
  ]);

  const photos = make && model && year ? getPhotoUrls(make, model, year) : null;

  const report = {
    valid: true, vin, validation,
    vehicle: decoded.vehicle, engine: decoded.engine, transmission: decoded.transmission,
    dimensions: decoded.dimensions, plant: decoded.plant, safety_equipment: decoded.safety,
    recalls: recalls || { count: 0, recalls: [] },
    complaints: complaints || { count: 0, complaints: [], summary: { crashes: 0, fires: 0, injuries: 0, deaths: 0 } },
    safety_ratings: ratings || { rated: false },
    fuel_economy: fuel || { available: false },
    photos, raw_nhtsa: decoded.raw,
  };

  vinCache.set(vin, report);
  return report;
}

// ---- MCP Server factory ----

function createMcpServer() {
  const server = new McpServer({ name: 'vin-mcp', version: '1.2.0' });

  server.tool('decode_vin',
    'Decode a VIN and return a comprehensive vehicle report with specs, recalls, complaints, safety ratings, fuel economy, and photos.',
    { vin: z.string().describe('17-character Vehicle Identification Number') },
    async ({ vin }) => {
      const report = await fullReport(vin);
      return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
    }
  );

  server.tool('validate_vin',
    'Quickly validate a VIN without calling any external APIs.',
    { vin: z.string().describe('VIN to validate') },
    async ({ vin }) => {
      const result = validateVin(vin);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

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
        make = decoded.vehicle.make; model = decoded.vehicle.model; year = decoded.vehicle.year;
      }
      if (!make || !model || !year) return { content: [{ type: 'text', text: 'Provide a VIN or make + model + year' }] };
      const recalls = await getRecalls(make, model, year);
      return { content: [{ type: 'text', text: JSON.stringify(recalls, null, 2) }] };
    }
  );

  server.tool('batch_decode',
    'Decode multiple VINs at once (up to 50).',
    { vins: z.array(z.string()).describe('Array of VINs to decode (max 50)') },
    async ({ vins }) => {
      if (vins.length > 50) return { content: [{ type: 'text', text: 'Maximum 50 VINs per batch' }] };
      const results = await batchDecode(vins.map(normalizeVin));
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

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
      if (label && label.length > 200) label = label.slice(0, 200);
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

  server.tool('get_output_preferences',
    'Get the user\'s VIN report output preferences.',
    { user_token: z.string().describe('JWT token') },
    async ({ user_token }) => {
      const user = verifyJwt(user_token, JWT_SECRET);
      if (!user) return { content: [{ type: 'text', text: 'Invalid or expired token' }], isError: true };
      db.prepare('INSERT OR IGNORE INTO output_preferences (user_id) VALUES (?)').run(user.id);
      const prefs = db.prepare('SELECT * FROM output_preferences WHERE user_id = ?').get(user.id);
      return { content: [{ type: 'text', text: JSON.stringify(prefs, null, 2) }] };
    }
  );

  const PREF_COLS = ['show_overview', 'show_engine', 'show_safety_ratings', 'show_fuel_economy', 'show_recalls', 'show_complaints', 'show_safety_equipment', 'show_photos', 'show_raw_nhtsa'];

  server.tool('update_output_preferences',
    'Update which sections appear in VIN reports.',
    {
      user_token: z.string().describe('JWT token'),
      show_overview: z.optional(z.boolean()), show_engine: z.optional(z.boolean()),
      show_safety_ratings: z.optional(z.boolean()), show_fuel_economy: z.optional(z.boolean()),
      show_recalls: z.optional(z.boolean()), show_complaints: z.optional(z.boolean()),
      show_safety_equipment: z.optional(z.boolean()), show_photos: z.optional(z.boolean()),
      show_raw_nhtsa: z.optional(z.boolean()),
    },
    async ({ user_token, ...prefs }) => {
      const user = verifyJwt(user_token, JWT_SECRET);
      if (!user) return { content: [{ type: 'text', text: 'Invalid or expired token' }], isError: true };
      db.prepare('INSERT OR IGNORE INTO output_preferences (user_id) VALUES (?)').run(user.id);
      const sets = Object.entries(prefs).filter(([k, v]) => PREF_COLS.includes(k) && v !== undefined);
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
  app.set('trust proxy', 'loopback');

  // ---- Security headers ----
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (origin === 'https://claude.ai' || origin.endsWith('.claude.ai')) return cb(null, true);
      if (origin === 'https://mcp.vin') return cb(null, true);
      if (process.env.NODE_ENV !== 'production' && origin.startsWith('http://localhost')) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
  }));

  // ---- Observability middleware ----
  app.use((req, res, next) => {
    const start = Date.now();
    const origEnd = res.end.bind(res);
    let bytesSent = 0;
    res.end = function(chunk, ...rest) {
      if (chunk) bytesSent += Buffer.byteLength(chunk);
      const duration = Date.now() - start;
      const ip = req.ip;
      // Log asynchronously to avoid blocking
      try {
        logRequest.run(ip, req.method, req.path, res.statusCode, duration, (req.headers['user-agent'] || '').slice(0, 256), req.user?.id || null, bytesSent);
      } catch {}
      return origEnd(chunk, ...rest);
    };
    next();
  });

  app.use((req, res, next) => { console.error(`${new Date().toISOString()} ${req.method} ${req.path}`); next(); });

  // ---- Rate limiting ----

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
      const ip = req.ip;
      if (!checkRate(ip, max)) {
        try { logSecurityEvent.run('rate_limit', ip, `${req.method} ${req.path} (limit: ${max}/min)`, 'warn'); } catch {}
        return res.status(429).json({ error: 'Rate limited. Try again in a minute.' });
      }
      next();
    };
  }

  // Cleanup rate limiter + prune logs every 5 min
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of apiLimits) { if (now > v.reset) apiLimits.delete(k); }
    pruneOldLogs();
  }, 300000);

  // ======== OAuth 2.0 (for Claude.ai / remote MCP) ========

  const BASE_URL = process.env.BASE_URL || 'https://mcp.vin';
  const MAX_OAUTH_CLIENTS = 500;
  const clients = new Map();
  const authCodes = new Map();
  const tokens = new Map();
  const csrfTokens = new Map(); // csrf_token -> { expires }

  // Cleanup expired OAuth state every 5 min
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of authCodes) { if (now > v.expires) authCodes.delete(k); }
    for (const [k, v] of tokens) { if (now > v.expires) tokens.delete(k); }
    for (const [k, v] of csrfTokens) { if (now > v.expires) csrfTokens.delete(k); }
  }, 300000);

  // -- Discovery --
  const protectedResourceHandler = (req, res) => {
    res.json({ resource: `${BASE_URL}/mcp`, authorization_servers: [BASE_URL], scopes_supported: ['mcp:tools'], bearer_methods_supported: ['header'] });
  };
  app.get('/well-known/oauth-protected-resource', protectedResourceHandler);
  app.get('/well-known/oauth-protected-resource/mcp', protectedResourceHandler);
  app.get('/.well-known/oauth-protected-resource', protectedResourceHandler);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceHandler);

  const authServerHandler = (req, res) => {
    res.json({
      issuer: BASE_URL,
      authorization_endpoint: `${BASE_URL}/oauth/authorize`,
      token_endpoint: `${BASE_URL}/oauth/token`,
      registration_endpoint: `${BASE_URL}/oauth/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      scopes_supported: ['mcp:tools'],
    });
  };
  app.get('/well-known/oauth-authorization-server', authServerHandler);
  app.get('/well-known/oauth-authorization-server/mcp', authServerHandler);
  app.get('/.well-known/oauth-authorization-server', authServerHandler);
  app.get('/.well-known/oauth-authorization-server/mcp', authServerHandler);

  // -- Dynamic Client Registration (rate-limited, capped) --
  app.post('/oauth/register', rateGuard(10), (req, res) => {
    if (clients.size >= MAX_OAUTH_CLIENTS) {
      return res.status(503).json({ error: 'server_error', error_description: 'Too many registered clients' });
    }
    const { client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method } = req.body;
    const client_id = crypto.randomUUID();
    const client_secret = crypto.randomBytes(32).toString('hex');
    const client = {
      client_id, client_secret,
      client_name: String(client_name || 'Unknown').slice(0, 100),
      redirect_uris: Array.isArray(redirect_uris) ? redirect_uris.map(u => String(u).slice(0, 2048)) : [],
      grant_types: grant_types || ['authorization_code', 'refresh_token'],
      response_types: response_types || ['code'],
      token_endpoint_auth_method: token_endpoint_auth_method || 'client_secret_post',
    };
    clients.set(client_id, client);
    res.status(201).json(client);
  });

  // -- Authorization (consent page with CSRF + XSS protection) --
  app.get('/oauth/authorize', rateGuard(20), (req, res) => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, scope, response_type } = req.query;
    if (!client_id || !redirect_uri || !code_challenge) {
      return res.status(400).send('Missing required OAuth parameters');
    }
    // Validate client exists
    const client = clients.get(client_id);
    if (!client) return res.status(400).send('Unknown client');

    // Generate CSRF token
    const csrf = crypto.randomBytes(32).toString('hex');
    csrfTokens.set(csrf, { expires: Date.now() + 10 * 60 * 1000 });

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
    res.setHeader('X-Frame-Options', 'DENY');
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
.allow{background:#6366f1;color:#fff}.allow:hover{background:#4f46e5}
.deny{background:transparent;border:1px solid #2a2a3a;color:#8888a0}.deny:hover{border-color:#ef4444;color:#ef4444}
</style></head><body>
<div class="card">
  <h1>mcp<span class="dot">.</span>vin</h1>
  <p class="desc">An application wants to access the VIN decoder tools.</p>
  <div class="tools"><h3>Permissions</h3><ul>
    <li>Decode vehicle VINs</li>
    <li>Look up recalls &amp; complaints</li>
    <li>Check safety ratings &amp; fuel economy</li>
  </ul></div>
  <form method="POST" action="/oauth/approve">
    <input type="hidden" name="csrf" value="${escHtml(csrf)}">
    <input type="hidden" name="client_id" value="${escHtml(client_id)}">
    <input type="hidden" name="redirect_uri" value="${escHtml(redirect_uri)}">
    <input type="hidden" name="state" value="${escHtml(state || '')}">
    <input type="hidden" name="code_challenge" value="${escHtml(code_challenge)}">
    <input type="hidden" name="code_challenge_method" value="${escHtml(code_challenge_method || 'S256')}">
    <input type="hidden" name="scope" value="${escHtml(scope || 'mcp:tools')}">
    <button type="submit" class="allow">Allow</button>
    <button type="button" class="deny" onclick="window.close()">Deny</button>
  </form>
</div>
</body></html>`);
  });

  // -- Approval handler (with CSRF + redirect_uri validation) --
  app.post('/oauth/approve', rateGuard(20), (req, res) => {
    const { csrf, client_id, redirect_uri, state, code_challenge, code_challenge_method, scope } = req.body;

    // Verify CSRF
    if (!csrf || !csrfTokens.has(csrf)) {
      logSecurityEvent.run('csrf_fail', req.ip, 'OAuth approve CSRF mismatch', 'warn');
      return res.status(403).send('Invalid or expired CSRF token');
    }
    csrfTokens.delete(csrf);

    // Validate client
    const client = clients.get(client_id);
    if (!client) return res.status(400).send('Unknown client');

    // Validate redirect_uri against registered URIs
    if (client.redirect_uris.length > 0 && !client.redirect_uris.includes(redirect_uri)) {
      logSecurityEvent.run('oauth_redirect_mismatch', req.ip, `client=${client_id} uri=${redirect_uri}`, 'warn');
      return res.status(400).send('Invalid redirect URI for this client');
    }

    const code = crypto.randomBytes(32).toString('hex');
    authCodes.set(code, {
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method: code_challenge_method || 'S256',
      scope: scope || 'mcp:tools',
      expires: Date.now() + 10 * 60 * 1000,
    });

    const url = new URL(redirect_uri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  // -- Token exchange (with mandatory PKCE + client_id check) --
  app.post('/oauth/token', rateGuard(20), (req, res) => {
    const { grant_type, code, redirect_uri, client_id, code_verifier, refresh_token } = req.body;

    if (grant_type === 'authorization_code') {
      const authCode = authCodes.get(code);
      if (!authCode) {
        logSecurityEvent.run('oauth_invalid_code', req.ip, '', 'warn');
        return res.status(400).json({ error: 'invalid_grant' });
      }
      if (Date.now() > authCode.expires) { authCodes.delete(code); return res.status(400).json({ error: 'invalid_grant' }); }
      if (authCode.client_id !== client_id) {
        logSecurityEvent.run('oauth_client_mismatch', req.ip, `expected=${authCode.client_id} got=${client_id}`, 'high');
        return res.status(400).json({ error: 'invalid_grant' });
      }
      if (authCode.redirect_uri !== redirect_uri) return res.status(400).json({ error: 'invalid_grant' });

      // Mandatory PKCE verification
      if (authCode.code_challenge) {
        if (!code_verifier) return res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier required' });
        const expected = crypto.createHash('sha256').update(code_verifier).digest('base64url');
        if (expected !== authCode.code_challenge) {
          logSecurityEvent.run('oauth_pkce_fail', req.ip, `client=${client_id}`, 'warn');
          return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
        }
      }

      authCodes.delete(code);

      const access_token = crypto.randomBytes(32).toString('hex');
      const rt = crypto.randomBytes(32).toString('hex');
      tokens.set(access_token, { type: 'access', client_id: authCode.client_id, expires: Date.now() + 3600000 });
      tokens.set(rt, { type: 'refresh', client_id: authCode.client_id, expires: Date.now() + 30 * 86400000 });

      return res.json({ access_token, token_type: 'Bearer', expires_in: 3600, refresh_token: rt, scope: authCode.scope });
    }

    if (grant_type === 'refresh_token') {
      const rt = tokens.get(refresh_token);
      if (!rt || rt.type !== 'refresh' || Date.now() > rt.expires) {
        return res.status(400).json({ error: 'invalid_grant' });
      }
      // Rotate refresh token
      tokens.delete(refresh_token);
      const access_token = crypto.randomBytes(32).toString('hex');
      const newRt = crypto.randomBytes(32).toString('hex');
      tokens.set(access_token, { type: 'access', client_id: rt.client_id, expires: Date.now() + 3600000 });
      tokens.set(newRt, { type: 'refresh', client_id: rt.client_id, expires: Date.now() + 30 * 86400000 });
      return res.json({ access_token, token_type: 'Bearer', expires_in: 3600, refresh_token: newRt, scope: 'mcp:tools' });
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  });

  // -- MCP Auth --
  function verifyOAuthToken(req) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return false;
    const t = tokens.get(auth.slice(7));
    return t && t.type === 'access' && Date.now() < t.expires;
  }

  // ---- MCP sessions (capped) ----
  const MAX_MCP_SESSIONS = 200;
  const mcpSessions = new Map();
  const SESSION_TTL = 30 * 60 * 1000;

  setInterval(() => {
    const now = Date.now();
    for (const [id, s] of mcpSessions) { if (now > s.expires_at) mcpSessions.delete(id); }
    vinCache.prune();
  }, 60000);

  function mcpAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      if (!verifyOAuthToken(req)) {
        res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`);
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
    }
    next();
  }

  app.post('/mcp', mcpAuth, rateGuard(60), async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    let session;
    if (sessionId && mcpSessions.has(sessionId)) {
      session = mcpSessions.get(sessionId);
      session.expires_at = Date.now() + SESSION_TTL;
    } else {
      if (mcpSessions.size >= MAX_MCP_SESSIONS) {
        return res.status(503).json({ error: 'Too many active sessions. Try again later.' });
      }
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
    if (newSid && !mcpSessions.has(newSid)) mcpSessions.set(newSid, session);
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

  function safeError(res, err) {
    console.error('API error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }

  app.get('/api/vin/:vin', rateGuard(30), async (req, res) => {
    try { res.json(await fullReport(req.params.vin)); } catch (err) { safeError(res, err); }
  });

  app.get('/api/vin/:vin/validate', rateGuard(60), (req, res) => {
    res.json(validateVin(req.params.vin));
  });

  app.get('/api/vin/:vin/recalls', rateGuard(30), async (req, res) => {
    try {
      const decoded = await nhtsaDecode(normalizeVin(req.params.vin));
      if (!decoded) return res.status(400).json({ error: 'Could not decode VIN' });
      const { make, model, year } = decoded.vehicle;
      res.json(await getRecalls(make, model, year) || { count: 0, recalls: [] });
    } catch (err) { safeError(res, err); }
  });

  app.get('/api/vin/:vin/complaints', rateGuard(30), async (req, res) => {
    try {
      const decoded = await nhtsaDecode(normalizeVin(req.params.vin));
      if (!decoded) return res.status(400).json({ error: 'Could not decode VIN' });
      const { make, model, year } = decoded.vehicle;
      res.json(await getComplaints(make, model, year) || { count: 0, complaints: [], summary: {} });
    } catch (err) { safeError(res, err); }
  });

  app.get('/api/vin/:vin/safety', rateGuard(30), async (req, res) => {
    try {
      const decoded = await nhtsaDecode(normalizeVin(req.params.vin));
      if (!decoded) return res.status(400).json({ error: 'Could not decode VIN' });
      const { make, model, year } = decoded.vehicle;
      res.json(await getSafetyRatings(make, model, year) || { rated: false });
    } catch (err) { safeError(res, err); }
  });

  app.get('/api/vin/:vin/fuel', rateGuard(30), async (req, res) => {
    try {
      const decoded = await nhtsaDecode(normalizeVin(req.params.vin));
      if (!decoded) return res.status(400).json({ error: 'Could not decode VIN' });
      const { make, model, year } = decoded.vehicle;
      res.json(await getFuelEconomy(year, make, model) || { available: false });
    } catch (err) { safeError(res, err); }
  });

  app.get('/api/vin/:vin/photo', rateGuard(60), async (req, res) => {
    try {
      const decoded = await nhtsaDecode(normalizeVin(req.params.vin));
      if (!decoded) return res.status(400).json({ error: 'Could not decode VIN' });
      res.redirect(getPhotoUrl(decoded.vehicle.make, decoded.vehicle.model, decoded.vehicle.year));
    } catch (err) { safeError(res, err); }
  });

  app.post('/api/batch', rateGuard(5), async (req, res) => {
    const { vins } = req.body;
    if (!Array.isArray(vins) || vins.length === 0) return res.status(400).json({ error: 'Provide { vins: [...] }' });
    if (vins.length > 50) return res.status(400).json({ error: 'Maximum 50 VINs' });
    try {
      const results = await batchDecode(vins.map(normalizeVin));
      res.json({ count: results.length, results });
    } catch (err) { safeError(res, err); }
  });

  // ---- User Auth ----

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
    if (String(email).length > 254) return res.status(400).json({ error: 'Email too long' });
    if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be 8-128 characters' });
    const safeName = display_name ? String(display_name).slice(0, 100) : null;
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      logSecurityEvent.run('duplicate_register', req.ip, email, 'info');
      return res.status(409).json({ error: 'Email already registered' });
    }
    const { hash, salt } = await hashPassword(password);
    const result = db.prepare('INSERT INTO users (email, password_hash, salt, display_name) VALUES (?, ?, ?, ?)').run(email, hash, salt, safeName);
    const token = createToken({ id: result.lastInsertRowid, email }, JWT_SECRET);
    res.status(201).json({ token, user: { id: result.lastInsertRowid, email, display_name: safeName } });
  });

  app.post('/api/auth/login', rateGuard(5), async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = db.prepare('SELECT id, email, password_hash, salt, display_name FROM users WHERE email = ?').get(email);
    if (!user) {
      logSecurityEvent.run('login_fail', req.ip, `unknown email: ${String(email).slice(0, 50)}`, 'info');
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const valid = await verifyPassword(password, user.password_hash, user.salt);
    if (!valid) {
      logSecurityEvent.run('login_fail', req.ip, `wrong password for: ${String(email).slice(0, 50)}`, 'warn');
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = createToken({ id: user.id, email: user.email }, JWT_SECRET);
    res.json({ token, user: { id: user.id, email: user.email, display_name: user.display_name } });
  });

  app.get('/api/auth/me', userAuth, (req, res) => {
    const user = db.prepare('SELECT id, email, display_name, created_at FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  });

  // ---- Saved VINs ----

  app.get('/api/user/vins', userAuth, (req, res) => {
    res.json(db.prepare('SELECT id, vin, label, year, make, model, created_at FROM saved_vins WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id));
  });

  app.post('/api/user/vins', userAuth, rateGuard(30), async (req, res) => {
    const { vin } = req.body;
    let { label } = req.body;
    if (!vin) return res.status(400).json({ error: 'VIN required' });
    if (label) label = String(label).slice(0, 200);
    const normalized = normalizeVin(vin);
    const decoded = await nhtsaDecode(normalized);
    try {
      const result = db.prepare('INSERT INTO saved_vins (user_id, vin, label, year, make, model) VALUES (?, ?, ?, ?, ?, ?)').run(
        req.user.id, normalized, label || null, decoded?.vehicle?.year || null, decoded?.vehicle?.make || null, decoded?.vehicle?.model || null
      );
      res.status(201).json({ id: result.lastInsertRowid, vin: normalized, label: label || null, year: decoded?.vehicle?.year, make: decoded?.vehicle?.make, model: decoded?.vehicle?.model });
    } catch (e) {
      if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'VIN already saved' });
      safeError(res, e);
    }
  });

  app.put('/api/user/vins/:id', userAuth, (req, res) => {
    let { label } = req.body;
    if (label) label = String(label).slice(0, 200);
    const result = db.prepare('UPDATE saved_vins SET label = ? WHERE id = ? AND user_id = ?').run(label || null, req.params.id, req.user.id);
    if (!result.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  app.delete('/api/user/vins/:id', userAuth, (req, res) => {
    const result = db.prepare('DELETE FROM saved_vins WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    if (!result.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  // ---- Preferences ----

  const PREF_COLS = ['show_overview', 'show_engine', 'show_safety_ratings', 'show_fuel_economy', 'show_recalls', 'show_complaints', 'show_safety_equipment', 'show_photos', 'show_raw_nhtsa'];

  app.get('/api/user/preferences', userAuth, (req, res) => {
    db.prepare('INSERT OR IGNORE INTO output_preferences (user_id) VALUES (?)').run(req.user.id);
    res.json(db.prepare('SELECT * FROM output_preferences WHERE user_id = ?').get(req.user.id));
  });

  app.put('/api/user/preferences', userAuth, (req, res) => {
    db.prepare('INSERT OR IGNORE INTO output_preferences (user_id) VALUES (?)').run(req.user.id);
    const sets = Object.entries(req.body).filter(([k, v]) => PREF_COLS.includes(k) && (typeof v === 'boolean' || v === 0 || v === 1));
    if (sets.length === 0) return res.status(400).json({ error: 'No valid preferences provided' });
    const sql = `UPDATE output_preferences SET ${sets.map(([k]) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE user_id = ?`;
    db.prepare(sql).run(...sets.map(([, v]) => (v === true || v === 1) ? 1 : 0), req.user.id);
    res.json(db.prepare('SELECT * FROM output_preferences WHERE user_id = ?').get(req.user.id));
  });

  // ---- Public status ----

  app.get('/api/status', (req, res) => {
    res.json({ status: 'ok', server: 'vin-mcp', version: '1.2.0', tools: ['decode_vin', 'validate_vin', 'lookup_recalls', 'batch_decode', 'list_saved_vins', 'save_vin', 'remove_saved_vin', 'get_output_preferences', 'update_output_preferences'] });
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // ======== Observability API (admin-only, secured by ADMIN_KEY) ========

  function adminAuth(req, res, next) {
    const key = req.headers['x-admin-key'] || req.query.key;
    if (!key || key !== ADMIN_KEY) {
      logSecurityEvent.run('admin_auth_fail', req.ip, req.path, 'high');
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  }

  // Traffic overview
  app.get('/api/admin/traffic', adminAuth, (req, res) => {
    const minutes = Math.min(parseInt(req.query.minutes) || 60, 1440);
    const since = new Date(Date.now() - minutes * 60000).toISOString().replace('T', ' ').slice(0, 19);

    const totalRequests = db.prepare('SELECT COUNT(*) as count FROM request_log WHERE ts >= ?').get(since).count;
    const uniqueIps = db.prepare('SELECT COUNT(DISTINCT ip) as count FROM request_log WHERE ts >= ?').get(since).count;
    const avgDuration = db.prepare('SELECT AVG(duration_ms) as avg FROM request_log WHERE ts >= ?').get(since).avg || 0;
    const statusCodes = db.prepare('SELECT status, COUNT(*) as count FROM request_log WHERE ts >= ? GROUP BY status ORDER BY count DESC').all(since);
    const topPaths = db.prepare('SELECT path, COUNT(*) as count FROM request_log WHERE ts >= ? GROUP BY path ORDER BY count DESC LIMIT 20').all(since);
    const topIps = db.prepare('SELECT ip, COUNT(*) as count FROM request_log WHERE ts >= ? GROUP BY ip ORDER BY count DESC LIMIT 20').all(since);
    const requestsPerMinute = db.prepare(`SELECT strftime('%Y-%m-%d %H:%M', ts) as minute, COUNT(*) as count FROM request_log WHERE ts >= ? GROUP BY minute ORDER BY minute DESC LIMIT 60`).all(since);
    const totalBytes = db.prepare('SELECT SUM(bytes) as total FROM request_log WHERE ts >= ?').get(since).total || 0;

    res.json({
      period: { minutes, since },
      summary: { total_requests: totalRequests, unique_ips: uniqueIps, avg_duration_ms: Math.round(avgDuration), total_bytes: totalBytes },
      status_codes: statusCodes,
      top_paths: topPaths,
      top_ips: topIps,
      requests_per_minute: requestsPerMinute,
    });
  });

  // Security events
  app.get('/api/admin/security', adminAuth, (req, res) => {
    const hours = Math.min(parseInt(req.query.hours) || 24, 168);
    const since = new Date(Date.now() - hours * 3600000).toISOString().replace('T', ' ').slice(0, 19);

    const events = db.prepare('SELECT * FROM security_events WHERE ts >= ? ORDER BY ts DESC LIMIT 200').all(since);
    const byType = db.prepare('SELECT event_type, COUNT(*) as count FROM security_events WHERE ts >= ? GROUP BY event_type ORDER BY count DESC').all(since);
    const byIp = db.prepare('SELECT ip, COUNT(*) as count FROM security_events WHERE ts >= ? GROUP BY ip ORDER BY count DESC LIMIT 20').all(since);
    const bySeverity = db.prepare('SELECT severity, COUNT(*) as count FROM security_events WHERE ts >= ? GROUP BY severity').all(since);

    res.json({
      period: { hours, since },
      summary: { total: events.length, by_type: byType, by_severity: bySeverity, suspicious_ips: byIp },
      events,
    });
  });

  // Error analysis
  app.get('/api/admin/errors', adminAuth, (req, res) => {
    const hours = Math.min(parseInt(req.query.hours) || 24, 168);
    const since = new Date(Date.now() - hours * 3600000).toISOString().replace('T', ' ').slice(0, 19);

    const errors = db.prepare('SELECT status, path, ip, ts, duration_ms FROM request_log WHERE ts >= ? AND status >= 400 ORDER BY ts DESC LIMIT 200').all(since);
    const errorsByStatus = db.prepare('SELECT status, COUNT(*) as count FROM request_log WHERE ts >= ? AND status >= 400 GROUP BY status ORDER BY count DESC').all(since);
    const errorsByPath = db.prepare('SELECT path, COUNT(*) as count FROM request_log WHERE ts >= ? AND status >= 400 GROUP BY path ORDER BY count DESC LIMIT 20').all(since);
    const errorRate = db.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as errors FROM request_log WHERE ts >= ?').get(since);

    res.json({
      period: { hours, since },
      summary: { error_rate: errorRate.total > 0 ? (errorRate.errors / errorRate.total * 100).toFixed(2) + '%' : '0%', total_errors: errorRate.errors, total_requests: errorRate.total },
      by_status: errorsByStatus,
      by_path: errorsByPath,
      recent_errors: errors,
    });
  });

  // User stats
  app.get('/api/admin/users', adminAuth, (req, res) => {
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const totalSavedVins = db.prepare('SELECT COUNT(*) as count FROM saved_vins').get().count;
    const recentUsers = db.prepare('SELECT id, email, display_name, created_at FROM users ORDER BY created_at DESC LIMIT 20').all();
    const topSavers = db.prepare('SELECT u.email, COUNT(s.id) as saved_count FROM users u JOIN saved_vins s ON u.id = s.user_id GROUP BY u.id ORDER BY saved_count DESC LIMIT 10').all();

    res.json({
      summary: { total_users: totalUsers, total_saved_vins: totalSavedVins },
      recent_users: recentUsers,
      top_savers: topSavers,
    });
  });

  // Attack detection — identify suspicious patterns
  app.get('/api/admin/threats', adminAuth, (req, res) => {
    const hours = Math.min(parseInt(req.query.hours) || 1, 24);
    const since = new Date(Date.now() - hours * 3600000).toISOString().replace('T', ' ').slice(0, 19);

    // IPs with many 4xx/5xx errors (scanning/fuzzing)
    const scanners = db.prepare(`SELECT ip, COUNT(*) as error_count, GROUP_CONCAT(DISTINCT path) as paths FROM request_log WHERE ts >= ? AND status >= 400 GROUP BY ip HAVING error_count > 10 ORDER BY error_count DESC LIMIT 20`).all(since);

    // IPs hitting rate limits
    const rateLimited = db.prepare(`SELECT ip, COUNT(*) as count FROM security_events WHERE ts >= ? AND event_type = 'rate_limit' GROUP BY ip ORDER BY count DESC LIMIT 20`).all(since);

    // Brute force login attempts
    const bruteForce = db.prepare(`SELECT ip, COUNT(*) as count FROM security_events WHERE ts >= ? AND event_type = 'login_fail' GROUP BY ip HAVING count >= 3 ORDER BY count DESC LIMIT 20`).all(since);

    // OAuth abuse
    const oauthAbuse = db.prepare(`SELECT ip, event_type, COUNT(*) as count FROM security_events WHERE ts >= ? AND event_type LIKE 'oauth%' GROUP BY ip, event_type ORDER BY count DESC LIMIT 20`).all(since);

    // High-volume IPs
    const highVolume = db.prepare(`SELECT ip, COUNT(*) as requests, AVG(duration_ms) as avg_ms FROM request_log WHERE ts >= ? GROUP BY ip HAVING requests > 100 ORDER BY requests DESC LIMIT 20`).all(since);

    res.json({
      period: { hours, since },
      scanners,
      rate_limited: rateLimited,
      brute_force: bruteForce,
      oauth_abuse: oauthAbuse,
      high_volume_ips: highVolume,
    });
  });

  // Live system stats
  app.get('/api/admin/system', adminAuth, (req, res) => {
    const mem = process.memoryUsage();
    res.json({
      uptime_seconds: Math.round(process.uptime()),
      memory: { rss_mb: Math.round(mem.rss / 1048576), heap_used_mb: Math.round(mem.heapUsed / 1048576), heap_total_mb: Math.round(mem.heapTotal / 1048576) },
      active_mcp_sessions: mcpSessions.size,
      oauth_clients: clients.size,
      oauth_tokens: tokens.size,
      cache_size: vinCache.size,
      db_size_mb: (() => { try { const s = db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get(); return Math.round(s.size / 1048576 * 100) / 100; } catch { return 0; } })(),
    });
  });

  // ---- Static files ----
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/:vin', (req, res, next) => {
    if (/^[A-HJ-NPR-Z0-9]{17}$/i.test(req.params.vin)) {
      return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    next();
  });

  app.listen(port, () => {
    console.error(`VIN MCP Server (HTTP) v1.2.0 listening on port ${port}`);
    console.error(`  Frontend: http://localhost:${port}`);
    console.error(`  API: http://localhost:${port}/api/vin/{vin}`);
    console.error(`  MCP: http://localhost:${port}/mcp`);
    console.error(`  Admin: http://localhost:${port}/api/admin/traffic`);
  });

} else {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('VIN MCP Server (stdio) started');
}

// mcp.vin does not ask any manufacturer about a VIN (owner decision after the terms review of 2026-11-18). This test
// fails if a request to a maker becomes possible again:
//  1. no maker hostname appears in server-side code (lib/, server.mjs, cli.mjs, public/client.mjs) except as a link
//     target in the link table, lib/recall-links.mjs, which itself makes no requests;
//  2. with every upstream mocked (tests/mock-upstream.mjs refuses anything it does not answer), the report paths
//     (REST report, recall-status, complaints, photo, comparison, server-rendered VIN page, MCP decode_vin and
//     vin_recall_status) make outbound requests to government hosts only, and the Price tab's POST /api/market asks
//     only mcp.vin's own private price service (MARKET_API_URL; lib/market.mjs), never a maker or anyone else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, cp, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { validateVin } from '../lib/validate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

// Registrable domains of vehicle makers and their lookup services (US, Canada and the hosts the deleted lookups used).
const MAKER_HOST = new RegExp(String.raw`\b(?:[a-z0-9-]+\.)*(?:` + ['ford', 'lincoln', 'gm', 'chevrolet', 'buick', 'gmc', 'cadillac', 'tesla',
  'teslamotors', 'honda', 'acura', 'subaru', 'hyundai', 'hyundaiusa', 'hyundaicanada', 'genesis', 'toyota', 'lexus', 'kia', 'nissan', 'nissanusa',
  'infiniti', 'infinitiusa', 'mopar', 'chrysler', 'dodge', 'jeep', 'ramtrucks', 'fiatusa', 'alfaromeousa', 'stellantis', 'vw', 'volkswagen', 'audi',
  'audiusa', 'landrover', 'landroverusa', 'jaguar', 'jaguarusa', 'mbusa', 'mercedes-benz', 'mazdausa', 'mazda', 'bmwusa', 'bmw', 'miniusa', 'lucidmotors',
  'volvocars', 'mitsubishicars', 'porsche', 'rivian', 'polestar'].join('|') + String.raw`)\.(?:com|ca|net|us|de|co\.uk)\b|omnigraph\.audi|vwservicesfa|teslaservice-api|vinrecall\.(?:lrdx|jdx)`, 'i');
// lib/market.mjs asks mcp.vin's own price service (a private address in production); the test points it here.
const PRICE_SERVICE_HOST = 'price-service.mock.invalid';
const GOVERNMENT_HOST = /(^|\.)(nhtsa\.gov|nhtsa\.dot\.gov|dot\.gov|fueleconomy\.gov|epa\.gov|federalregister\.gov|federalreserve\.gov)$/;

function files(dir) {
  return readdirSync(dir).flatMap(name => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(mjs|js|json)$/.test(name) ? [p] : [];
  });
}

test('the pattern catches the hosts the deleted lookups used, and not the make names alone', () => {
  for (const host of ['https://www.ford.com/support/recalls-details/X/', 'https://experience.gm.com/ownercenter/api/X/gfas',
    'https://teslaservice-api.tesla.com/x', 'https://mygarage.honda.com/s/sfsites/aura', 'https://www.nissanusa.com/content/nissan_prod/x',
    'https://wrecall.extra.chrysler.com/fleetreports', 'https://www.subaru.com/services/vehicles/recalls', 'https://vwservicesfa.x',
    'https://omnigraph.audi', 'https://vinrecall.lrdx.x', 'https://www.mopar.com/en-us/x', 'https://owners.kia.com/x'])
    assert.match(host, MAKER_HOST, host);
  for (const ok of ['HONDA', 'INFINITI', 'make: Ford', 'https://vpic.nhtsa.dot.gov/api/', 'https://www.nhtsa.gov/recalls', 'https://www.fueleconomy.gov/ws'])
    assert.doesNotMatch(ok, MAKER_HOST, ok);
});

test('no maker hostname in server-side code except as a link target in lib/recall-links.mjs', () => {
  const scanned = [...files(path.join(root, 'lib')), ...['server.mjs', 'cli.mjs', 'public/client.mjs'].map(f => path.join(root, f))];
  assert.ok(scanned.length > 40, 'lib/ was scanned');
  const hits = [];
  for (const file of scanned) {
    const rel = path.relative(root, file);
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (!MAKER_HOST.test(line)) return;
      // In the link table a maker host may appear only in a page or vinUrl entry, or in a comment.
      if (rel === path.join('lib', 'recall-links.mjs') && /^\s*(?:\w+: \{maker: .*(?:page|vinUrl): |\/\/|\*|\/\*)/.test(line)) return;
      hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('lib/recall-links.mjs makes no requests: no fetch, no http(s), no dynamic import, only two local imports', () => {
  const code = readFileSync(path.join(root, 'lib/recall-links.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\bfetch\s*\(|node:https?|['"]https?['"]|\bimport\s*\(|\brequest\s*\(|XMLHttpRequest|node:net|node:tls/);
  assert.deepEqual([...code.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]).sort(), ['./research.mjs', './validate.mjs']);
});

test('no deleted manufacturer module is left behind or imported', () => {
  for (const gone of ['recall-status', 'manufacturer-recalls', 'more-manufacturer-recalls', 'mopar-recalls', 'manufacturer-description']) {
    assert.throws(() => statSync(path.join(root, 'lib', gone + '.mjs')), /ENOENT/, gone);
    for (const file of [...files(path.join(root, 'lib')), path.join(root, 'server.mjs')])
      assert.doesNotMatch(readFileSync(file, 'utf8'), new RegExp(`['"]\\./(?:lib/)?${gone}\\.mjs['"]`), `${file} imports ${gone}`);
  }
});

test('report paths make outbound requests to government hosts only, with every upstream mocked', async t => {
  const stage = await mkdtemp(path.join(tmpdir(), 'vin-mcp-nomaker-'));
  for (const f of ['server.mjs', 'package.json', 'lib', 'public', 'tests/mock-upstream.mjs']) await cp(path.join(root, f), path.join(stage, f), {recursive: true});
  await symlink(path.join(root, 'node_modules'), path.join(stage, 'node_modules'), 'dir');
  const log = path.join(stage, 'outbound.jsonl');
  const port = 23297, base = `http://127.0.0.1:${port}`;
  const env = {...process.env, JWT_SECRET: 'isolated-test-secret', ADMIN_KEY: 'b'.repeat(64), NODE_ENV: 'production', VPIC_LOCAL_DB: 'off', MOCK_OUTBOUND_LOG: log,
    MARKET_API_URL: `http://${PRICE_SERVICE_HOST}:8791`};
  const child = spawn(process.execPath, ['--import', path.join(stage, 'tests/mock-upstream.mjs'), path.join(stage, 'server.mjs'), '--http', '--port', String(port)], {cwd: stage, env, stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  t.after(async () => { child.kill(); await new Promise(resolve => child.once('exit', resolve)); await rm(stage, {recursive: true, force: true}); });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); if (i === 99) throw Error(stderr); }

  const fix = v => v.slice(0, 8) + validateVin(v).checksum.expected + v.slice(9);
  // Ford, Tesla, GM, Mopar, Nissan, Hyundai, Kia, Audi, Toyota, Honda (mock decode makes, tests/mock-upstream.mjs) and Volvo (no maker page).
  const vins = ['1FTEX1EP4FFD06976', '5YJSA1DG9DFP14705', '1G1FW6S06H4188545', '1D3HW48K55S152258', '1N4AL3APXFN868842', 'KM8K53AG0MU098173',
    '5XXGR4A60FG353263', fix('WAUFFAFL3DA152660'), fix('4T1BF1FK0CU123456'), '1HGCM82633A004352', fix('YV1MS382062123456')];
  const client = new Client({name: 'no-maker-check', version: '1'}), transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'));
  await client.connect(transport);
  try {
    for (const vin of vins) {
      const report = await (await fetch(`${base}/api/vin/${vin}?recall_wait=full`)).json();
      assert.equal(report.recall_status?.reason, 'manufacturer_link_only', vin);
      assert.equal((await fetch(`${base}/api/vin/${vin}/recall-status`)).status, 200, vin);
      assert.equal((await fetch(`${base}/api/vin/${vin}/complaints`)).status, 200, vin);
      assert.ok([200, 404].includes((await fetch(`${base}/api/vin/${vin}/photo`)).status), vin);
      const v = report.vehicle || {};
      const price = await fetch(`${base}/api/market`, {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({vin, year: Number(v.year), make: v.make, model: v.model, zip: '10520', miles: 48000})});
      assert.equal(price.status, 200, vin);
      assert.equal((await price.json()).ok, true, vin + ': the Price tab reached the (mock) price service');
      assert.equal((await fetch(`${base}/${vin}`)).status, 200, vin);
      const mcp = await client.callTool({name: 'decode_vin', arguments: {vin, recall_wait: 'full'}});
      assert.ok(!mcp.isError, vin);
      assert.ok(!(await client.callTool({name: 'vin_recall_status', arguments: {vin}})).isError, vin);
    }
    assert.equal((await fetch(`${base}/api/research/compare`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({vins: vins.slice(0, 4)})})).status, 200);
  } finally { await transport.terminateSession().catch(() => {}); await client.close(); }

  const lines = (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(lines.length > 10, 'the mock logged the outbound requests');
  const hosts = [...new Set(lines.map(l => l.host))].sort();
  assert.deepEqual(hosts.filter(h => MAKER_HOST.test(h) || MAKER_HOST.test('https://' + h)), [], 'no maker host');
  assert.ok(hosts.includes(PRICE_SERVICE_HOST), 'the market route was exercised');
  assert.deepEqual(hosts.filter(h => !GOVERNMENT_HOST.test(h) && h !== PRICE_SERVICE_HOST), [], 'government hosts and our own price service only: ' + hosts.join(', '));
  assert.ok(lines.filter(l => l.host === PRICE_SERVICE_HOST).every(l => /^http:\/\/price-service\.mock\.invalid:8791\/market\?/.test(l.url)), 'price service: /market only');
  assert.deepEqual(lines.filter(l => l.via !== 'fetch' && l.via !== 'blocked'), [], 'no node:http(s) requests at all');
});

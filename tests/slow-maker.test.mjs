// The real server with a slow manufacturer lookup and slow NHTSA complaints: Ford's page and NHTSA's complaint list
// answer after 2.6 s (tests/mock-upstream.mjs, MOCK_FORD_DELAY_MS, MOCK_COMPLAINTS_DELAY_MS), longer than the
// website/REST wait (2 s) and shorter than MCP's (6 s). Own server and port, so its rate limits and caches are apart
// from tests/integration.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, symlink, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { validateVin } from '../lib/validate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = await mkdtemp(path.join(tmpdir(), 'vin-mcp-slow-maker-'));
for (const f of ['server.mjs', 'package.json', 'lib', 'public', 'tests/mock-upstream.mjs', 'tests/mopar-fixture.mjs', 'tests/manufacturer-fixtures.mjs']) await cp(path.join(root, f), path.join(stage, f), {recursive: true});
await symlink(path.join(root, 'node_modules'), path.join(stage, 'node_modules'), 'dir');
await mkdir(path.join(stage, 'data'), {recursive: true});
const port = 23292, base = `http://127.0.0.1:${port}`, FORD_DELAY = 2600;
const env = {...process.env, JWT_SECRET: 'isolated-test-secret', ADMIN_KEY: 'b'.repeat(64), NODE_ENV: 'production', MOCK_FORD_DELAY_MS: String(FORD_DELAY), MOCK_COMPLAINTS_DELAY_MS: String(FORD_DELAY)};
const child = spawn(process.execPath, ['--import', path.join(stage, 'tests/mock-upstream.mjs'), path.join(stage, 'server.mjs'), '--http', '--port', String(port)], {cwd: stage, env, stdio: ['ignore', 'ignore', 'pipe']});
let stderr = ''; child.stderr.on('data', b => stderr += b);
test.after(async () => { child.kill(); await new Promise(resolve => child.once('exit', resolve)); await rm(stage, {recursive: true, force: true}); });
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); if (i === 99) throw Error(stderr); }

const withCheck = v => v.slice(0, 8) + validateVin(v).checksum.expected + v.slice(9);
const timed = async url => { const t = Date.now(); const res = await fetch(base + url); return {res, body: await res.json(), ms: Date.now() - t}; };

test('REST: a first report answers before the slow maker, pending with status_url; the status and the next report are complete', async () => {
  const vin = withCheck('1FTEX1EP0FFD06901');
  const first = await timed('/api/vin/' + vin);
  assert.equal(first.res.status, 200);
  assert.ok(first.ms < FORD_DELAY - 200, `first report in ${first.ms} ms`);
  const s = first.body.recall_status;
  assert.deepEqual([s.pending, s.available, s.reason, s.open_count, s.completed_count, s.maker], [true, false, 'lookup_in_progress', null, null, 'Ford']);
  assert.equal(s.status_url, `/api/vin/${vin}/recall-status`);
  assert.equal(first.body.decode_checks.sources.manufacturer_record.status, 'pending');
  const c = first.body.complaints;
  assert.deepEqual([c.pending, c.available, c.count, c.status_url], [true, false, null, `/api/vin/${vin}/complaints`]);
  // Each status_url waits for the request already running (no new 2.6 s wait from the start).
  const [status, complaints] = await Promise.all([timed(s.status_url), timed(c.status_url)]);
  assert.equal(complaints.res.status, 200);
  assert.deepEqual([complaints.body.available, complaints.body.count, complaints.body.pending], [true, 0, undefined]);
  assert.ok(first.ms + complaints.ms < FORD_DELAY + 1500, `complaints after ${first.ms + complaints.ms} ms in all`);
  assert.equal(status.res.status, 200);
  assert.equal(status.body.available, true);
  assert.equal(status.body.open_count, 1);
  assert.ok(first.ms + status.ms < FORD_DELAY + 1500, `status after ${first.ms + status.ms} ms in all`);
  const again = await timed('/api/vin/' + vin);
  assert.equal(again.body.recall_status.available, true);
  assert.equal(again.body.recall_status.pending, undefined);
  assert.equal(again.body.complaints.available, true);
  assert.ok(again.ms < 1000, `cached report in ${again.ms} ms`);
});

test('REST: ?recall_wait=full waits for the maker; other values are refused', async () => {
  const vin = withCheck('1FTEX1EP0FFD06902');
  assert.equal((await fetch(base + '/api/vin/' + vin + '?recall_wait=later')).status, 400);
  const full = await timed('/api/vin/' + vin + '?recall_wait=full');
  assert.equal(full.body.recall_status.available, true);
  assert.equal(full.body.recall_status.completed_count, 1);
  assert.ok(full.ms >= FORD_DELAY - 100, `waited ${full.ms} ms`);
});

test('MCP: decode_vin waits up to 6 s, so this maker is complete; vin_recall_status joins a running lookup', async () => {
  const client = new Client({name: 'slow-maker-test', version: '1'}), transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'));
  try {
    await client.connect(transport);
    const vin = withCheck('1FTEX1EP0FFD06903');
    const r = JSON.parse((await client.callTool({name: 'decode_vin', arguments: {vin}})).content[0].text);
    assert.equal(r.recall_status.available, true);
    assert.equal(r.recall_status.open_count, 1);
    assert.equal(r.complaints.available, true, 'the complaint list arrived within the 6 s too');
    // A website report leaves the lookup running; vin_recall_status gets its answer.
    const other = withCheck('1FTEX1EP0FFD06904');
    const site = await timed('/api/vin/' + other);
    assert.equal(site.body.recall_status.pending, true);
    const t = Date.now();
    const status = JSON.parse((await client.callTool({name: 'vin_recall_status', arguments: {vin: other}})).content[0].text);
    assert.equal(status.available, true);
    assert.ok(Date.now() - t < FORD_DELAY, 'joined the running lookup');
  } finally { await transport.terminateSession(); await client.close(); }
});

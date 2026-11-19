// A first-time report must not wait on NHTSA's complaint list (lib/reports.mjs COMPLAINTS_WAIT_MS), and it never
// waits on a manufacturer: mcp.vin does not ask one about a VIN (2026-11-18), so recall_status is a link block that
// is never pending. NHTSA is a stubbed fetch: no live request is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fullReport, baseReport, mcpReport, vinRecallStatusFor, modelYearComplaints, COMPLAINTS_WAIT_MS } from '../lib/reports.mjs';
import { vehicleTools } from '../lib/mcp/vehicle-tools.mjs';
import { vinCache, recallCache, ratingCache, fuelCache, complaintCache } from '../lib/cache.mjs';
import { validateVin } from '../lib/validate.mjs';

const withCheck = v => v.slice(0, 8) + validateVin(v).checksum.expected + v.slice(9);
let serial = 100;
const nextFordVin = () => withCheck(`1FTEX1EP0FFD06${serial++}`);

// NHTSA, EPA and Transport Canada answer at once with a Ford decode and no campaigns. Any other host is refused.
function stubNhtsa() {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = String(url), host = new URL(u).hostname;
    if (!/(^|\.)(nhtsa\.gov|nhtsa\.dot\.gov|fueleconomy\.gov)$/.test(host)) throw new Error('test: refused request to ' + host);
    if (u.includes('DecodeVinValues')) {
      const vin = decodeURIComponent(u.split('/').at(-1).split('?')[0]);
      return Response.json({Results: [{VIN: vin, Make: 'FORD', Model: 'F-150', ModelYear: '2015'}]});
    }
    if (u.includes('SafetyRatings')) return Response.json({Results: []});
    if (u.includes('fueleconomy')) return Response.json(null);
    return Response.json({results: []});
  };
  return () => { globalThis.fetch = original; };
}

function setup(t) {
  [vinCache, recallCache, ratingCache, fuelCache, complaintCache].forEach(c => c.clear());
  const restoreFetch = stubNhtsa();
  t.after(() => { restoreFetch(); [vinCache, recallCache, ratingCache, fuelCache, complaintCache].forEach(c => c.clear()); });
}

test('the complaints budget is 2 s for the website and REST, 6 s for MCP', () => {
  assert.deepEqual({...COMPLAINTS_WAIT_MS}, {report: 2000, mcp: 6000});
  assert.ok(Object.isFrozen(COMPLAINTS_WAIT_MS));
});

test('recall_status is the link block at once: never pending, counts null, Ford page with the VIN', async t => {
  setup(t);
  const vin = nextFordVin();
  const r = await fullReport(vin);
  const s = r.recall_status;
  assert.equal(s.pending, undefined);
  assert.deepEqual([s.available, s.reason, s.maker, s.vin_prefilled, s.open_count, s.completed_count], [false, 'manufacturer_link_only', 'Ford', true, null, null]);
  assert.equal(s.manufacturer_lookup_url, `https://www.ford.com/support/recalls-details/${vin}/`);
  assert.deepEqual(await vinRecallStatusFor(vin), s, 'the recall-status endpoint returns the same block');
  assert.equal(r.provenance.recall_status.includes('does not check'), true);
});

test('MCP decode_vin has no recall_wait argument and describes the links; an old recall_wait is dropped', async t => {
  setup(t);
  let decodeVin, schema;
  vehicleTools((name, description, inputSchema, handler) => { if (name === 'decode_vin') { decodeVin = handler; schema = {description, inputSchema}; } });
  assert.equal(schema.inputSchema.recall_wait, undefined);
  assert.match(schema.description, /does not check a VIN\'s recall repairs/);
  assert.doesNotMatch(schema.description, /pending true: unknown, not "no open recalls"|recall_wait/);
  const vin = nextFordVin();
  const out = JSON.parse((await decodeVin({vin, recall_wait: 'full'})).content[0].text);
  assert.equal(out.recall_status.reason, 'manufacturer_link_only');
  assert.equal(out.recall_status.next_step, undefined);
  assert.equal(out.decode_checks?.sources?.manufacturer_record, undefined);
});

// ---- NHTSA's complaint list (a common model's takes 5-17 s) ----

/** NHTSA's complaints answer when the test calls release() (or fail when `fail`); everything else at once. */
function gatedComplaints(t, {fail = false} = {}) {
  const calls = [];
  let open;
  const gate = new Promise(resolve => { open = resolve; });
  const before = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('complaintsByVehicle')) return before(url, opts);
    calls.push(String(url));
    await gate;
    if (fail) throw new Error('The operation was aborted due to timeout');
    return Response.json({results: [
      {odiNumber: 11000001, dateComplaintFiled: '03/02/2024', components: 'ENGINE', summary: 'Stalled', crash: 'NO', fire: 'NO', numberOfInjuries: 0, numberOfDeaths: 0},
      {odiNumber: 11000002, dateComplaintFiled: '04/05/2024', components: 'BRAKES', summary: 'Long stop', crash: 'YES', fire: 'NO', numberOfInjuries: 1, numberOfDeaths: 0}]});
  };
  // A request still held at the end is let go (and settles) before the next test clears the caches.
  t.after(async () => { open(); await new Promise(resolve => setTimeout(resolve, 20)); globalThis.fetch = before; });
  return {calls, release: () => open()};
}

test('slow NHTSA complaints: the report answers with complaints pending (unknown, not zero); the next report has them', async t => {
  setup(t);
  const nhtsa = gatedComplaints(t);
  const vin = nextFordVin();
  const first = await fullReport(vin, {complaintsWaitMs: 100});
  const c = first.complaints;
  assert.deepEqual([c.pending, c.available, c.reason, c.count, c.summary], [true, false, 'lookup_in_progress', null, null]);
  assert.deepEqual(c.complaints, []);
  assert.equal(c.status_url, `/api/vin/${vin}/complaints`);
  assert.match(c.note, /it is not zero/);
  assert.equal(first.recall_status.reason, 'manufacturer_link_only', 'the rest of the report is complete');
  assert.equal(vinCache.get(vin), undefined, 'a report without its complaints is not cached');
  // The server-rendered VIN page (baseReport) does not wait for the complaints either.
  const page = await baseReport(vin);
  assert.equal(page.complaints.pending, true);
  // The request keeps running; /api/vin/{vin}/complaints (modelYearComplaints) joins it.
  const joined = modelYearComplaints('FORD', 'F-150', '2015');
  nhtsa.release();
  const list = await joined;
  assert.equal(list.count, 2);
  assert.equal(nhtsa.calls.length, 1, 'one request to NHTSA for every caller');
  await new Promise(resolve => setTimeout(resolve, 20));
  const cached = vinCache.get(vin);
  assert.equal(cached?.complaints, list, 'the complete report is cached once the complaints arrive');
  const second = await fullReport(vin, {complaintsWaitMs: 0});
  assert.equal(second.complaints.count, 2);
  assert.equal(second.complaints.summary.crashes, 1);
  assert.equal(second.complaints.pending, undefined);
  assert.equal(nhtsa.calls.length, 1);
  assert.equal(Object.keys(second).indexOf('complaints'), Object.keys(second).indexOf('recalls') + 1, 'the block keeps its place in the report');
});

test('complaints that arrive within the budget are in the report; a report never waits for a maker', async t => {
  setup(t);
  const nhtsa = gatedComplaints(t);
  const vin = nextFordVin();
  setTimeout(() => nhtsa.release(), 150);
  const r = await fullReport(vin, {complaintsWaitMs: 2000});
  assert.equal(r.complaints.available, true);
  assert.equal(r.complaints.count, 2);
  // There is no maker lookup to wait for: a report never waits longer than its complaints budget.
  [vinCache, complaintCache].forEach(c => c.clear());
  gatedComplaints(t);
  const started = Date.now();
  const quick = await fullReport(nextFordVin(), {complaintsWaitMs: 50});
  assert.ok(Date.now() - started < 1500, 'answered within the complaints budget');
  assert.equal(quick.complaints.pending, true);
  assert.equal(quick.recall_status.reason, 'manufacturer_link_only');
});

test('a complaint request that fails in the background is contained and not cached; the next report asks again', async t => {
  setup(t);
  const unhandled = [];
  const onUnhandled = err => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const nhtsa = gatedComplaints(t, {fail: true});
  const vin = nextFordVin();
  const first = await fullReport(vin, {complaintsWaitMs: 20});
  assert.equal(first.complaints.pending, true);
  nhtsa.release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(unhandled, []);
  assert.equal(vinCache.get(vin), undefined);
  const second = await fullReport(vin, {complaintsWaitMs: Infinity});
  assert.equal(second.complaints.available, false);
  assert.equal(second.complaints.pending, undefined);
  assert.equal(second.complaints.count, null);
  assert.equal(nhtsa.calls.length, 2, 'a failure is not cached');
});

test('MCP: pending complaints say unknown, not zero, and how to get them', async t => {
  setup(t);
  gatedComplaints(t);
  const r = mcpReport(await fullReport(nextFordVin(), {complaintsWaitMs: 10}));
  assert.equal(r.complaints.pending, true);
  assert.equal(r.complaints.count, null);
  assert.deepEqual(r.complaints.recent, []);
  assert.equal(r.complaints.complaints, undefined);
  assert.match(r.complaints.note, /unknown here, not zero/);
  assert.match(r.complaints.note, /call decode_vin again/);
});

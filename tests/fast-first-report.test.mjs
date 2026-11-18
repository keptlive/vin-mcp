// A first-time report must not wait on a slow manufacturer recall lookup or on NHTSA's complaint list
// (lib/reports.mjs RECALL_WAIT_MS). The maker's lookup is a stub request passed to createRecallStatusLookup and
// NHTSA is a stubbed fetch: no live request is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fullReport, baseReport, mcpReport, useRecallStatusLookup, vinRecallStatusFor, pendingRecallStatus, modelYearComplaints, RECALL_WAIT_MS } from '../lib/reports.mjs';
import { createRecallStatusLookup, recallLookupInfo } from '../lib/recall-status.mjs';
import { vehicleTools } from '../lib/mcp/vehicle-tools.mjs';
import { vinCache, recallCache, ratingCache, fuelCache, complaintCache } from '../lib/cache.mjs';
import { validateVin } from '../lib/validate.mjs';
import { fordPage, fordState } from './manufacturer-fixtures.mjs';

const withCheck = v => v.slice(0, 8) + validateVin(v).checksum.expected + v.slice(9);
let serial = 100;
const nextFordVin = () => withCheck(`1FTEX1EP0FFD06${serial++}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// NHTSA, EPA and Transport Canada answer at once with a Ford decode and no campaigns.
function stubNhtsa() {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = String(url);
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

/**
 * A Ford lookup counting its requests. Its page answers after `delay` ms, or, without a delay, when the test calls
 * release(): a gate, so the outcome does not depend on how busy the machine is. `fail`: the request fails instead.
 * `requested`: resolves when the first request is made; `answered`: when the stub has answered (or failed).
 */
function slowFord({delay = null, fail = false} = {}) {
  const calls = [];
  let open, started, finished;
  const gate = delay === null ? new Promise(resolve => { open = resolve; }) : null;
  const requested = new Promise(resolve => { started = resolve; }), answered = new Promise(resolve => { finished = resolve; });
  const lookup = createRecallStatusLookup(async url => {
    calls.push(url); started(Date.now());
    try {
      await (gate || sleep(delay));
      if (fail) throw new Error('socket hang up');
      const vin = new URL(url).pathname.split('/').filter(Boolean).at(-1);
      const page = fordPage(fordState(vin));
      return {ok: true, text: async () => page, json: async () => JSON.parse(page)};
    } finally { finished(); }
  });
  return {lookup, calls, release: () => open(), requested, answered};
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20)); // let catch handlers and unhandledRejection run

function setup(t, lookup) {
  [vinCache, recallCache, ratingCache, fuelCache, complaintCache].forEach(c => c.clear());
  const restoreFetch = stubNhtsa(), previous = useRecallStatusLookup(lookup);
  t.after(() => { restoreFetch(); useRecallStatusLookup(previous); [vinCache, recallCache, ratingCache, fuelCache, complaintCache].forEach(c => c.clear()); });
}

test('the website and REST budget is 2 s and MCP\'s 6 s, counted from the lookup start', () => {
  assert.equal(RECALL_WAIT_MS.report, 2000);
  assert.equal(RECALL_WAIT_MS.mcp, 6000);
  const info = recallLookupInfo('1FTEX1EP4FFD06976');
  assert.deepEqual([info.provider, info.maker, info.name, info.network, info.by_wmi], ['ford', 'Ford', 'Ford Owner Support VIN Recalls', true, true]);
  assert.equal(recallLookupInfo(withCheck('1ZVFT80N055124042'), 'FORD').by_wmi, false); // Mustang (AutoAlliance WMI): by make
  assert.equal(recallLookupInfo(withCheck('1ZVFT80N055124042'), 'FORD').provider, 'ford');
});

test('a slow maker lookup: the report answers with recall_status pending, then the background lookup fills the cache', async t => {
  const ford = slowFord();
  setup(t, ford.lookup);
  const vin = nextFordVin();
  const first = await fullReport(vin, {recallWaitMs: 150}); // the maker has not answered (gate closed)
  const s = first.recall_status;
  assert.equal(s.pending, true);
  assert.equal(s.available, false);
  assert.equal(s.reason, 'lookup_in_progress');
  assert.equal(s.open_count, null, 'unknown, never "no open recalls"');
  assert.equal(s.completed_count, null);
  assert.deepEqual(s.recalls, []);
  assert.equal(s.maker, 'Ford');
  assert.equal(s.source.provider, 'Ford Owner Support VIN Recalls');
  assert.equal(s.status_url, `/api/vin/${vin}/recall-status`);
  assert.equal(s.waited_ms, 150);
  assert.match(s.verification_url, /^https:\/\/www\.ford\.com\/support\/recalls-details\//);
  assert.match(s.note, /not "no open recalls"/);
  assert.equal(first.decode_checks.sources.manufacturer_record.status, 'pending');
  assert.equal(first.decode_checks.sources.manufacturer_record.maker, 'Ford');
  assert.equal(ford.calls.length, 1, 'the lookup started once');
  // The lookup keeps running in the background and fills the 15-minute cache.
  ford.release();
  await ford.answered; await settle();
  const second = await fullReport(vin, {recallWaitMs: 0});
  assert.equal(second.recall_status.available, true);
  assert.equal(second.recall_status.pending, undefined);
  assert.equal(second.recall_status.open_count, 1);
  assert.equal(second.decode_checks.sources.manufacturer_record.status, 'not_available');
  assert.equal(ford.calls.length, 1, 'no second request to the maker');
  // The same full report object is reused while the base report and the maker's result are cached.
  assert.equal(await fullReport(vin, {recallWaitMs: 0}), second);
});

test('the lookup starts right after the decode, beside NHTSA\'s calls (not after them)', async t => {
  const ford = slowFord({delay: 50});
  setup(t, ford.lookup);
  // NHTSA's recall lookup answers only once the maker's request has started (or after 3 s): in the old order (maker
  // after the NHTSA calls) the maker's request would start after NHTSA answered.
  const restore = globalThis.fetch;
  let recallsAnswered = null;
  globalThis.fetch = async url => {
    if (String(url).includes('recallsByVehicle')) { await Promise.race([ford.requested, sleep(3000)]); recallsAnswered ??= Date.now(); }
    return restore(url);
  };
  const r = await fullReport(nextFordVin(), {recallWaitMs: Infinity});
  const makerStarted = await ford.requested;
  assert.equal(r.recall_status.available, true);
  assert.ok(recallsAnswered !== null && makerStarted <= recallsAnswered, `maker request at ${makerStarted}, NHTSA recalls answered at ${recallsAnswered}`);
});

test('concurrent reports share one maker lookup, and the recall-status endpoint joins it', async t => {
  const ford = slowFord();
  setup(t, ford.lookup);
  const vin = nextFordVin();
  const [a, b] = await Promise.all([fullReport(vin, {recallWaitMs: 50}), fullReport(vin.toLowerCase(), {recallWaitMs: 50})]);
  assert.equal(a.recall_status.pending, true);
  assert.equal(b.recall_status.pending, true);
  const joined = vinRecallStatusFor(vin); // what GET status_url and MCP vin_recall_status run
  ford.release();
  const status = await joined;
  assert.equal(status.available, true);
  assert.equal(status.open_count, 1);
  assert.equal(ford.calls.length, 1);
  const full = await fullReport(vin, {recallWaitMs: Infinity});
  assert.equal(full.recall_status, status);
  assert.equal(ford.calls.length, 1);
});

test('a background lookup that fails is contained: no unhandled rejection, then unknown (not pending, not zero)', async t => {
  const ford = slowFord({fail: true});
  setup(t, ford.lookup);
  const unhandled = [];
  const onUnhandled = err => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const vin = nextFordVin();
  const first = await fullReport(vin, {recallWaitMs: 20});
  assert.equal(first.recall_status.pending, true);
  ford.release();
  await ford.answered; await settle();
  assert.deepEqual(unhandled, []);
  const second = await fullReport(vin, {recallWaitMs: Infinity});
  assert.equal(second.recall_status.available, false);
  assert.equal(second.recall_status.reason, 'upstream_unavailable');
  assert.equal(second.recall_status.open_count, null);
  assert.equal(second.recall_status.pending, undefined);
  assert.equal(ford.calls.length, 2, 'a failure is not cached: the next report asks again');

  // A lookup function that throws (not only one that returns a failure) is contained the same way.
  let open;
  const gate = new Promise(resolve => { open = resolve; });
  useRecallStatusLookup(async () => { await gate; throw new Error('boom'); });
  const thrown = await fullReport(nextFordVin(), {recallWaitMs: 10});
  assert.equal(thrown.recall_status.pending, true);
  open(); await settle();
  assert.deepEqual(unhandled, []);
  const after = await fullReport(nextFordVin(), {recallWaitMs: Infinity});
  assert.equal(after.recall_status.available, false);
  assert.equal(after.recall_status.reason, 'upstream_unavailable');
});

test('makers that answer at once never show pending', async t => {
  const calls = [];
  setup(t, createRecallStatusLookup(async url => { calls.push(url); throw new Error('no request expected'); }));
  const toyota = withCheck('4T1BF1FK0CU123456');
  const restore = globalThis.fetch;
  globalThis.fetch = async url => String(url).includes('DecodeVinValues')
    ? Response.json({Results: [{VIN: toyota, Make: 'TOYOTA', Model: 'Camry', ModelYear: '2012'}]}) : restore(url);
  const r = await fullReport(toyota, {recallWaitMs: 0});
  assert.equal(r.recall_status.reason, 'interactive_verification_required');
  assert.equal(r.recall_status.pending, undefined);
  assert.deepEqual(calls, []);
});

test('MCP decode_vin waits longer (6 s) than the website, offers recall_wait "full", and points to vin_recall_status', async t => {
  // 3 s: past the website's 2 s, within MCP's 6 s.
  const {lookup, calls} = slowFord({delay: 3000});
  setup(t, lookup);
  let decodeVin, schema;
  vehicleTools((name, description, inputSchema, handler) => { if (name === 'decode_vin') { decodeVin = handler; schema = {description, inputSchema}; } });
  assert.ok(schema.inputSchema.recall_wait, 'recall_wait argument');
  assert.match(schema.description, /recall_status\.pending/);
  assert.match(schema.description, /vin_recall_status/);
  const vin = nextFordVin();
  // The website's budget (2 s) runs out; MCP's 6 s does not.
  const [site, mcp] = await Promise.all([fullReport(vin), decodeVin({vin}).then(r => JSON.parse(r.content[0].text))]);
  assert.equal(site.recall_status.pending, true);
  assert.equal(mcp.recall_status.available, true);
  assert.equal(mcp.recall_status.open_count, 1);
  assert.equal(calls.length, 1);
  // A pending status in MCP output names the next tool call.
  const pending = mcpReport({...site, recall_status: pendingRecallStatus(vin, 'FORD', RECALL_WAIT_MS.mcp)});
  assert.equal(pending.recall_status.pending, true);
  assert.deepEqual(pending.recall_status.next_step, {tool: 'vin_recall_status', arguments: {vin}});
  assert.match(pending.recall_status.note, /call vin_recall_status/);
  assert.match(pending.recall_status.note, /after 6\.0 s/);
  assert.equal(pending.decode_checks.sources.manufacturer_record, 'pending');
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
  const ford = slowFord({delay: 0});
  setup(t, ford.lookup);
  const nhtsa = gatedComplaints(t);
  const vin = nextFordVin();
  const first = await fullReport(vin, {complaintsWaitMs: 100});
  const c = first.complaints;
  assert.deepEqual([c.pending, c.available, c.reason, c.count, c.summary], [true, false, 'lookup_in_progress', null, null]);
  assert.deepEqual(c.complaints, []);
  assert.equal(c.status_url, `/api/vin/${vin}/complaints`);
  assert.match(c.note, /it is not zero/);
  assert.equal(first.recall_status.available, true, 'the rest of the report is complete');
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

test('complaints that arrive within the budget are in the report; a longer recall wait picks up later ones', async t => {
  const ford = slowFord({delay: 0});
  setup(t, ford.lookup);
  const nhtsa = gatedComplaints(t);
  const vin = nextFordVin();
  setTimeout(() => nhtsa.release(), 150);
  const r = await fullReport(vin, {complaintsWaitMs: 2000});
  assert.equal(r.complaints.available, true);
  assert.equal(r.complaints.count, 2);
  // Waiting past the complaints budget for the recall status includes complaints that arrived meanwhile.
  [vinCache, complaintCache].forEach(c => c.clear());
  const late = gatedComplaints(t), slow = slowFord();
  useRecallStatusLookup(slow.lookup);
  const report = fullReport(nextFordVin(), {recallWaitMs: Infinity, complaintsWaitMs: 0});
  await slow.requested; late.release(); await new Promise(resolve => setTimeout(resolve, 20)); slow.release();
  const both = await report;
  assert.equal(both.recall_status.available, true);
  assert.equal(both.complaints.count, 2);
});

test('a complaint request that fails in the background is contained and not cached; the next report asks again', async t => {
  const ford = slowFord({delay: 0});
  setup(t, ford.lookup);
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
  const ford = slowFord({delay: 0});
  setup(t, ford.lookup);
  gatedComplaints(t);
  const r = mcpReport(await fullReport(nextFordVin(), {complaintsWaitMs: 10}));
  assert.equal(r.complaints.pending, true);
  assert.equal(r.complaints.count, null);
  assert.deepEqual(r.complaints.recent, []);
  assert.equal(r.complaints.complaints, undefined);
  assert.match(r.complaints.note, /unknown here, not zero/);
  assert.match(r.complaints.note, /call decode_vin again/);
});

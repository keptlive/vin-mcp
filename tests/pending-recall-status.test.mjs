// The website while the maker's VIN recall lookup is still answering (recall_status.pending, lib/reports.mjs):
// "Checking with Ford…" on screen, never printed as if final, then filled in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {VinClient} from '../public/client.mjs';

const pending = {vin: '1FTEX1EP4FFD06976', scope: 'vin', vin_specific: true, available: false, pending: true, reason: 'lookup_in_progress', maker: 'Ford',
  waited_ms: 2000, source: {provider: 'Ford Owner Support VIN Recalls', reference_url: 'https://www.ford.com/support/recalls-details/1FTEX1EP4FFD06976/'},
  verification_url: 'https://www.ford.com/support/recalls-details/1FTEX1EP4FFD06976/', open_count: null, completed_count: null, recalls: [],
  status_url: '/api/vin/1FTEX1EP4FFD06976/recall-status', note: 'Ford\'s VIN recall lookup had not answered after 2.0 s.'};
const complete = {vin: '1FTEX1EP4FFD06976', available: true, open_count: 2, completed_count: 1, unknown_count: 0, service_campaign_count: 1,
  verification_url: 'https://www.ford.com/support/recalls-details/1FTEX1EP4FFD06976/', note: 'Official Ford VIN page.',
  source: {provider: 'Ford Owner Support VIN Recalls', retrieved_at: '2026-11-18T15:10:00Z'},
  recalls: [{campaign_number: '22S41', manufacturer_status: 'Recall incomplete (O)', record_kind: 'safety_recall', summary: 'Brake hose'}], service_campaigns: []};
const report = (recall_status, extra = {}) => ({valid: true, vin: '1FTEX1EP4FFD06976', validation: {checksum: {valid: true}},
  vehicle: {year: 2015, make: 'FORD', model: 'F-150', body_class: 'Pickup'}, engine: {displacement_l: 3.5, cylinders: 6}, transmission: {}, raw_nhtsa: {},
  dimensions: {}, recalls: {available: true, count: 3, recalls: []}, complaints: {available: true, count: 0, complaints: []}, safety_ratings: {rated: false},
  fuel_economy: {available: false, reason: 'no_matching_variant'}, provenance: {assembled_at: '2026-11-18T15:09:58Z'},
  decode_checks: {pattern: '1FTEX1EP*FF', fields: [], counts: {}, sources: {manufacturer_record: recall_status.pending ? {status: 'pending', maker: 'Ford'} : {status: 'not_available'}, test_vehicle_pattern: {status: 'none_for_pattern'}}, note: ''},
  recall_status, ...extra});

function loadSheet() {
  const ctx = {console, URLSearchParams, setTimeout};
  vm.createContext(ctx);
  for (const file of ['qr.js', 'decode-checks.js', 'car-sheet.js']) vm.runInContext(readFileSync(new URL('../public/' + file, import.meta.url), 'utf8'), ctx);
  return {sheet: vm.runInContext('CarSheet', ctx), dc: vm.runInContext('DecodeChecks', ctx)};
}
const recallRow = html => html.match(/This VIN’s recall status<\/dt><dd>(.*?)<\/dd>/)[1];
// What reaches paper: screen-only parts (pending-screen, sheet-screen-only) removed; pending-print shown.
const paper = html => html.replace(/<span class="pending-screen[^"]*">(?:[^<]|<span class="sheet-source">[^<]*<\/span>)*<\/span>/g, '')
  .replace(/<span class="sheet-screen-only">[^<]*<\/span>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const screen = html => html.replace(/<span class="pending-print">[^<]*<\/span>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('car sheet: pending shows "Checking with Ford…" on screen and prints that Ford had not answered, never a status', () => {
  const {sheet} = loadSheet();
  const row = recallRow(sheet.html(report(pending)).body);
  assert.match(screen(row), /^Checking with Ford…/);
  assert.match(paper(row), /^Unknown: Ford had not answered when this sheet was printed\./);
  assert.doesNotMatch(paper(row), /Checking/);
  assert.doesNotMatch(paper(row), /\b0 open\b|no open/i);
  assert.match(paper(row), /Check this VIN with the official source/);
  // The footer names the maker as a source only once it has answered.
  assert.doesNotMatch(sheet.html(report(pending)).foot, /Ford Owner Support/);
  const done = sheet.html(report(complete));
  assert.match(recallRow(done.body), /2 open · 1 completed or closed/);
  assert.match(done.foot, /Ford Owner Support VIN Recalls/);
  // Only the recall section differs between the two (the sheet redraws only that one).
  const sections = h => h.match(/<section class="sheet-section [^"]+"/g);
  const a = sheet.html(report(pending)).body.split('</section>'), b = done.body.split('</section>');
  assert.deepEqual(sections(sheet.html(report(pending)).body), sections(done.body));
  assert.deepEqual(a.map((x, i) => x === b[i]), a.map(x => !x.includes('sheet-recalls')));
  // The page could not load the answer: unknown, with why.
  const lost = recallRow(sheet.html(report({...pending, pending: false, reason: 'lookup_not_loaded'})).body);
  assert.match(lost, /^Unknown\. The maker’s answer could not be loaded here; reload the report\./);
});

test('decode checks card: the manufacturer record is "checking with Ford…" on screen and "not loaded when printed" on paper', () => {
  const {dc} = loadSheet();
  const line = dc.sourcesHtml(report(pending));
  assert.match(line, /^<p class="dc-note dc-sources">/);
  assert.match(screen(line), /the manufacturer’s record \(\s*checking with Ford…\s*\)/);
  assert.match(line, /<span class="pending-print">not loaded when printed<\/span>/);
  assert.match(dc.sourcesHtml(report(complete)), /the manufacturer’s record \(not available for this VIN\)/);
  assert.ok(dc.cardHtml(report(pending)).includes(line), 'the card carries the same line');
});

// app.js with a minimal DOM (as tests/regression.test.mjs): render, then the follow-up request fills the status in.
function frontend() {
  const els = new Map();
  const element = () => ({style: {}, dataset: {}, handlers: {}, value: '', classList: {add() {}, remove() {}, toggle() {}}, addEventListener(k, fn) { this.handlers[k] = fn; }, dispatchEvent(e) { return this.handlers[e.type]?.(e); }, setAttribute() {}, focus() {}, setSelectionRange() {}, querySelector() { return element(); }, querySelectorAll() { return []; }, replaceChildren() { this.innerHTML = ''; }, innerHTML: '', textContent: '', hidden: false});
  const document = {createElement: () => ({set textContent(v) { this.innerHTML = String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }}), querySelector: s => { if (!els.has(s)) els.set(s, element()); return els.get(s); }, querySelectorAll: () => [], addEventListener() {}};
  const requests = [];
  const ctx = {document, window: {location: {pathname: '/'}}, navigator: {}, localStorage: {getItem() { return null; }}, console, setTimeout: fn => fn(), addEventListener() {}, requests};
  ctx.fetch = async url => { requests.push(url); return ctx.reply(url); };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), ctx);
  return {ctx, els, run: script => vm.runInContext(script, ctx)};
}

test('web report: pending shows "Checking with Ford…", then the follow-up fills only the status block', async () => {
  const {ctx, els, run} = frontend();
  ctx.first = report(pending);
  run('currentReport = first; renderRecalls(first)');
  const body = els.get('#recalls-body').innerHTML;
  assert.match(body, /<div class="recall-item" id="recall-status-block">/);
  assert.match(body, /Checking with Ford… Its VIN lookup is still answering/);
  assert.match(body, /<p class="pending-print">Not loaded: Ford had not answered when this page was printed/);
  assert.doesNotMatch(body, /0 open recalls/);
  ctx.reply = () => Response.json(report(complete));
  await run('followRecallStatus(currentReport)');
  assert.deepEqual(ctx.requests, ['/api/vin/1FTEX1EP4FFD06976?recall_wait=full']);
  const block = els.get('#recall-status-block').innerHTML;
  assert.match(block, /2 open recalls · 1 manufacturer-reported completed\/closed/);
  assert.match(block, /Ford Owner Support VIN Recalls/);
  assert.equal(els.get('#recalls-body').innerHTML, body, 'the campaign list is not redrawn');
  assert.equal(run('currentReport.recall_status.available'), true);
  assert.equal(run('currentReport.complaints.count'), 0, 'blocks the maker does not touch are kept from the first report');
  assert.match(els.get('#decode-status').textContent, /Ford’s VIN recall status has loaded/);
});

test('web report: if the follow-up fails twice the status says it could not be loaded (unknown), never pending forever', async () => {
  const {ctx, els, run} = frontend();
  ctx.first = report(pending);
  run('currentReport = first; renderRecalls(first)');
  ctx.reply = () => { throw new TypeError('network down'); };
  await run('followRecallStatus(currentReport)');
  assert.equal(ctx.requests.length, 2, 'asked twice');
  const block = els.get('#recall-status-block').innerHTML;
  assert.match(block, /VIN-specific repair status is unavailable\. Ford’s answer could not be loaded/);
  assert.doesNotMatch(block, /Checking/);
  assert.equal(run('currentReport.recall_status.pending'), false);
  assert.match(els.get('#decode-status').textContent, /not available/);
});

test('web report: a follow-up for a VIN no longer shown changes nothing', async () => {
  const {ctx, els, run} = frontend();
  ctx.first = report(pending);
  run('currentReport = first; renderRecalls(first)');
  let release;
  ctx.reply = () => new Promise(resolve => { release = () => resolve(Response.json(report(complete))); });
  const follow = run('followRecallStatus(currentReport)');
  await new Promise(r => setImmediate(r));
  run('currentReport = null');
  release();
  await follow;
  assert.ok(!els.has('#recall-status-block'), 'nothing was redrawn');
  assert.ok(!els.has('#decode-status'));
});

test('VinClient.decode asks for the full wait only when told to', async () => {
  const seen = [];
  const client = new VinClient({baseUrl: 'http://localhost:3298', fetchImpl: async url => { seen.push(url); return new Response('{}'); }});
  await client.decode('1FTEX1EP4FFD06976');
  await client.decode('1FTEX1EP4FFD06976', {recallWait: 'full'});
  assert.deepEqual(seen, ['http://localhost:3298/api/vin/1FTEX1EP4FFD06976', 'http://localhost:3298/api/vin/1FTEX1EP4FFD06976?recall_wait=full']);
});

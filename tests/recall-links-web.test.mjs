// The website's recall block (lib/recall-links.mjs via the report's recall_status) and NHTSA's complaint list
// arriving after the report (complaints.pending). mcp.vin does not check a VIN's recall repairs: the card, the car
// sheet and print show NHTSA's campaigns, then links to the maker's page and NHTSA's, never a status or "Checking…".
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {VinClient} from '../public/client.mjs';
import {recallStatusFor} from '../lib/recall-links.mjs';

const FORD = '1FTEX1EP4FFD06976', TOYOTA = '4T1BF1FK0CU123456', VOLVO = 'YV1MS382662123456';
const links = recallStatusFor(FORD, 'FORD');
const report = (recall_status, extra = {}) => ({valid: true, vin: recall_status.vin || FORD, validation: {checksum: {valid: true}},
  vehicle: {year: 2015, make: 'FORD', model: 'F-150', body_class: 'Pickup'}, engine: {displacement_l: 3.5, cylinders: 6}, transmission: {}, raw_nhtsa: {},
  dimensions: {}, recalls: {available: true, count: 3, recalls: []}, complaints: {available: true, count: 0, complaints: []}, safety_ratings: {rated: false},
  fuel_economy: {available: false, reason: 'no_matching_variant'}, provenance: {assembled_at: '2026-11-18T15:09:58Z'},
  decode_checks: {pattern: '1FTEX1EP*FF', fields: [], counts: {}, sources: {rule_fixes: {status: 'none_for_vin'}, test_vehicle_pattern: {status: 'none_for_pattern'}}, note: ''},
  recall_status, ...extra});

function loadSheet() {
  const ctx = {console, URLSearchParams, setTimeout};
  vm.createContext(ctx);
  for (const file of ['qr.js', 'decode-checks.js', 'car-sheet.js']) vm.runInContext(readFileSync(new URL('../public/' + file, import.meta.url), 'utf8'), ctx);
  return {sheet: vm.runInContext('CarSheet', ctx), dc: vm.runInContext('DecodeChecks', ctx)};
}
const recallRow = html => html.match(/This VIN’s recall repairs<\/dt><dd>(.*?)<\/dd>/)[1];
// What reaches paper: screen-only parts removed, print-only parts kept.
const paper = html => html.replace(/<span class="pending-screen[^"]*">(?:[^<]|<span class="sheet-source">[^<]*<\/span>)*<\/span>/g, '')
  .replace(/<span class="sheet-screen-only">(?:[^<]|<a [^>]*>[^<]*<\/a>|<span class="sheet-source">[^<]*<\/span>)*<\/span>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const screen = html => html.replace(/<span class="(?:pending-print|sheet-print-only)">[^<]*<\/span>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('car sheet: links on screen, "Not checked by mcp.vin" and where to check on paper, never a status', () => {
  const {sheet} = loadSheet();
  const ford = recallRow(sheet.html(report(links)).body);
  assert.match(ford, /<a href="https:\/\/www\.ford\.com\/support\/recalls-details\/1FTEX1EP4FFD06976\/" target="_blank" rel="noopener">Check this VIN on Ford’s recall page<\/a>/);
  assert.match(ford, /<a href="https:\/\/www\.nhtsa\.gov\/recalls\?vin=1FTEX1EP4FFD06976" target="_blank" rel="noopener">Check on NHTSA<\/a>/);
  assert.match(screen(ford), /only the maker or NHTSA can say whether this car’s repairs are done/);
  assert.equal(paper(ford), 'Not checked by mcp.vin. Check at ford.com/support/recalls or nhtsa.gov/recalls.');
  const toyota = recallRow(sheet.html(report(recallStatusFor(TOYOTA, 'TOYOTA'))).body);
  assert.match(screen(toyota), /Check this VIN on Toyota’s recall page \(enter the VIN there\)/);
  assert.equal(paper(toyota), 'Not checked by mcp.vin. Check at toyota.com/recall or nhtsa.gov/recalls.');
  const volvo = recallRow(sheet.html(report(recallStatusFor(VOLVO, 'VOLVO'))).body);
  assert.doesNotMatch(volvo, /recall page/);
  assert.match(volvo, /Check on NHTSA/);
  assert.equal(paper(volvo), 'Not checked by mcp.vin. Check at nhtsa.gov/recalls.');
  for (const row of [ford, toyota, volvo]) assert.doesNotMatch(row, /Checking|open recall|completed|\b0\b/);
});

test('car sheet footer: no manufacturer source, and the independence line', () => {
  const {sheet} = loadSheet();
  const all = JSON.stringify(sheet.html(report(links)));
  assert.doesNotMatch(all, /Ford Owner Support|VIN Recalls|maker records/);
  assert.match(all, /not affiliated with NHTSA, EPA, Transport Canada or any maker/);
});

test('decode checks card: no manufacturer record anywhere in its code', () => {
  assert.doesNotMatch(readFileSync(new URL('../public/decode-checks.js', import.meta.url), 'utf8'), /manufacturer_record|manufacturer_vin_record|checking with/i);
});

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

test('web report: the recall card lists the campaigns, then Ford\'s page and NHTSA\'s, with one honest sentence', () => {
  const {els, run, ctx} = frontend();
  ctx.first = report(links);
  run('currentReport = first; renderRecalls(first)');
  const body = els.get('#recalls-body').innerHTML;
  assert.ok(body.indexOf('Model-year recall campaigns') < body.indexOf('id="recall-status-block"'), 'campaigns first');
  assert.match(body, /<a class="button-link recall-check-btn" href="https:\/\/www\.ford\.com\/support\/recalls-details\/1FTEX1EP4FFD06976\/" target="_blank" rel="noopener">Check this VIN on Ford’s recall page<\/a>/);
  assert.match(body, /<a class="button-link recall-check-btn secondary" href="https:\/\/www\.nhtsa\.gov\/recalls\?vin=1FTEX1EP4FFD06976" target="_blank" rel="noopener">Check on NHTSA<\/a>/);
  assert.match(body, /mcp\.vin shows the model year’s campaigns above\. Only the maker or NHTSA can say whether this exact car’s repairs are done\./);
  assert.match(body, /<p class="rc-print recall-check-print">Not checked by mcp\.vin\. Check this VIN at ford\.com\/support\/recalls or nhtsa\.gov\/recalls\.<\/p>/);
  assert.doesNotMatch(body, /Checking with|Copy VIN|open recalls|completed/);
  assert.deepEqual(ctx.requests, [], 'nothing is fetched for the recall block');
});

test('web report: a page that does not take the VIN gets a Copy VIN button; an unlisted make gets NHTSA only', () => {
  const {els, run, ctx} = frontend();
  ctx.first = report(recallStatusFor(TOYOTA, 'TOYOTA'));
  run('currentReport = first; renderRecalls(first)');
  let body = els.get('#recalls-body').innerHTML;
  assert.match(body, /href="https:\/\/www\.toyota\.com\/recall\/"[^>]*>Check this VIN on Toyota’s recall page<\/a>/);
  assert.match(body, /Toyota’s page does not take the VIN from a link: enter <code>4T1BF1FK0CU123456<\/code> there\. <button type="button" class="recall-copy" data-copy="4T1BF1FK0CU123456">Copy VIN<\/button>/);
  ctx.first = report(recallStatusFor(VOLVO, 'VOLVO'));
  run('currentReport = first; renderRecalls(first)');
  body = els.get('#recalls-body').innerHTML;
  assert.doesNotMatch(body, /recall page/);
  assert.match(body, /<a class="button-link recall-check-btn" href="https:\/\/www\.nhtsa\.gov\/recalls\?vin=YV1MS382662123456"[^>]*>Check on NHTSA<\/a>/);
  assert.match(body, /Check this VIN at nhtsa\.gov\/recalls\./);
});

test('VinClient.decode never asks to wait for a maker; recallStatus reads the link block', async () => {
  const seen = [];
  const client = new VinClient({baseUrl: 'http://localhost:3298', fetchImpl: async url => { seen.push(url); return new Response('{}'); }});
  await client.decode(FORD);
  await client.decode(FORD, {recallWait: 'full'});
  await client.recallStatus(FORD);
  assert.deepEqual(seen, ['http://localhost:3298/api/vin/' + FORD, 'http://localhost:3298/api/vin/' + FORD, 'http://localhost:3298/api/vin/' + FORD + '/recall-status']);
});

// ---- NHTSA's complaint list arriving after the report (complaints.pending) ----
const pendingComplaints = {available: false, pending: true, reason: 'lookup_in_progress', scope: 'make_model_year', count: null, complaints: [], summary: null,
  status_url: '/api/vin/1FTEX1EP4FFD06976/complaints', note: 'not zero'};
const complaintList = {available: true, scope: 'make_model_year', count: 2, summary: {crashes: 1, fires: 0, injuries: 1, deaths: 0},
  complaints: [{odi_number: '1', date_complaint_filed: '03/02/2024', component: 'ENGINE', summary: 'Stalled'}, {odi_number: '2', date_complaint_filed: '04/05/2024', component: 'BRAKES', summary: 'Long stop', crash: true}]};

test('car sheet and complaints card: pending complaints are "loading" on screen and "not loaded" on paper, never zero', () => {
  const {sheet} = loadSheet();
  const row = html => html.match(/Owner complaints to NHTSA<\/dt><dd>(.*?)<\/dd>/)[1];
  const pendingRow = row(sheet.html(report(links, {complaints: pendingComplaints})).body);
  assert.match(screen(pendingRow), /^Loading from NHTSA…/);
  assert.match(paper(pendingRow), /^Unknown: NHTSA's list had not arrived when this sheet was printed\./);
  assert.doesNotMatch(paper(pendingRow), /\b0\b|Loading/);
  assert.match(row(sheet.html(report(links, {complaints: complaintList})).body), /^2 for this model year/);
  assert.match(row(sheet.html(report(links, {complaints: {...pendingComplaints, pending: false, reason: 'lookup_not_loaded'}})).body), /^Unknown \(could not be loaded here; reload the report\)/);
});

test('web report: pending complaints show "Loading…", then /complaints fills the card in place', async () => {
  const {ctx, els, run} = frontend();
  ctx.first = report(links, {complaints: pendingComplaints});
  run('currentReport = first; renderComplaints(first)');
  assert.equal(els.get('#complaint-count').textContent, '…');
  assert.match(els.get('#complaints-body').innerHTML, /Loading NHTSA’s owner complaints…/);
  assert.match(els.get('#complaints-body').innerHTML, /<p class="pending-print">Not loaded: NHTSA’s complaint list had not arrived when this page was printed\.<\/p>/);
  assert.equal(run('readyMessage(first)'), 'Report ready. NHTSA’s complaint list is still loading; it fills in by itself.');
  ctx.reply = () => Response.json(complaintList);
  await run('followComplaints(currentReport)');
  assert.deepEqual(ctx.requests, ['/api/vin/1FTEX1EP4FFD06976/complaints']);
  assert.equal(els.get('#complaint-count').textContent, 2);
  assert.match(els.get('#complaints-body').innerHTML, /Long stop/);
  assert.equal(run('currentReport.complaints.count'), 2);
  assert.equal(run('currentReport.recall_status.maker'), 'Ford', 'the recall links are kept');
  assert.match(els.get('#decode-status').textContent, /owner complaints have loaded/);
});

test('web report: complaints that cannot be loaded read as unknown (could not be loaded), never zero', async () => {
  const {ctx, els, run} = frontend();
  ctx.first = report(links, {complaints: pendingComplaints});
  run('currentReport = first; renderComplaints(first)');
  ctx.reply = () => new Response('{}', {status: 502});
  await run('followComplaints(currentReport)');
  assert.equal(ctx.requests.length, 2, 'asked twice');
  assert.equal(els.get('#complaint-count').textContent, '?');
  assert.match(els.get('#complaints-body').innerHTML, /could not be loaded here\. The count is unknown/);
  assert.equal(run('currentReport.complaints.pending'), false);
});

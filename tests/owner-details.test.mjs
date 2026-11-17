// Owner-stated transmission (owner rule 2026-11-17): the server split and swap (lib/transmission-choice.mjs), the
// account storage rules (lib/owner-details.mjs), the browser copy of the swap and its storage (public/owner-details.js),
// and how the choice shows on the car sheet, the comparison and the server-rendered VIN page.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import Database from 'better-sqlite3';
import {transmissionResult, applyTransmission, applyOwnerDetails, fuelForOtherBlocks, normalizeTransmission, transmissionSide} from '../lib/transmission-choice.mjs';
import {validateOwnerDetails, parseOwnerDetails, serializeOwnerDetails, migrateSavedVins, OwnerDetailsError} from '../lib/owner-details.mjs';
import {vinFacts, renderVinPage} from '../lib/vin-page.mjs';
import {compactExtraBlocks} from '../lib/more-sources.mjs';

const ASSUMED = 'Assuming an automatic transmission (the VIN does not say)';
const autoOne = {available: true, match: 'exact', combined_mpg: 34, city_mpg: 31, highway_mpg: 39, unit: 'mpg', transmission: 'Automatic (variable gear ratios)',
  matched_variant: 'Versa · Automatic (variable gear ratios)', summary: '34 mpg combined (31 city, 39 highway)', match_basis: ['1.6 L engine'], efids: ['GNSXV01.6GAA']};
const manOne = {available: true, match: 'exact', combined_mpg: 30, city_mpg: 27, highway_mpg: 36, unit: 'mpg', transmission: 'Manual 5-spd',
  matched_variant: 'Versa · Manual 5-spd', summary: '30 mpg combined (27 city, 36 highway)', match_basis: ['1.6 L engine'], efids: ['GNSXV01.6GAA']};
const autoSeveral = {available: false, reason: 'ambiguous_variant', match: 'multiple_configurations', combined_mpg: null, mpg_range: {unit: 'mpg', combined: {min: 31, max: 33}, city: {min: 27, max: 29}, highway: {min: 38, max: 40}},
  configuration_count: 2, configurations: [{epa_model: 'Focus FWD', transmission: 'Automatic (AM6)', combined_mpg: 31, unit: 'mpg', label: '6-speed dual-clutch automatic'}, {epa_model: 'Focus FWD', transmission: 'Automatic (S6)', combined_mpg: 33, unit: 'mpg', label: '6-speed automatic'}],
  summary: '31-33 mpg combined across 2 EPA configurations of this model; the VIN does not say which: 6-speed dual-clutch automatic or 6-speed automatic', match_basis: ['2.0 L engine'], efids: []};
const split = (a, m) => ({automatic: {status: 'one', tag: 'a'}, manual: {status: 'one', tag: 'm'}, results: {a, m}});
const fuelOf = (a, m) => { const s = split(a, m); return transmissionResult(s, sub => s.results[sub.tag], {allEfids: ['GNSXV01.6GAA']}); };
const deepFreeze = o => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const plain = x => JSON.parse(JSON.stringify(x));

function browser({local = new Map(), session = new Map(), throwing = false} = {}) {
  const store = map => ({getItem: k => { if (throwing) throw new Error('blocked'); return map.has(k) ? map.get(k) : null; },
    setItem: (k, v) => { if (throwing) throw new Error('blocked'); map.set(k, String(v)); }, removeItem: k => { if (throwing) throw new Error('blocked'); map.delete(k); }});
  const window = {localStorage: store(local), sessionStorage: store(session)};
  const ctx = vm.createContext({window, console});
  vm.runInContext(readFileSync(new URL('../public/owner-details.js', import.meta.url), 'utf8'), ctx);
  return {O: window.OwnerDetails, local, session};
}

test('the default: automatic figures, marked as assumed, with the manual as the alternative and the test groups all share', () => {
  const f = fuelOf(autoOne, manOne);
  assert.deepEqual([f.combined_mpg, f.assumed, f.transmission_choice.basis, f.transmission_choice.chosen, f.transmission_choice.label], [34, {transmission: 'automatic'}, 'assumed', 'automatic', ASSUMED]);
  assert.equal(f.summary, `${ASSUMED}: 34 mpg combined (31 city, 39 highway)`);
  assert.deepEqual(f.alternatives.map(a => [a.for_transmission, a.combined_mpg, a.summary]), [['manual', 30, '30 mpg combined (27 city, 36 highway)']]);
  assert.deepEqual(f.transmission_choice.options, ['automatic', 'manual']);
  // other report blocks (EPA test vehicles) see the set of configurations, not the assumption
  assert.deepEqual([fuelForOtherBlocks(f).available, fuelForOtherBlocks(f).match, fuelForOtherBlocks(f).efids], [false, 'multiple_configurations', ['GNSXV01.6GAA']]);
  assert.equal(fuelForOtherBlocks(autoOne), autoOne);
});

test('a stated transmission swaps the view, labels it, never mutates the cached default, and round-trips', () => {
  const f = deepFreeze(fuelOf(autoOne, manOne));
  const m = applyTransmission(f, 'manual', {by: 'owner'});
  assert.deepEqual([m.combined_mpg, m.transmission, m.assumed, m.stated, m.transmission_choice.basis], [30, 'Manual 5-spd', undefined, {transmission: 'manual', by: 'owner'}, 'owner_stated']);
  assert.equal(m.summary, 'Manual transmission, as you said (the VIN does not say): 30 mpg combined (27 city, 36 highway)');
  assert.deepEqual(m.match_basis, ['1.6 L engine', 'manual transmission, as you said (the VIN does not say)']);
  assert.deepEqual(m.alternatives.map(a => [a.for_transmission, a.combined_mpg, a.summary, a.match_basis]), [['automatic', 34, '34 mpg combined (31 city, 39 highway)', ['1.6 L engine']]]);
  const back = applyTransmission(m, 'automatic', {by: 'request'});
  assert.deepEqual(plain(back), plain(applyTransmission(f, 'automatic', {by: 'request'})));
  assert.equal(back.summary, 'Automatic transmission, as requested (the VIN does not say): 34 mpg combined (31 city, 39 highway)');
  assert.equal(applyTransmission(f, null), f);
  assert.equal(applyTransmission(autoOne, 'manual'), autoOne); // no choice in this response: unchanged
  assert.throws(() => applyTransmission(f, 'cvt'), TypeError);
  assert.deepEqual(['Auto', ' MANUAL ', '', undefined].map(normalizeTransmission), ['automatic', 'manual', null, null]);
  const report = {vin: 'X', fuel_economy: f, recalls: {count: 1}};
  assert.equal(applyOwnerDetails(report, {}), report);
  assert.equal(applyOwnerDetails(report, {transmission: 'manual'}, {by: 'owner'}).fuel_economy.combined_mpg, 30);
});

test('EPA transmission kinds: CVT, dual-clutch and automated manual are automatic; only Manual is manual', () => {
  const side = trany => transmissionSide({trany});
  assert.deepEqual(['Automatic (variable gear ratios)', 'Automatic (AV-S7)', 'Automatic (AM6)', 'Automatic (AM-S7)', 'Automatic (S8)', 'Automatic 4-spd', 'Manual 6-spd', 'Manual 5-spd', ''].map(side),
    ['automatic', 'automatic', 'automatic', 'automatic', 'automatic', 'automatic', 'manual', 'manual', null]);
});

test('the browser copy of the swap gives exactly what the server gives', () => {
  const {O} = browser();
  for (const f of [fuelOf(autoOne, manOne), fuelOf(autoSeveral, manOne)]) {
    for (const t of ['manual', 'automatic']) for (const by of ['owner', 'request']) {
      const server = applyTransmission(f, t, {by}), client = O.applyTransmission(plain(f), t, by);
      assert.deepEqual(plain(client), plain(server), `${t} ${by}`);
      assert.deepEqual(plain(O.applyTransmission(client, t === 'manual' ? 'automatic' : 'manual', by)), plain(applyTransmission(server, t === 'manual' ? 'automatic' : 'manual', {by})));
    }
  }
  assert.equal(O.applyTransmission(autoOne, 'manual'), autoOne);
});

test('signed out: the choice stays in this browser, next to the recent reports, and the card says so', async () => {
  const {O, local, session} = browser();
  O.setAccount([], false);
  const vin = '3N1CN7AP0GL800001', f = fuelOf(autoOne, manOne);
  let html = O.controlHtml(f, vin);
  assert.match(html, /<strong>Assuming an automatic transmission \(the VIN does not say\)\.<\/strong> With a manual: 30 mpg combined \(27 city, 36 highway\)\./);
  assert.match(html, /data-owner-transmission="manual">Mine is a manual<\/button>/);
  assert.match(html, /data-owner-transmission="automatic">It is an automatic<\/button>/);
  assert.match(html, /CVT\), dual-clutch and automated-manual transmissions count as automatic/);
  assert.doesNotMatch(html, /owner-choice-kept/);
  let fetched = 0;
  assert.equal(await O.set(vin.toLowerCase(), {transmission: 'manual'}, {request: async () => { fetched++; }}), 'browser');
  assert.equal(fetched, 0); // never sent
  assert.deepEqual(JSON.parse(local.get('vin-owner-details')), {[vin]: {transmission: 'manual'}});
  assert.equal(session.size, 0);
  assert.deepEqual([plain(O.get(vin)), O.where(vin)], [{transmission: 'manual'}, 'browser']);
  const view = O.applyToReport({vin, fuel_economy: f});
  assert.deepEqual([view.fuel_economy.combined_mpg, view.fuel_economy.transmission_choice.label], [30, 'Manual transmission, as you said (the VIN does not say)']);
  html = O.controlHtml(view.fuel_economy, vin);
  assert.match(html, /With an automatic: 34 mpg combined/);
  assert.match(html, /data-owner-transmission="automatic">Mine is an automatic<\/button>/);
  assert.match(html, /Saved in this browser only, next to your recent reports \(clearing them clears this too\)\. Not sent to mcp\.vin\./);
  assert.equal(O.choiceMark(view.fuel_economy), ' (manual, as you said)');
  assert.equal(O.choiceMark(f), ' (automatic assumed; the VIN does not say)');
  assert.equal(O.choiceMark(autoOne), '');
  O.clear('browser');
  assert.deepEqual([plain(O.get(vin)), O.applyToReport({vin, fuel_economy: f}).fuel_economy.combined_mpg], [null, 34]);
  // no transmission choice in the report, or no stated detail: the same object comes back
  const plainReport = {vin, fuel_economy: autoOne};
  assert.equal(O.applyToReport(plainReport), plainReport);
  assert.equal(O.controlHtml(autoOne, vin), '');
});

test('signed in: kept with a saved vehicle in the account; an unsaved vehicle is kept for the visit with an offer to save it', async () => {
  const {O, local, session} = browser();
  const saved = '3N1CN7AP0GL800001', unsaved = '3N1CN7AP0GL800002', f = fuelOf(autoOne, manOne);
  O.setAccount([{id: 7, vin: saved, owner_details: null}], true);
  const calls = [];
  const request = async (url, opts) => { calls.push([url, opts.method, JSON.parse(opts.body)]); return {ok: true}; };
  assert.equal(await O.set(saved, {transmission: 'manual'}, {request}), 'account');
  assert.deepEqual(calls, [['/api/user/vins/7/details', 'PUT', {owner_details: {transmission: 'manual'}}]]);
  assert.deepEqual([plain(O.get(saved)), O.where(saved), local.size], [{transmission: 'manual'}, 'account', 0]);
  assert.match(O.controlHtml(O.applyToReport({vin: saved, fuel_economy: f}).fuel_economy, saved), /Saved with this vehicle in your account\./);
  // a failed save leaves the choice as it was and reports the error
  await assert.rejects(O.set(saved, {transmission: 'automatic'}, {request: async () => { throw new Error('offline'); }}), /offline/);
  assert.deepEqual(plain(O.get(saved)), {transmission: 'manual'});
  assert.equal(await O.set(unsaved, {transmission: 'manual'}, {request}), 'session');
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(session.get('vin-owner-details-session')), {[unsaved]: {transmission: 'manual'}});
  const html = O.controlHtml(O.applyToReport({vin: unsaved, fuel_economy: f}).fuel_economy, unsaved);
  assert.match(html, /Kept for this visit only\. <button type="button" class="text-button" data-owner-save>Save this vehicle with this choice<\/button>/);
  // account details are loaded with the saved list; signing out forgets the visit's choices
  O.setAccount([{id: 7, vin: saved, owner_details: {transmission: 'automatic'}}], true);
  assert.deepEqual(plain(O.get(saved)), {transmission: 'automatic'});
  O.setAccount([], false); O.clear('session');
  assert.deepEqual([plain(O.get(saved)), plain(O.get(unsaved))], [null, null]);
});

test('blocked browser storage never breaks the report', async () => {
  const {O} = browser({throwing: true});
  const f = fuelOf(autoOne, manOne), vin = '3N1CN7AP0GL800001';
  assert.equal(plain(O.get(vin)), null);
  assert.equal(await O.set(vin, {transmission: 'manual'}), 'browser');
  assert.equal(O.applyToReport({vin, fuel_economy: f}).fuel_economy.combined_mpg, 34);
  assert.match(O.controlHtml(f, vin), /Mine is a manual/);
  O.clear('browser');
});

test('account storage: known keys only, validated, stored as JSON, and the column added to an existing database', () => {
  assert.deepEqual(validateOwnerDetails({transmission: 'Manual'}), {transmission: 'manual'});
  assert.equal(validateOwnerDetails({transmission: null}), null);
  assert.equal(validateOwnerDetails(undefined), null);
  for (const bad of [{transmission: 'cvt'}, {colour: 'red'}, 'manual', ['manual']]) assert.throws(() => validateOwnerDetails(bad), OwnerDetailsError);
  assert.deepEqual(parseOwnerDetails('{"transmission":"manual","colour":"red"}'), {transmission: 'manual'});
  assert.deepEqual([parseOwnerDetails('{"transmission":"cvt"}'), parseOwnerDetails('not json'), parseOwnerDetails(null), parseOwnerDetails('[1]')], [null, null, null, null]);
  assert.equal(serializeOwnerDetails({transmission: 'manual'}), '{"transmission":"manual"}');
  assert.equal(serializeOwnerDetails(null), null);
  // the saved_vins table as it was before 2026-11-17, with a row in it
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE saved_vins (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, vin TEXT NOT NULL, label TEXT, year INTEGER, make TEXT, model TEXT,
    created_at TEXT DEFAULT (datetime('now')), UNIQUE(user_id, vin))`);
  db.prepare('INSERT INTO saved_vins (user_id, vin, label) VALUES (1, ?, ?)').run('3N1CN7AP0GL800001', 'Family car');
  migrateSavedVins(db); migrateSavedVins(db); // idempotent
  assert.ok(db.prepare('PRAGMA table_info(saved_vins)').all().some(c => c.name === 'owner_details'));
  assert.deepEqual(db.prepare('SELECT vin, label, owner_details FROM saved_vins').all().map(r => ({...r})), [{vin: '3N1CN7AP0GL800001', label: 'Family car', owner_details: null}]);
  migrateSavedVins(new Database(':memory:')); // no table yet: nothing to do
});

function sheet() {
  const ctx = {console, URLSearchParams, setTimeout};
  vm.createContext(ctx);
  for (const file of ['qr.js', 'car-sheet.js', 'more-sources.js']) vm.runInContext(readFileSync(new URL('../public/' + file, import.meta.url), 'utf8'), ctx);
  return vm.runInContext('CarSheet', ctx);
}
const strip = html => html.replace(/<wbr>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const paper = html => strip(html.replace(/<span class="sheet-screen-only">(?:[^<]|<a [^>]*>[^<]*<\/a>)*<\/span>/g, '').replace(/<p class="sheet-note[^"]*sheet-screen-only">.*?<\/p>/g, ''));
const base = {valid: true, vin: '3N1CN7AP0GL800001', validation: {checksum: {valid: true}}, vehicle: {year: 2016, make: 'NISSAN', model: 'Versa', body_class: 'Sedan/Saloon'},
  engine: {displacement_l: 1.6, cylinders: 4}, transmission: {}, raw_nhtsa: {}, dimensions: {}, recalls: {available: true, count: 0, recalls: []}, provenance: {assembled_at: '2026-11-17T10:00:00Z'}};

test('car sheet: the assumption or the owner\'s choice prints; the other figure is screen only; the label is not repeated', () => {
  const s = sheet(), f = fuelOf(autoOne, manOne);
  let html = s.html({...base, fuel_economy: f}).body;
  assert.match(paper(html), /EPA fuel economy 34 mpg combined \(31 city, 39 hwy\)/);
  assert.match(paper(html), /Assuming an automatic transmission \(the VIN does not say\)\./);
  assert.doesNotMatch(paper(html), /with a manual/);
  assert.match(strip(html), /Assuming an automatic transmission \(the VIN does not say\) ; with a manual: 30 mpg combined \./);
  html = s.html({...base, fuel_economy: applyTransmission(f, 'manual', {by: 'owner'})}).body;
  assert.match(paper(html), /EPA fuel economy 30 mpg combined \(27 city, 36 hwy\)/);
  assert.match(paper(html), /Manual transmission, as you said \(the VIN does not say\)\./);
  // several automatic configurations: the range prints once, without the label inside it
  html = s.html({...base, fuel_economy: fuelOf(autoSeveral, manOne)}).body;
  assert.match(paper(html), /Assuming an automatic transmission \(the VIN does not say\)\. EPA range: 31-33 mpg combined across 2 EPA configurations of this model; the VIN does not say which\./);
  assert.equal(strip(html).split('Assuming an automatic').length, 2);
});

test('server VIN page and MCP report: the default assumption is said, with the manual figure; alternatives stay compact', () => {
  const report = {valid: true, vin: '3N1CN7AP0GL800001', vehicle: {year: 2016, make: 'NISSAN', model: 'Versa'}, engine: {}, transmission: {}, plant: {}, fuel_economy: fuelOf(autoOne, manOne)};
  const fact = vinFacts(report).facts.find(([k]) => k === 'EPA fuel economy');
  assert.equal(fact[1], '34 mpg combined (31 city, 39 highway); assuming an automatic transmission (the VIN does not say). With a manual: 30 mpg combined');
  const template = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(renderVinPage(template, report), /<meta name="description" content="[^"]*34 mpg combined \(automatic assumed\)\./);
  const several = {...report, fuel_economy: fuelOf(autoSeveral, {...manOne, match: 'multiple_configurations', configurations: [{vehicle_id: 1, epa_model: 'Focus FWD', transmission: 'Manual 5-spd', combined_mpg: 30, extra: 'dropped'}]})};
  const compact = compactExtraBlocks(several).fuel_economy;
  assert.deepEqual(Object.keys(compact.configurations[0]).includes('label'), true);
  assert.equal(compact.alternatives[0].configurations[0].extra, undefined);
  assert.deepEqual([compact.assumed, compact.alternatives[0].for_transmission], [{transmission: 'automatic'}, 'manual']);
});

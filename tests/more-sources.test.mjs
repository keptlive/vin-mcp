import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {lookupBuildDates, withBuildDates} from '../lib/recall-build-dates.mjs';

const temp = mkdtempSync(path.join(tmpdir(), 'vin-more-sources-'));
test.after(() => rmSync(temp, {recursive: true, force: true}));

// Minimal DOM, as in regression.test.mjs: run the real browser scripts (more-sources.js, then app.js).
function frontend() {
  const els = new Map();
  const element = () => ({style: {}, dataset: {}, handlers: {}, value: '', classList: {add() {}, remove() {}, toggle() {}}, addEventListener(k, fn) { this.handlers[k] = fn; }, dispatchEvent(e) { return this.handlers[e.type]?.(e); }, setAttribute() {}, focus() {}, setSelectionRange() {}, querySelector() { return element(); }, querySelectorAll() { return []; }, replaceChildren() { this.innerHTML = ''; }, innerHTML: '', textContent: '', hidden: false});
  const document = {createElement: () => ({set textContent(v) { this.innerHTML = String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }}), querySelector: s => { if (!els.has(s)) els.set(s, element()); return els.get(s); }, querySelectorAll: () => [], addEventListener() {}};
  const ctx = {document, window: {location: {pathname: '/'}}, navigator: {}, localStorage: {getItem() { return null; }}, console, fetch: async () => new Response('{}'), setTimeout() {}, addEventListener() {}};
  vm.createContext(ctx);
  for (const file of ['more-sources.js', 'app.js']) vm.runInContext(readFileSync(new URL('../public/' + file, import.meta.url), 'utf8'), ctx);
  ctx.window.MoreSources = vm.runInContext('MoreSources', ctx);
  return {els, run: script => vm.runInContext(script, ctx), sources: ctx.window.MoreSources};
}

function buildDb(file) {
  const db = new Database(file);
  db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE campaign_builds(campaign TEXT NOT NULL,make_compact TEXT NOT NULL,model_compact TEXT NOT NULL,year INTEGER NOT NULL,built_from TEXT,built_to TEXT,distinct_ranges INTEGER NOT NULL,PRIMARY KEY(campaign,make_compact,model_compact,year)) WITHOUT ROWID;
    CREATE TABLE campaign_units(campaign TEXT PRIMARY KEY,units_affected INTEGER NOT NULL) WITHOUT ROWID;`);
  db.prepare('INSERT INTO metadata VALUES(?,?)').run('source', JSON.stringify({latest_report_date: '2026-11-12'}));
  const ins = db.prepare('INSERT INTO campaign_builds VALUES(?,?,?,?,?,?,?)');
  ins.run('11V562000', 'SUBARU', 'OUTBACK', 2012, '2011-10-17', '2011-11-23', 1);
  ins.run('12V001000', 'FORD', 'F150', 2012, '2011-01-05', '2011-04-15', 2);
  ins.run('12V004000', 'FORD', 'F150', 2012, '2012-04-01', null, 1);
  ins.run('24V744000', 'HONDA', 'CRVHYBRID', 2024, '2023-01-02', '2023-06-30', 1);
  db.prepare('INSERT INTO campaign_units VALUES(?,?)').run('11V562000', 32685);
  db.close();
}

test('build-date lookup joins campaign + make + model + year, ignoring punctuation, and reports a missing index', () => {
  const file = path.join(temp, 'labels.db');
  buildDb(file);
  const found = lookupBuildDates([{campaign: '11V562000', make: 'SUBARU', model: 'Outback', year: 2012}, {campaign: '12V001000', make: 'Ford', model: 'F-150', year: 2012}, {campaign: '11V562000', make: 'SUBARU', model: 'Legacy', year: 2012}], file);
  assert.equal(found.available, true);
  assert.deepEqual([...found.ranges.values()].map(r => [r.built_from, r.built_to, r.units_affected]), [['2011-10-17', '2011-11-23', 32685], ['2011-01-05', '2011-04-15', null], [null, null, 32685]]);
  assert.deepEqual(lookupBuildDates([], path.join(temp, 'missing.db')), {available: false, reason: 'dataset_not_indexed'});
  const old = path.join(temp, 'old.db');
  new Database(old).exec("CREATE TABLE metadata(key TEXT, value TEXT)");
  assert.deepEqual(lookupBuildDates([{campaign: 'X', make: 'A', model: 'B', year: 2012}], old), {available: false, reason: 'dataset_not_indexed'});
});

test('reports attach build dates to exact, related and flat-file-only campaigns by their own label, never guessing', () => {
  const file = path.join(temp, 'labels2.db');
  buildDb(file);
  const lookup = keys => lookupBuildDates(keys, file);
  const recalls = {available: true, count: 2, recalls: [{campaign_number: '12V001000'}, {campaign_number: '12V009000'}],
    related_models: {available: true, count: 0, models: [], flat_file_only: {count: 1, campaigns: [{campaign_number: '12V004000', nhtsa_model: 'F150', match: 'spelling'}]}}};
  const out = withBuildDates(recalls, 'FORD', 'F-150', 2012, {lookup});
  assert.equal(out.recalls[0].manufactured_from, '2011-01-05');
  assert.match(out.recalls[0].manufactured_range_note, /2 different ranges/);
  assert.equal(out.recalls[1].manufactured_from, null);
  assert.equal(out.recalls[1].manufactured_to, null);
  assert.deepEqual([out.related_models.flat_file_only.campaigns[0].manufactured_from, out.related_models.flat_file_only.campaigns[0].manufactured_to], ['2012-04-01', null]);
  assert.equal(out.build_dates.campaigns, 3);
  assert.equal(out.build_dates.campaigns_with_dates, 2);
  assert.equal(out.build_dates.vin_specific, false);
  assert.equal(out.count, 2);
  // A related CR-V HYBRID campaign gets its range by the CR-V HYBRID label, not the decoded CR-V.
  const crv = withBuildDates({available: true, count: 0, recalls: [], related_models: {available: true, count: 1, models: [{nhtsa_model: 'CR-V HYBRID', match: 'longer_name', recalls: [{campaign_number: '24V744000'}]}]}}, 'HONDA', 'CR-V', 2024, {lookup});
  assert.equal(crv.related_models.models[0].recalls[0].manufactured_to, '2023-06-30');
  // Unavailable recall data and a missing index change nothing they cannot know.
  const down = {available: false, count: null, recalls: []};
  assert.equal(withBuildDates(down, 'FORD', 'F-150', 2012, {lookup}), down);
  const missing = withBuildDates(recalls, 'FORD', 'F-150', 2012, {lookup: () => ({available: false, reason: 'dataset_not_indexed'})});
  assert.deepEqual(missing.build_dates, {available: false, reason: 'dataset_not_indexed'});
  assert.equal('manufactured_from' in missing.recalls[0], false);
});

test('the recall list shows the manufacturer build range with the door-jamb pointer, and nothing when none was filed', () => {
  const {els, run, sources} = frontend();
  const rec = {available: true, count: 2, related_campaigns_found: false, related_models: {available: true, count: 0, models: []}, recalls: [
    {campaign_number: '11V562000', component: 'SERVICE BRAKES', summary: 'Pedal', manufactured_from: '2011-10-17', manufactured_to: '2011-11-23'},
    {campaign_number: '12V009000', component: 'AIR BAGS', summary: 'Inflator', manufactured_from: null, manufactured_to: null}]};
  run(`renderRecalls({recalls:${JSON.stringify(rec)}})`);
  const html = els.get('#recalls-body').innerHTML;
  assert.match(html, /Manufacturer says affected vehicles were built 2011-10-17 to 2011-11-23\. Your build month is on the door-jamb label\./);
  assert.equal(html.match(/Build dates:/g).length, 1);
  assert.match(sources.builtHtml({manufactured_from: '2012-04-01', manufactured_to: null}), /built from 2012-04-01 \(no end date filed\)/);
  assert.equal(sources.builtHtml({manufactured_from: '<b>', manufactured_to: null}).includes('<b>'), false);
  assert.equal(sources.builtHtml({}), '');
});

// ---- EPA Test Car List ----
import {lookupEpaTestCars, carlineTier} from '../lib/epa-test-cars.mjs';

function epaDb(file) {
  const db = new Database(file);
  db.exec(`CREATE TABLE test_cars(model_year INTEGER NOT NULL,manufacturer TEXT,make TEXT,carline TEXT NOT NULL,test_group TEXT,displacement_l REAL,cylinders REAL,rated_hp REAL,trans_type TEXT,trans_code TEXT,gears REAL,drive TEXT,etw_lb REAL,axle_ratio REAL,nv_ratio REAL,make_compact TEXT,manufacturer_compact TEXT,carline_compact TEXT,source_file TEXT NOT NULL,tests INTEGER NOT NULL);
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);`);
  db.prepare('INSERT INTO metadata VALUES(?,?)').run('source', JSON.stringify({page: 'https://www.epa.gov/x', indexed_at: '2026-11-17T00:00:00Z', sources: [{file: '15tstcar.csv', url: 'https://www.epa.gov/15tstcar.csv'}]}));
  const ins = db.prepare('INSERT INTO test_cars VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const c = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const add = (y, mfr, make, carline, group, displ, hp, trans, gears, drive, etw, axle, file) => ins.run(y, mfr, make, carline, group, displ, null, hp, trans, null, gears, drive, etw, axle, null, make ? c(make) : '', c(mfr), c(carline), file, 1);
  add(2015, 'Ford Motor Company', 'Ford', 'F-150 4X2', 'FFMXT02.73DH', 2.7, 325, 'Semi-Automatic', 6, '2-Wheel Drive, Rear', 5000, 3.31, '15tstcar.csv');
  add(2015, 'Ford Motor Company', 'Ford', 'F150 4X4 Super Crew', 'FFMXT02.73DH', 2.7, 325, 'Semi-Automatic', 6, 'Part-time 4-Wheel Drive', 5250, 3.55, '15tstcar.csv');
  add(2015, 'Ford Motor Company', 'Ford', 'F150 4X4 Super Crew', 'FFMXT03.54IG', 3.5, 365, 'Semi-Automatic', 6, 'Part-time 4-Wheel Drive', 5500, 3.55, '15tstcar.csv');
  add(2014, 'Honda', 'Honda', 'ACCORD', 'EHNXV02.4CBP', 2.4, 185, 'Continuously Variable', 1, '2-Wheel Drive, Front', 3500, 3.21, '14tstcar.csv');
  add(2017, 'General Motors', 'Chevrolet', 'BOLT', 'HGMXV00.0002', null, 200, 'Automatic', 1, '2-Wheel Drive, Front', 3875, 7.05, '17tstcar.xlsx');
  add(2003, 'TOYOTA', null, 'GS 300/GS 430', '3TYXV03.0GHC', 3.0, 220, 'Automatic', 5, '2-Wheel Drive, Rear', 4000, 3.27, '03tstcar.csv');
  db.close();
}
const car = (year, make, model, extra = {}) => ({vehicle: {year, make, model}, engine: extra.engine || {}, transmission: extra.transmission || {}, fuel_economy: extra.fuel_economy || {available: false}});

test('EPA test vehicles: exact test group first, carried-over groups and closest matches disclosed, unknowns never filled', () => {
  const file = path.join(temp, 'epa.db');
  epaDb(file);
  const exact = lookupEpaTestCars(car(2015, 'FORD', 'F-150', {fuel_economy: {available: true, efids: ['FFMXT02.73DH', 'FFMXT02.73JJ']}, transmission: {drive_type: '4WD/4-Wheel Drive/4x4'}}), file);
  assert.equal(exact.match, 'epa_test_group');
  assert.deepEqual([exact.rated_hp, exact.axle_ratios, exact.test_groups], [{min: 325, max: 325}, [3.55], ['FFMXT02.73DH']]);
  assert.match(exact.note, /manufacturer's EPA certification test vehicles for this engine family/);
  const carried = lookupEpaTestCars(car(2015, 'HONDA', 'Accord', {fuel_economy: {available: true, efids: ['EHNXV02.4CBP']}}), file);
  assert.deepEqual([carried.match, carried.tested_model_years], ['epa_test_group', [2014]]);
  assert.match(carried.match_basis[0], /tested for model year 2014 and carried over/);
  // No EPA configuration match: same make, model name and engine size, then drive from the carline name.
  const closest = lookupEpaTestCars(car(2015, 'FORD', 'F-150', {engine: {displacement_l: 2.7}, transmission: {drive_type: '4WD/4-Wheel Drive/4x4'}}), file);
  assert.equal(closest.match, 'closest_test_configuration');
  assert.deepEqual([closest.carlines, closest.axle_ratios, closest.test_weight_lb], [['Ford F150 4X4 Super Crew'], [3.55], {min: 5250, max: 5250}]);
  assert.match(closest.note, /Closest EPA test configuration: matched by same model year, make and model name.*2\.7 L engine.*transmission not checked.*four\/all-wheel drive/);
  const ev = lookupEpaTestCars(car(2017, 'CHEVROLET', 'Bolt EV', {engine: {fuel_type: 'Electric', ev_type: 'BEV (Battery Electric Vehicle)'}}), file);
  assert.deepEqual([ev.available, ev.rated_hp.min], [true, 200]);
  assert.match(ev.match_basis.join(' '), /first word of the model name \(Bolt\)/);
  const lexus = lookupEpaTestCars(car(2003, 'LEXUS', 'GS 300', {engine: {displacement_l: 2.997}}), file);
  assert.deepEqual([lexus.available, lexus.rated_hp.max], [true, 220]);
  assert.deepEqual(lookupEpaTestCars(car(2015, 'FORD', 'F-150', {engine: {displacement_l: 5.0}}), file), {available: false, reason: 'no_matching_test_vehicle', model_year: 2015});
  assert.deepEqual(lookupEpaTestCars(car(2015, 'FORD', 'F-150'), path.join(temp, 'none.db')), {available: false, reason: 'dataset_not_indexed'});
  assert.equal(carlineTier('Camry', 'CAMRY SOLARA'), 2);
  assert.equal(carlineTier('Camry', 'CAMRY'), 3);
  assert.equal(carlineTier('Z', 'Z4 ROADSTER'), 0);
});

test('the engine card and the car sheet label EPA test-vehicle horsepower; the sheet uses it only when vPIC has none', () => {
  const ctx = {console, URLSearchParams, setTimeout};
  vm.createContext(ctx);
  for (const file of ['qr.js', 'car-sheet.js', 'more-sources.js']) vm.runInContext(readFileSync(new URL('../public/' + file, import.meta.url), 'utf8'), ctx);
  const sheet = vm.runInContext('CarSheet', ctx), sources = vm.runInContext('MoreSources', ctx);
  const epa = {available: true, match: 'closest_test_configuration', rated_hp: {min: 240, max: 255}, axle_ratios: [3.29, 4.43], transmissions: ['5-speed automatic'], test_weight_lb: {min: 3625, max: 3625}, test_groups: ['3HNXV03.0FBP'], tested_model_years: [2003], match_basis: ['same model year, make and model name', '3.0 L engine']};
  const rows = sources.engineRowsHtml({epa_test_vehicles: epa}).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(rows, /Rated horsepower \(EPA test vehicles\) 240–255 hp/);
  assert.match(rows, /Axle ratios tested 3\.29, 4\.43/);
  assert.match(rows, /Closest EPA test configuration\. These are the manufacturer's EPA test vehicles for this engine family \(EPA Test Car List, model year 2003\), not necessarily this car's configuration/);
  assert.equal(sources.engineRowsHtml({epa_test_vehicles: {available: false, reason: 'no_matching_test_vehicle'}}), '');
  const report = {vin: '1HGCM82633A004352', vehicle: {year: 2003, make: 'HONDA', model: 'Accord'}, engine: {displacement_l: 3.0, cylinders: 6}, transmission: {}, raw_nhtsa: {}, recalls: {available: true, count: 0, recalls: []}, fuel_economy: {available: false}, epa_test_vehicles: epa};
  const out = sheet.html(report).body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(out, /Rated power 240–255 hp \(maker’s EPA test vehicles for this engine family\)/);
  const withVpic = sheet.html({...report, engine: {...report.engine, hp: 240}}).body;
  assert.doesNotMatch(withVpic, /Rated power/);
});

// ---- NHTSA final theft data (production and theft, historical) ----
import {lookupTheftRates} from '../lib/theft-rates.mjs';

function theftDb(file, totals = {}) {
  const db = new Database(file);
  db.exec(`CREATE TABLE theft_rates(model_year INTEGER NOT NULL,calendar_year INTEGER NOT NULL,rank INTEGER,manufacturer TEXT NOT NULL,line TEXT NOT NULL,line_compact TEXT NOT NULL,manufacturer_compact TEXT NOT NULL,thefts INTEGER NOT NULL,production INTEGER NOT NULL,rate REAL NOT NULL,rate_check TEXT NOT NULL,lines_in_table INTEGER NOT NULL,document_number TEXT NOT NULL,publication_date TEXT NOT NULL,source_url TEXT);
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);`);
  db.prepare('INSERT INTO metadata VALUES(?,?)').run('source', JSON.stringify({model_years: [2003, 2012], printed_totals: totals}));
  const ins = db.prepare('INSERT INTO theft_rates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const c = s => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const add = (y, rank, mfr, line, thefts, prod, rate, check = 'ok') => ins.run(y, y, rank, mfr, line, c(line), c(mfr), thefts, prod, rate, check, 5, y === 2003 ? '05-15689' : '2014-27885', '2014-11-25', 'https://www.federalregister.gov/d/x');
  add(2003, 115, 'HONDA', 'ACCORD', 499, 427660, 1.1668);
  add(2003, 90, 'HONDA', 'ACURA 3.2 TL', 74, 77849, 0.9506);
  add(2003, 12, 'GENERAL MOTORS', 'CHEVROLET S10/T10 PICKUP', 218, 159920, 1.3632);
  add(2003, 50, 'BMW', '3', 88, 58554, 1.5029);
  add(2003, 51, 'DAIMLERCHRYSLER', 'JEEP GRAND CHEROKEE', 190, 114736, 1.656);
  add(2003, 52, 'DAIMLERCHRYSLER', 'DODGE INTREPID', 662, 67289, 9.8382);
  add(2012, 57, 'VOLKSWAGEN', 'PASSAT', 107, 95583, 1.1194);
  add(2012, 30, 'TOYOTA', 'COROLLA', 304, 197973, 1.4257, 'printed_rate_differs');
  db.close();
}

test('theft rates: exact line first, aliases disclosed, other makes and missing model years stay unknown', () => {
  const file = path.join(temp, 'theft.db');
  theftDb(file, {'2012': {thefts: 12172, production: 10777418, rate: 1.1294}});
  const v = (year, make, model) => lookupTheftRates({vehicle: {year, make, model}}, file);
  const accord = v(2003, 'HONDA', 'Accord');
  assert.deepEqual([accord.match, accord.vin_specific, accord.lines], ['line_name', false, [{manufacturer: 'HONDA', line: 'ACCORD', production: 427660, thefts: 499, thefts_per_1000_produced: 1.1668, rank: 115, lines_ranked: 5}]]);
  assert.match(accord.note, /not for this car/);
  assert.equal(v(2003, 'ACURA', 'TL').lines[0].line, 'ACURA 3.2 TL');
  const s10 = v(2003, 'CHEVROLET', 'S10');
  assert.deepEqual([s10.match, s10.lines[0].production], ['closest_line_name', 159920]);
  assert.match(s10.note, /covers more than one name/);
  assert.match(v(2003, 'BMW', '325i').match_basis.join(' '), /BMW 325i counted in NHTSA's line "3" \(3 Series\)/);
  assert.equal(v(2003, 'JEEP', 'Cherokee').reason, 'line_not_in_theft_report'); // Grand Cherokee is another line
  assert.equal(v(2003, 'CHRYSLER', 'Intrepid').reason, 'line_not_in_theft_report'); // a Dodge line is not a Chrysler one
  const corolla = v(2012, 'TOYOTA', 'Corolla');
  assert.deepEqual([corolla.lines[0].rate_check, corolla.all_lines.rate], ['printed_rate_differs', 1.1294]);
  assert.deepEqual(v(2011, 'HONDA', 'Accord'), {available: false, reason: 'model_year_not_published', model_years_covered: [2003, 2012]});
  assert.deepEqual(lookupTheftRates({vehicle: {year: 2003, make: 'HONDA', model: 'Accord'}}, path.join(temp, 'none.db')), {available: false, reason: 'dataset_not_indexed'});
});

test('the production and theft card shows figures for the line, labels closest names and printed-rate flags, and goes when nothing matches', () => {
  const nodes = new Map();
  const node = id => ({id, remove() { nodes.delete(this.id); }, insertAdjacentElement(where, el) { nodes.set(el.id, el); el.after = this.id; }});
  nodes.set('card-plant', node('card-plant'));
  const document = {querySelector: s => nodes.get(s.replace(/^#/, '')) || null, createElement: () => node(null)};
  const ctx = {document, console};
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../public/more-sources.js', import.meta.url), 'utf8'), ctx);
  const sources = vm.runInContext('MoreSources', ctx);
  const p = {available: true, model_year: 2003, calendar_year: 2003, match: 'closest_line_name', match_basis: ['same model year and make', "NHTSA's line S10/T10 PICKUP covers more than one name"],
    lines: [{manufacturer: 'GENERAL MOTORS', line: 'CHEVROLET S10/T10 PICKUP', production: 159920, thefts: 218, thefts_per_1000_produced: 1.3632, rank: 12, lines_ranked: 217, rate_check: 'printed_rate_differs'}],
    source: {document_number: '05-15689', url: 'https://www.federalregister.gov/d/05-15689'}};
  sources.render({production_theft: p});
  const section = nodes.get('card-production-theft');
  assert.equal(section.after, 'card-plant');
  const text = section.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, /Production and theft \(historical\)/);
  assert.match(text, /Production, model year 2003 159,920 Thefts in 2003 218 Theft rate 1\.3632 per 1,000 produced \(as printed; does not equal thefts ÷ production\) Rank 12 of 217 lines/);
  assert.match(text, /Closest line name: matched by same model year and make; NHTSA's line S10\/T10 PICKUP covers more than one name\. Figures for the whole vehicle line, not this car/);
  sources.render({production_theft: {available: false, reason: 'model_year_not_published'}});
  assert.equal(nodes.has('card-production-theft'), false);
});

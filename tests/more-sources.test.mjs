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
  // FuelEconomy.gov writes this model year's letter (F = 2015) where the list kept the certification's (E = 2014).
  const letter = lookupEpaTestCars(car(2015, 'HONDA', 'Accord', {fuel_economy: {available: true, efids: ['FHNXV02.4CBP']}}), file);
  assert.deepEqual([letter.match, letter.test_groups, letter.tested_model_years], ['epa_test_group', ['EHNXV02.4CBP'], [2014]]);
  assert.match(letter.match_basis[0], /EPA test group EHNXV02\.4CBP of the matched FuelEconomy\.gov configuration \(FuelEconomy\.gov: FHNXV02\.4CBP; same engine family, the list keeps the earlier model-year letter\), tested for model year 2014 and carried over/);
  const sameYear = lookupEpaTestCars(car(2015, 'FORD', 'F-150', {fuel_economy: {available: true, efids: ['GFMXT02.73DH']}, transmission: {drive_type: '4WD/4-Wheel Drive/4x4'}}), file);
  assert.deepEqual([sameYear.match, sameYear.test_groups, sameYear.tested_model_years], ['epa_test_group', ['FFMXT02.73DH'], [2015]]);
  // Nothing within three model years: no join by group.
  assert.notEqual(lookupEpaTestCars(car(2019, 'HONDA', 'Accord', {fuel_economy: {available: true, efids: ['KHNXV02.4CBP']}}), file).match, 'epa_test_group');
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
  assert.equal(exact.hp_note, undefined);
  // Several FuelEconomy.gov configurations that all share one test group still join by it.
  const shared = lookupEpaTestCars(car(2015, 'FORD', 'F-150', {fuel_economy: {available: false, reason: 'ambiguous_variant', match: 'multiple_configurations', efids: ['FFMXT02.73DH']}, transmission: {drive_type: '4WD/4-Wheel Drive/4x4'}}), file);
  assert.equal(shared.match, 'epa_test_group');
  assert.match(shared.match_basis[0], /FuelEconomy\.gov configurations this VIN fits \(all share it\)/);
  const hybrid = lookupEpaTestCars(car(2014, 'HONDA', 'Accord', {engine: {displacement_l: 2.4, ev_type: 'Strong HEV (Hybrid Electric Vehicle)'}}), file);
  assert.match(hybrid.hp_note, /This is a hybrid: EPA's rated horsepower is the engine's rating, not the combined system output/);
  const plugin = lookupEpaTestCars(car(2014, 'HONDA', 'Accord', {engine: {displacement_l: 2.4, ev_type: 'PHEV (Plug-in Hybrid Electric Vehicle)'}}), file);
  assert.match(plugin.hp_note, /This is a plug-in hybrid/);
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
  assert.match(out, /Rated power 240–255 hp \(maker’s EPA test vehicles for this engine family ?\)/);
  const hybridEpa = {...epa, rated_hp: {min: 145, max: 145}, hp_note: "This is a hybrid: EPA's rated horsepower is the engine's rating, not the combined system output of the engine and electric motor(s)."};
  assert.match(sources.engineRowsHtml({epa_test_vehicles: hybridEpa}).replace(/<[^>]+>/g, ' '), /145 hp \(engine rating, not the combined hybrid system output\)/);
  assert.match(sheet.html({...report, epa_test_vehicles: hybridEpa}).body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), /Rated power 145 hp \(engine rating ?, not the combined hybrid system output ?; maker’s EPA test vehicles for this engine family ?\)/);
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

// ---- NHTSA Part 583 (AALA) parts content and origin ----
import {lookupAala, carlineTier as aalaTier, decode} from '../lib/aala.mjs';

function aalaDb(file) {
  const db = new Database(file);
  db.exec(`CREATE TABLE aala(model_year INTEGER NOT NULL,manufacturer TEXT,make TEXT NOT NULL,carline TEXT NOT NULL,vehicle_type TEXT,us_canada_pct INTEGER NOT NULL,foreign_sources TEXT NOT NULL,final_assembly TEXT,final_assembly_additional TEXT,engine TEXT,engine_additional TEXT,transmission TEXT,transmission_additional TEXT,notes TEXT,flags TEXT NOT NULL,page INTEGER,make_compact TEXT NOT NULL,carline_compact TEXT NOT NULL,source_file TEXT NOT NULL);
    CREATE TABLE legends(model_year INTEGER NOT NULL,code TEXT NOT NULL,country TEXT NOT NULL,PRIMARY KEY(model_year,code));
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);`);
  db.prepare('INSERT INTO metadata VALUES(?,?)').run('source', JSON.stringify({indexed_at: '2026-11-17T00:00:00Z', sources: [{model_year: 2024, file: 'MY2024.pdf', url: 'https://www.nhtsa.gov/MY2024.pdf'}, {model_year: 2026, file: 'MY2026.pdf', url: 'https://www.nhtsa.gov/MY2026.pdf'}]}));
  const legend = db.prepare('INSERT INTO legends VALUES(?,?,?)');
  for (const [code, country] of [['US', 'United States'], ['J', 'Japan'], ['CN', 'Canada'], ['CH', 'China'], ['G', 'Germany']]) { legend.run(2024, code, country); legend.run(2026, code, country); }
  const ins = db.prepare('INSERT INTO aala VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const c = s => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const add = (y, make, carline, pct, foreign, fa, eng, tr, flags = []) => ins.run(y, make, make, carline, 'MPV', pct, JSON.stringify(foreign), fa, null, eng, null, tr, null, null, JSON.stringify(flags), 2, c(make), c(carline), `MY${y}.pdf`);
  add(2024, 'Honda', 'CR-V FWD', 60, [], 'US', 'US', 'US');
  add(2024, 'Honda', 'CR-V AWD', 60, [{pct: 15, code: 'J'}], 'CN', 'US', 'US');
  add(2024, 'Honda', 'CR-V AWD', 60, [{pct: 15, code: 'J'}], 'US', 'US', 'US');
  add(2024, 'Honda', 'CR-V AWD', 60, [{pct: 15, code: 'J'}], 'US', 'US', 'US'); // listed twice with the same figures
  add(2024, 'Honda', 'CR-V AWD', 60, [{pct: 15, code: 'J'}], 'US', 'J (2.0L)', 'J');
  add(2024, 'Honda', 'CR-V Hybrid AWD', 55, [{pct: 20, code: 'J'}], 'US', 'US', 'J');
  add(2026, 'Mitsubishi', 'Outlander Sport SE', 0, [{pct: 90, code: 'J'}], 'J', 'J', 'J');
  add(2026, 'Mitsubishi', 'Outlander SE 2WD', 1, [{pct: 85, code: 'J'}], 'J', 'J', 'J');
  add(2026, 'BMW', 'X3', 30, [{pct: 24, code: 'G'}], 'US', null, null, ['unreadable_engine', 'unreadable_trans']);
  db.close();
}

test('AALA parts content: carline, drive, hybrid and plant narrow the rows; every remaining version is shown; codes decode only from the legend', () => {
  const file = path.join(temp, 'aala.db');
  aalaDb(file);
  const crv = lookupAala({vehicle: {year: 2024, make: 'HONDA', model: 'CR-V', trim: 'Sport-L'}, transmission: {drive_type: '4WD/4-Wheel Drive/4x4'}, engine: {}, plant: {country: 'UNITED STATES (USA)'}}, file);
  assert.deepEqual([crv.available, crv.match, crv.vin_specific, crv.rows.length], [true, 'carline', false, 2]);
  assert.deepEqual(crv.match_basis, ['same model year, make and carline name', 'non-hybrid carline', 'four/all-wheel drive', "final assembly in the VIN's plant country (UNITED STATES (USA))"]);
  assert.deepEqual(crv.rows.map(r => [r.carline, r.engine_origin.countries, r.transmission_origin.countries, r.listed_times]), [['CR-V AWD', 'United States', 'United States', 2], ['CR-V AWD', 'Japan (2.0L)', 'Japan', 1]]);
  assert.deepEqual(crv.rows[0].other_major_sources, [{pct: 15, printed: 'J', country: 'Japan'}]);
  assert.match(crv.rows_note, /2 listed versions fit/);
  assert.match(crv.note, /not for this car/);
  const hybrid = lookupAala({vehicle: {year: 2024, make: 'HONDA', model: 'CR-V'}, transmission: {}, engine: {ev_type: 'Strong HEV (Hybrid Electric Vehicle)'}, plant: {}}, file);
  assert.deepEqual(hybrid.rows.map(r => [r.carline, r.us_canada_parts_pct]), [['CR-V Hybrid AWD', 55]]);
  // No "Outlander" carline: the closest names, preferring the one whose extra words are the VIN's trim
  const outlander = lookupAala({vehicle: {year: 2026, make: 'MITSUBISHI', model: 'Outlander', trim: 'SE'}, transmission: {}, engine: {}, plant: {}}, file);
  assert.deepEqual([outlander.match, outlander.rows.map(r => r.carline)], ['closest_carline', ['Outlander SE 2WD']]);
  assert.match(outlander.note, /Closest carline name: matched by same model year and make; no carline named Outlander/);
  const x3 = lookupAala({vehicle: {year: 2026, make: 'BMW', model: 'X3'}, transmission: {}, engine: {}, plant: {}}, file);
  assert.deepEqual([x3.rows[0].engine_origin, x3.rows[0].unreadable], [null, ['engine_origin', 'transmission_origin']]);
  assert.deepEqual(lookupAala({vehicle: {year: 2019, make: 'HONDA', model: 'CR-V'}}, file), {available: false, reason: 'model_year_not_covered', model_years_covered: [2024, 2026]});
  assert.deepEqual(lookupAala({vehicle: {year: 2024, make: 'HONDA', model: 'Pilot'}}, file), {available: false, reason: 'carline_not_listed', model_year: 2024});
  assert.deepEqual(lookupAala({vehicle: {year: 2024, make: 'HONDA', model: 'CR-V'}}, path.join(temp, 'none.db')), {available: false, reason: 'dataset_not_indexed'});
  assert.equal(aalaTier('CR-V', 'CR-V AWD'), 3);
  assert.equal(aalaTier('Outlander', 'Outlander Sport SE'), 2);
  assert.equal(aalaTier('Q5', 'SQ5'), 0);
  assert.equal(decode('G (3.3), A (3.4)', {G: 'Germany'}), 'Germany (3.3), A (3.4)');
});

test('the parts content card lists each version with its label, says unreadable columns aloud, and sits before the theft card', () => {
  const nodes = new Map();
  const node = id => ({id, remove() { nodes.delete(this.id); }, insertAdjacentElement(where, el) { nodes.set(el.id, el); el.after = this.id; }});
  nodes.set('card-plant', node('card-plant'));
  const ctx = {document: {querySelector: s => nodes.get(s.replace(/^#/, '')) || null, createElement: () => node(null)}, console};
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../public/more-sources.js', import.meta.url), 'utf8'), ctx);
  const sources = vm.runInContext('MoreSources', ctx);
  const parts = {available: true, model_year: 2024, match: 'carline', match_basis: ['same model year, make and carline name'], rows_note: '2 listed versions fit; the report does not say which applies to this car.',
    rows: [{carline: 'CR-V AWD', us_canada_parts_pct: 60, other_major_sources: [{pct: 15, printed: 'J', country: 'Japan'}], final_assembly: {printed: 'US', countries: 'United States'}, engine_origin: {printed: 'US', countries: 'United States'}, transmission_origin: {printed: 'US', countries: 'United States'}},
      {carline: 'CR-V AWD', us_canada_parts_pct: 60, other_major_sources: [{pct: 15, printed: 'MX', country: null}], final_assembly: {printed: 'US', countries: 'United States'}, engine_origin: null, transmission_origin: null, unreadable: ['engine_origin']}],
    source: {url: 'https://www.nhtsa.gov/MY2024.pdf'}};
  sources.render({parts_content: parts, production_theft: {available: true, model_year: 2012, calendar_year: 2012, match: 'line_name', lines: [{manufacturer: 'VOLKSWAGEN', line: 'PASSAT', production: 95583, thefts: 107, thefts_per_1000_produced: 1.1194, rank: 57, lines_ranked: 211}]}});
  const card = nodes.get('card-parts-content');
  assert.equal(card.after, 'card-plant');
  assert.equal(nodes.get('card-production-theft').after, 'card-parts-content');
  const text = card.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, /Parts content and origin/);
  assert.match(text, /CR-V AWD \(listed version 1 of 2\) US\/Canadian parts content 60% Other major sources Japan 15% Final assembly United States Engine\/motor from United States/);
  assert.match(text, /listed version 2 of 2\) US\/Canadian parts content 60% Other major sources MX 15% Final assembly United States Engine\/motor from Not readable in the report/);
  assert.doesNotMatch(text, /Transmission from Not readable/); // only the columns the importer marked
  assert.match(text, /2 listed versions fit; the report does not say which applies to this car\. Figures for the whole carline .* not this car/);
  sources.render({parts_content: {available: false, reason: 'model_year_not_covered'}});
  assert.equal(nodes.has('card-parts-content'), false);
  assert.equal(nodes.has('card-production-theft'), false);
});

// ---- FuelEconomy.gov match disclosure (fuel card and car sheet) ----
const several = {available: false, reason: 'ambiguous_variant', match: 'multiple_configurations', combined_mpg: null,
  summary: '47-50 mpg combined across 2 EPA configurations of this model; the VIN does not say which: EPA listing: Normal/Eco Modes or Sport/Normal/Eco Modes',
  separated_by: ['EPA listing: Normal/Eco Modes or Sport/Normal/Eco Modes'],
  mpg_range: {unit: 'mpg', combined: {min: 47, max: 50}, city: {min: 50, max: 53}, highway: {min: 43, max: 46}}, configuration_count: 2,
  configurations: [
    {vehicle_id: '49139', epa_model: 'Corolla Hybrid (Normal/Eco Modes)', transmission: 'Automatic (variable gear ratios)', displacement: 1.8, cylinders: 4, combined_mpg: 50, city_mpg: 53, highway_mpg: 46, unit: 'mpg', source_url: 'https://www.fueleconomy.gov/feg/Find.do?action=sbs&id=49139', label: 'Normal/Eco Modes'},
    {vehicle_id: '48490', epa_model: 'Corolla Hybrid (Sport/Normal/Eco Modes)', transmission: 'Automatic (variable gear ratios)', displacement: 1.8, cylinders: 4, combined_mpg: 47, city_mpg: 50, highway_mpg: 43, unit: 'mpg', source_url: 'https://www.fueleconomy.gov/feg/Find.do?action=sbs&id=48490', label: 'Sport/Normal/Eco Modes'}],
  match_basis: ['same model year, make and model name', '1.8 L engine', 'hybrid powertrain', 'transmission not checked (not in the VIN decode)']};

const sameRating = {available: true, match: 'same_rating', closest: false, combined_mpg: 18, city_mpg: null, highway_mpg: 21, unit: 'mpg', configuration_count: 2,
  summary: '18 mpg combined for both EPA configurations this VIN fits, so the figure holds whichever it is (they differ in 5-speed automatic or 6-speed manual)',
  matched_variant: '2 EPA configurations (Wrangler 4WD), all 18 mpg combined', separated_by: ['5-speed automatic or 6-speed manual'],
  configurations: [
    {vehicle_id: '37000', epa_model: 'Wrangler 4WD', transmission: 'Automatic 5-spd', displacement: 3.6, cylinders: 6, combined_mpg: 18, city_mpg: 16, highway_mpg: 21, unit: 'mpg', label: '5-speed automatic'},
    {vehicle_id: '37001', epa_model: 'Wrangler 4WD', transmission: 'Manual 6-spd', displacement: 3.6, cylinders: 6, combined_mpg: 18, city_mpg: 17, highway_mpg: 21, unit: 'mpg', label: '6-speed manual'}],
  match_basis: ['3.6 L engine']};

test('fuel card: several EPA configurations show their range and each one; a closest match says so; heavy-duty says why', () => {
  const {els, run} = frontend();
  run(`renderFuel({fuel_economy: ${JSON.stringify(several)}})`);
  const body = els.get('#fuel-body').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(body, /47–50 Combined mpg, range/);
  assert.match(body, /Normal\/Eco Modes: 50 mpg combined \(53 city, 46 highway\) \(EPA: Corolla Hybrid \(Normal\/Eco Modes\) · Automatic \(variable gear ratios\), 1\.8 L, 4 cyl\) EPA/);
  assert.match(body, /the VIN does not say which/);
  assert.match(body, /EPA rates configurations, not individual cars\. Matched by: same model year, make and model name; 1\.8 L engine/);
  assert.doesNotMatch(body, /Multiple EPA variants match/);
  run(`renderFuel({fuel_economy: {available: true, match: 'exact', combined_mpg: 22, city_mpg: 19, highway_mpg: 27, co2_grams_per_mile: 403.95454545454544}})`);
  assert.match(els.get('#fuel-body').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), /CO2 \(g\/mile\) 404 /);
  run(`renderFuel({fuel_economy: {available: true, match: 'closest', combined_mpg: 21, city_mpg: 18, highway_mpg: 25, matched_variant: 'Acadia AWD · Automatic 9-spd, 6 cyl, 3.6 L', match_basis: ['3.6 L engine', 'differs: the VIN says 6 speeds; EPA lists Automatic 9-spd']}})`);
  const closest = els.get('#fuel-body').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(closest, /Closest EPA configuration, not an exact match\. Matched by: 3\.6 L engine; differs from the VIN: the VIN says 6 speeds; EPA lists Automatic 9-spd\./);
  // The same combined rating for every configuration: the figure, the note and each configuration with what separates it.
  run(`renderFuel({fuel_economy: ${JSON.stringify(sameRating)}})`);
  const same = els.get('#fuel-body').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(same, /21 Highway MPG 18 Combined MPG/);
  assert.doesNotMatch(same, /City MPG/);
  assert.match(same, /18 mpg combined for both EPA configurations this VIN fits, so the figure holds whichever it is \(they differ in 5-speed automatic or 6-speed manual\)\. 5-speed automatic: 18 mpg combined \(16 city, 21 highway\)/);
  assert.match(same, /6-speed manual: 18 mpg combined \(17 city, 21 highway\).*Matched by: 3\.6 L engine\./);
  assert.doesNotMatch(same, /Closest EPA/);
  run(`renderFuel({fuel_economy: {available: false, reason: 'heavy_duty_not_rated', match_basis: ['gross vehicle weight rating over 8,500 lb']}})`);
  assert.match(els.get('#fuel-body').innerHTML, /do not cover heavy-duty pickups and vans/);
  run(`renderFuel({fuel_economy: {available: false, reason: 'not_found', match_basis: ['no EPA model name for this model year matches "Versa Note"']}})`);
  assert.match(els.get('#fuel-body').innerHTML, /Checked: no EPA model name for this model year matches "Versa Note"\./);
});

test('car sheet: the EPA range when several configurations fit, the closest-match label otherwise', () => {
  const ctx = {console, URLSearchParams, setTimeout};
  vm.createContext(ctx);
  for (const file of ['qr.js', 'car-sheet.js', 'more-sources.js']) vm.runInContext(readFileSync(new URL('../public/' + file, import.meta.url), 'utf8'), ctx);
  const sheet = vm.runInContext('CarSheet', ctx);
  const base = {vin: '1HGCM82633A004352', vehicle: {year: 2025, make: 'TOYOTA', model: 'Corolla'}, engine: {displacement_l: 1.8, cylinders: 4}, transmission: {}, raw_nhtsa: {}, recalls: {available: true, count: 0, recalls: []}};
  const text = r => sheet.html(r).body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text({...base, fuel_economy: several}), /EPA fuel economy 47–50 mpg combined \(50–53 city, 43–46 hwy\).*EPA range: 47-50 mpg combined across 2 EPA configurations of this model; the VIN does not say which/);
  assert.match(text({...base, fuel_economy: {available: true, match: 'closest', combined_mpg: 21, city_mpg: 18, highway_mpg: 25, matched_variant: 'Acadia AWD · Automatic 9-spd, 6 cyl, 3.6 L'}}), /EPA fuel economy 21 mpg combined \(18 city, 25 hwy\).*Closest EPA configuration, not an exact match ?: Acadia AWD/);
  assert.match(text({...base, fuel_economy: sameRating}), /EPA fuel economy 18 mpg combined .*18 mpg combined for both EPA configurations this VIN fits/);
  const phev = text({...base, fuel_economy: {available: true, match: 'exact', combined_mpg: 40, city_mpg: 43, highway_mpg: 38, ev_range: 37, total_range: 520}});
  assert.match(phev, /EPA electric range 37 mi/);
  assert.doesNotMatch(phev, /520/);
});

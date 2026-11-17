import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {getFuelEconomy} from '../lib/epa.mjs';
import {nameRelation, modelAlternatives} from '../lib/fueleconomy-match.mjs';

// A small FuelEconomy.gov table built by the real importer (scripts/import-fueleconomy.py).
const temp = mkdtempSync(path.join(tmpdir(), 'vin-fueleconomy-'));
const file = path.join(temp, 'fueleconomy.db');
test.after(() => rmSync(temp, {recursive: true, force: true}));

const V = (id, year, make, model, o = {}) => ({id, year, make, model, baseModel: o.base || model.split(' ')[0], drive: o.drive || 'Front-Wheel Drive', trany: o.trany || 'Automatic (S6)',
  displ: o.displ ?? '', cylinders: o.cyl ?? '', atvType: o.atv || '', fuelType: o.fuel || 'Regular', eng_dscr: o.dscr || '', tCharger: o.turbo ? 'T' : '', VClass: o.vclass || 'Midsize Cars',
  city08: o.city ?? '', highway08: o.hwy ?? '', comb08: o.comb ?? '', range: o.range ?? '0', rangeA: o.rangeA ?? ''});
const ROWS = [
  V(35918, 2015, 'Ford', 'F150 Pickup 2WD', {base: 'F150', drive: 'Rear-Wheel Drive', displ: 2.7, cyl: 6, turbo: 1, city: 19, hwy: 26, comb: 22}),
  V(35922, 2015, 'Ford', 'F150 Pickup 4WD', {base: 'F150', drive: 'Part-time 4-Wheel Drive', displ: 2.7, cyl: 6, turbo: 1, city: 18, hwy: 23, comb: 20}),
  V(35924, 2015, 'Ford', 'F150 Pickup 4WD FFV', {base: 'F150', drive: 'Part-time 4-Wheel Drive', trany: 'Automatic 6-spd', displ: 3.5, cyl: 6, atv: 'FFV', fuel: 'Gasoline or E85', city: 17, hwy: 23, comb: 19}),
  V(49139, 2025, 'Toyota', 'Corolla Hybrid (Normal/Eco Modes)', {trany: 'Automatic (variable gear ratios)', displ: 1.8, cyl: 4, atv: 'Hybrid', city: 53, hwy: 46, comb: 50}),
  V(48490, 2025, 'Toyota', 'Corolla Hybrid (Sport/Normal/Eco Modes)', {trany: 'Automatic (variable gear ratios)', displ: 1.8, cyl: 4, atv: 'Hybrid', city: 50, hwy: 43, comb: 47}),
  V(48800, 2025, 'Toyota', 'Corolla', {trany: 'Automatic (variable gear ratios)', displ: 2.0, cyl: 4, city: 32, hwy: 41, comb: 35}),
  V(48900, 2025, 'Toyota', 'Corolla Cross Hybrid AWD', {base: 'Corolla Cross', drive: 'All-Wheel Drive', trany: 'Automatic (AV-S6)', displ: 2.0, cyl: 4, atv: 'Hybrid', city: 45, hwy: 38, comb: 42}),
  V(23000, 2007, 'Toyota', 'Camry Solara', {base: 'Camry', displ: 2.4, cyl: 4, city: 21, hwy: 31, comb: 25}),
  V(42200, 2020, 'GMC', 'Acadia AWD', {base: 'Acadia', drive: 'All-Wheel Drive', trany: 'Automatic 9-spd', displ: 3.6, cyl: 6, city: 18, hwy: 25, comb: 21}),
  V(42201, 2020, 'GMC', 'Acadia FWD', {base: 'Acadia', trany: 'Automatic 9-spd', displ: 3.6, cyl: 6, city: 18, hwy: 25, comb: 22}),
  V(35100, 2015, 'Chevrolet', 'Colorado 4WD', {base: 'Colorado', drive: '4-Wheel Drive', trany: 'Automatic 6-spd', displ: 2.5, cyl: 4, city: 19, hwy: 24, comb: 21}),
  V(35101, 2015, 'Chevrolet', 'Colorado 4WD', {base: 'Colorado', drive: '4-Wheel Drive', trany: 'Automatic 6-spd', displ: 3.6, cyl: 6, city: 17, hwy: 24, comb: 20}),
  V(47814, 2024, 'Chevrolet', 'Equinox EV FWD', {base: 'Equinox', trany: 'Automatic (A1)', atv: 'EV', fuel: 'Electricity', city: 117, hwy: 99, comb: 108, range: 319}),
  V(47000, 2024, 'Chevrolet', 'Equinox FWD', {base: 'Equinox', displ: 1.5, cyl: 4, turbo: 1, city: 26, hwy: 31, comb: 28}),
  V(40100, 2019, 'Kia', 'Niro', {trany: 'Automatic (AM6)', displ: 1.6, cyl: 4, atv: 'Hybrid', city: 52, hwy: 46, comb: 49}),
  V(40101, 2019, 'Kia', 'Niro FE', {trany: 'Automatic (AM6)', displ: 1.6, cyl: 4, atv: 'Hybrid', city: 52, hwy: 49, comb: 50}),
  V(40102, 2019, 'Kia', 'Niro Touring', {trany: 'Automatic (AM6)', displ: 1.6, cyl: 4, atv: 'Hybrid', city: 46, hwy: 40, comb: 43}),
  V(24266, 2008, 'Scion', 'xD', {trany: 'Automatic 4-spd', displ: 1.8, cyl: 4, city: 27, hwy: 33, comb: 28}),
  V(24267, 2008, 'Scion', 'xD', {trany: 'Manual 5-spd', displ: 1.8, cyl: 4, city: 26, hwy: 33, comb: 29}),
  V(44931, 2022, 'Ford', 'Escape FWD PHEV', {base: 'Escape', trany: 'Automatic (variable gear ratios)', displ: 2.5, cyl: 4, atv: 'Plug-in Hybrid', city: 43, hwy: 38, comb: 40, range: 520, rangeA: 37}),
  V(46946, 2024, 'Chevrolet', 'Silverado EV', {base: 'Silverado', drive: 'All-Wheel Drive', trany: 'Automatic (A1)', atv: 'EV', fuel: 'Electricity', city: 69, hwy: 57, comb: 63, range: 450}),
];
const EMISSIONS = [['FFMXT02.73DH', 35922], ['STYXV01.8P3A', 49139], ['STYXV01.8P3A', 48490], ['STYXV01.8Q2B', 48490], ['MGMXT03.65A1', 42200]];

const columns = ['id', 'year', 'make', 'model', 'baseModel', 'drive', 'trany', 'displ', 'cylinders', 'atvType', 'fuelType', 'eng_dscr', 'tCharger', 'VClass', 'city08', 'highway08', 'comb08', 'range', 'rangeA'];
const csvText = (header, rows) => [header.join(','), ...rows.map(r => header.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n') + '\n';
writeFileSync(path.join(temp, 'vehicles.csv'), csvText(columns, ROWS));
writeFileSync(path.join(temp, 'emissions.csv'), csvText(['efid', 'id', 'salesArea'], EMISSIONS.map(([efid, id]) => ({efid, id, salesArea: 7}))));
execFileSync('python3', ['-I', '-c', `
import importlib.util, pathlib, sys, zipfile
spec = importlib.util.spec_from_file_location('imp', sys.argv[1]); imp = importlib.util.module_from_spec(spec); spec.loader.exec_module(imp)
d = pathlib.Path(sys.argv[2])
for n in ('vehicles', 'emissions'):
    with zipfile.ZipFile(d / (n + '.csv.zip'), 'w') as z: z.write(d / (n + '.csv'), n + '.csv')
imp.build(d / 'vehicles.csv.zip', d / 'emissions.csv.zip', d / 'fueleconomy.db', [{'file': 'vehicles.csv.zip', 'url': 'https://www.fueleconomy.gov/feg/epadata/vehicles.csv.zip', 'last_modified': 'Wed, 04 Nov 2026 14:31:23 GMT'}])
`, new URL('../scripts/import-fueleconomy.py', import.meta.url).pathname, temp]);

const originalFetch = globalThis.fetch;
test.beforeEach(() => { globalThis.fetch = async url => { throw new Error('the local index must not call the web service: ' + url); }; });
test.afterEach(() => { globalThis.fetch = originalFetch; });

const vin = (year, make, model, o = {}) => ({
  vehicle: {year, make, model, trim: o.trim ?? null, body_class: o.body ?? null, doors: o.doors ?? null},
  engine: {displacement_l: o.displ ?? null, cylinders: o.cyl ?? null, fuel_type: o.fuel ?? 'Gasoline', ev_type: o.ev ?? null, turbo: o.turbo ?? null},
  transmission: {type: o.trans ?? null, speeds: o.speeds ?? null, drive_type: o.drive ?? null},
  dimensions: {gvwr: o.gvwr ?? null}, raw: o.raw || {},
});
const fuel = d => getFuelEconomy(d.vehicle.year, d.vehicle.make, d.vehicle.model, d, {file});

test('EPA names: drive, powertrain, body and bracketed words describe one model; other words are another model', () => {
  assert.ok(nameRelation('F150 Pickup 4WD', 'F-150'));
  assert.ok(nameRelation('Corolla Hybrid AWD (Normal/Eco Modes)', 'Corolla'));
  assert.ok(nameRelation('Ioniq 5 RWD (Long Range)', 'Ioniq 5'));
  assert.ok(nameRelation('Prius Prime', 'Prius Prime (PHEV)'));
  assert.ok(nameRelation('2 Dual Motor', 'Polestar 2', {make: 'POLESTAR'}));
  assert.ok(nameRelation('3 4-Door 2WD', 'Mazda3', {make: 'MAZDA'}));
  assert.equal(nameRelation('Corolla Cross Hybrid AWD', 'Corolla'), null);
  assert.equal(nameRelation('Camry Solara', 'Camry'), null);
  assert.equal(nameRelation('Ioniq 5 AWD (Long Range)', 'Ioniq'), null);
  assert.equal(nameRelation('Range Rover Sport', 'Range Rover'), null);
  assert.ok(nameRelation('X1 xDrive28i', 'X1', {trimWords: new Set(['XDRIVE28I'])}));
  assert.equal(nameRelation('X1 xDrive28i', 'X1'), null);
  assert.deepEqual(modelAlternatives('Mazda3', 'MAZDA'), ['MAZDA3', '3']);
});

test('exact: the one FuelEconomy.gov configuration that fits every attribute the VIN gives, with its test group', async () => {
  const f = await fuel(vin(2015, 'FORD', 'F-150', {displ: 2.7, cyl: 6, drive: '4WD/4-Wheel Drive/4x4', body: 'Pickup'}));
  assert.equal(f.available, true);
  assert.deepEqual([f.match, f.vehicle_id, f.combined_mpg, f.city_mpg, f.highway_mpg, f.epa_model], ['exact', '35922', 20, 18, 23, 'F150 Pickup 4WD']);
  assert.deepEqual(f.efids, ['FFMXT02.73DH']);
  assert.equal(f.matched_variant, 'F150 Pickup 4WD · Automatic (S6), 6 cyl, 2.7 L');
  assert.match(f.summary, /^20 mpg combined \(18 city, 23 highway\): EPA's 2015 Ford F150 Pickup 4WD/);
  assert.ok(f.match_basis.includes('transmission not checked (not in the VIN decode)'));
  assert.match(f.data_source, /vehicles\.csv \(file dated Wed, 04 Nov 2026 14:31:23 GMT\), local index/);
  assert.equal(f.source_url, 'https://www.fueleconomy.gov/feg/Find.do?action=sbs&id=35922');
  // An electric VIN only ever matches the electric listing.
  const ev = await fuel(vin(2024, 'CHEVROLET', 'Equinox', {fuel: 'Electric', ev: 'BEV (Battery Electric Vehicle)', drive: 'FWD/Front-Wheel Drive'}));
  assert.deepEqual([ev.match, ev.epa_model, ev.combined_mpg, ev.unit, ev.is_ev, ev.ev_range, ev.total_range], ['exact', 'Equinox EV FWD', 108, 'MPGe', true, 319, null]);
  // A plug-in hybrid: EPA's `range` is gasoline plus electric; ev_range is the all-electric range.
  const phev = await fuel(vin(2022, 'FORD', 'Escape', {displ: 2.5, cyl: 4, ev: 'PHEV (Plug-in Hybrid Electric Vehicle)', trim: 'SEL PHEV'}));
  assert.deepEqual([phev.match, phev.epa_model, phev.combined_mpg, phev.ev_range, phev.total_range], ['exact', 'Escape FWD PHEV', 40, 37, 520]);
});

test('several configurations: nothing is picked; the range, every configuration and the shared test group are returned', async () => {
  const f = await fuel(vin(2025, 'TOYOTA', 'Corolla', {displ: 1.8, cyl: 4, ev: 'HEV (Hybrid Electric Vehicle) - Level Unknown', drive: '4x2', trim: 'LE, XLE, SE', body: 'Sedan/Saloon'}));
  assert.deepEqual([f.available, f.reason, f.match, f.combined_mpg], [false, 'ambiguous_variant', 'multiple_configurations', null]);
  assert.deepEqual(f.mpg_range, {unit: 'mpg', combined: {min: 47, max: 50}, city: {min: 50, max: 53}, highway: {min: 43, max: 46}});
  assert.deepEqual(f.configurations.map(c => c.epa_model).sort(), ['Corolla Hybrid (Normal/Eco Modes)', 'Corolla Hybrid (Sport/Normal/Eco Modes)']);
  assert.match(f.summary, /^47-50 mpg combined across 2 EPA configurations of this model; the VIN does not say which \(they differ in EPA listing/);
  assert.deepEqual(f.efids, ['STYXV01.8P3A']); // shared by both; STYXV01.8Q2B is only one's
  // Never the Corolla Cross or the gasoline Corolla.
  assert.ok(f.configurations.every(c => !/Cross/.test(c.epa_model) && c.powertrain === 'hybrid'));
});

test('closest: what differs is stated; the engine is never another size; cylinders relax only when the size agrees', async () => {
  const acadia = await fuel(vin(2020, 'GMC', 'Acadia', {displ: 3.6, cyl: 6, trans: 'Automatic', speeds: 6, drive: 'AWD/All-Wheel Drive'}));
  assert.deepEqual([acadia.available, acadia.match, acadia.vehicle_id, acadia.combined_mpg], [true, 'closest', '42200', 21]);
  assert.ok(acadia.match_basis.includes('differs: the VIN says 6 speeds; EPA lists Automatic 9-spd'));
  assert.match(acadia.summary, /closest EPA configuration.*Not an exact match: the VIN says 6 speeds/);
  // vPIC says 6 cylinders for the 2.5 L: the 2.5 L (4 cylinders) is closest, said so.
  const colorado = await fuel(vin(2015, 'CHEVROLET', 'Colorado', {displ: 2.5, cyl: 6, drive: '4WD/4-Wheel Drive/4x4'}));
  assert.deepEqual([colorado.match, colorado.displacement, colorado.cylinders], ['closest', 2.5, 4]);
  assert.ok(colorado.match_basis.some(b => /VIN says 6 cylinders; EPA lists the 2\.5 L engine with 4/.test(b)));
  // Cylinders without a size are the engine attribute: no 8-cylinder Colorado, no match.
  const v8 = await fuel(vin(2015, 'CHEVROLET', 'Colorado', {cyl: 8}));
  assert.deepEqual([v8.available, v8.reason, v8.match], [false, 'no_matching_variant', null]);
  const size = await fuel(vin(2015, 'FORD', 'F-150', {displ: 5.0}));
  assert.deepEqual([size.reason, size.match_basis.at(-1)], ['no_matching_variant', "the VIN's 5.0 L engine is not among EPA's 2.7 L, 3.5 L for this model"]);
});

test('powertrain, model and weight class are never substituted', async () => {
  const hybrid = await fuel(vin(2024, 'CHEVROLET', 'Equinox', {displ: 1.5, ev: 'Strong HEV (Hybrid Electric Vehicle)'}));
  assert.deepEqual([hybrid.available, hybrid.reason], [false, 'no_matching_variant']);
  assert.match(hybrid.match_basis.at(-1), /the VIN says hybrid; EPA lists this model only as/);
  const camry = await fuel(vin(2007, 'TOYOTA', 'Camry', {displ: 2.4}));
  assert.deepEqual([camry.available, camry.reason], [false, 'not_found']); // only Camry Solara is listed
  const hd = await fuel(vin(2024, 'CHEVROLET', 'Silverado', {displ: 6.6, body: 'Pickup', gvwr: 'Class 2H: 9,001 - 10,000 lb (4,082 - 4,536 kg)', raw: {Series: '2500 HD'}}));
  assert.deepEqual([hd.available, hd.reason], [false, 'heavy_duty_not_rated']);
  // A heavy electric pickup that EPA does list is matched as usual.
  const ev = await fuel(vin(2024, 'CHEVROLET', 'Silverado', {fuel: 'Electric', ev: 'BEV (Battery Electric Vehicle)', body: 'Pickup', gvwr: 'Class 2H: 9,001 - 10,000 lb (4,082 - 4,536 kg)'}));
  assert.deepEqual([ev.match, ev.epa_model], ['exact', 'Silverado EV']);
});

test('trims: each trim the VIN allows keeps its listing or the base listing; sub-brands are found under their own make', async () => {
  const either = await fuel(vin(2019, 'KIA', 'Niro', {displ: 1.6, ev: 'HEV (Hybrid Electric Vehicle) - Level Unknown', trim: 'FE (HEV), LX (HEV)'}));
  assert.deepEqual([either.match, either.configurations.map(c => c.epa_model).sort()], ['multiple_configurations', ['Niro', 'Niro FE']]);
  const fe = await fuel(vin(2019, 'KIA', 'Niro', {displ: 1.6, ev: 'HEV (Hybrid Electric Vehicle) - Level Unknown', trim: 'FE'}));
  assert.deepEqual([fe.match, fe.epa_model, fe.combined_mpg], ['exact', 'Niro FE', 50]);
  const scion = await fuel(vin(2008, 'TOYOTA', 'Scion xD', {displ: 1.8}));
  assert.equal(scion.match, 'multiple_configurations');
  assert.match(scion.match_basis[0], /EPA lists "Scion xD" under the make Scion/);
  assert.deepEqual(scion.mpg_range.combined, {min: 28, max: 29});
});

test('without the index, or with nothing for the year and make, the FuelEconomy.gov web service is asked', async () => {
  const urls = [];
  globalThis.fetch = async url => { urls.push(String(url)); return Response.json(String(url).includes('menu/options') ? {menuItem: {text: 'Auto 6-spd, 4 cyl, 2.5 L', value: '777'}} : {id: 777, year: 2026, make: 'Mazda', model: 'CX-5', cylinders: 4, displ: 2.5, trany: 'Automatic 6-spd', drive: 'All-Wheel Drive', comb08: 28}); };
  const f = await getFuelEconomy(2026, 'MAZDA', 'CX-5', vin(2026, 'MAZDA', 'CX-5', {displ: 2.5}), {file});
  assert.deepEqual([f.available, f.vehicle_id, f.match, f.data_source], [true, '777', 'exact', 'fueleconomy.gov web service']);
  assert.equal(urls.length, 2);
  const missing = await getFuelEconomy(2026, 'MAZDA', 'CX-5', vin(2026, 'MAZDA', 'CX-5', {displ: 2.5}), {file: path.join(temp, 'none.db')});
  assert.equal(missing.data_source, 'fueleconomy.gov web service');
});

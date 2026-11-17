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
  // pass 2 rules
  V(31000, 2012, 'Chevrolet', 'Suburban 1500 2WD', {base: 'Suburban', drive: 'Rear-Wheel Drive', trany: 'Automatic 6-spd', displ: 5.3, cyl: 8, city: 15, hwy: 21, comb: 17}),
  V(31001, 2012, 'Chevrolet', 'Suburban 2500 2WD', {base: 'Suburban', drive: 'Rear-Wheel Drive', trany: 'Automatic 6-spd', displ: 5.3, cyl: 8, city: 12, hwy: 17, comb: 14}),
  V(40500, 2019, 'Ram', '1500 2WD', {base: '1500', drive: 'Rear-Wheel Drive', trany: 'Automatic 8-spd', displ: 3.6, cyl: 6, city: 20, hwy: 25, comb: 22}),
  V(40501, 2019, 'Ram', '1500 Classic 2WD', {base: '1500', drive: 'Rear-Wheel Drive', trany: 'Automatic 8-spd', displ: 3.6, cyl: 6, city: 17, hwy: 25, comb: 20}),
  V(33000, 2013, 'Ford', 'Fusion FWD', {base: 'Fusion', displ: 2.5, cyl: 4, city: 22, hwy: 34, comb: 26}),
  V(33001, 2013, 'Ford', 'Fusion Energi Plug-in Hybrid', {base: 'Fusion', trany: 'Automatic (variable gear ratios)', displ: 2.0, cyl: 4, atv: 'Plug-in Hybrid', city: 40, hwy: 36, comb: 38, range: 620, rangeA: 21}),
  V(21000, 2005, 'Toyota', 'Matrix', {trany: 'Manual 5-spd', displ: 1.8, cyl: 4, city: 30, hwy: 36, comb: 32}),
  V(21001, 2005, 'Toyota', 'Corolla', {trany: 'Manual 5-spd', displ: 1.8, cyl: 4, city: 32, hwy: 40, comb: 35}),
  V(46000, 2023, 'MINI', 'Cooper S Countryman', {base: 'Countryman', trany: 'Automatic (AM-S7)', displ: 2.0, cyl: 4, turbo: 1, city: 24, hwy: 33, comb: 28}),
  V(46001, 2023, 'MINI', 'Cooper Countryman', {base: 'Countryman', trany: 'Automatic (S8)', displ: 1.5, cyl: 3, turbo: 1, city: 25, hwy: 33, comb: 28}),
  V(44653, 2022, 'Lexus', 'NX 250 AWD', {base: 'NX', drive: 'All-Wheel Drive', trany: 'Automatic (S8)', displ: 2.5, cyl: 4, city: 25, hwy: 32, comb: 28}),
  V(44654, 2022, 'Lexus', 'NX 350 AWD', {base: 'NX', drive: 'All-Wheel Drive', trany: 'Automatic (S8)', displ: 2.4, cyl: 4, turbo: 1, city: 22, hwy: 29, comb: 25}),
  V(48000, 2025, 'Volkswagen', 'Tiguan', {trany: 'Automatic (S8)', displ: 2.0, cyl: 4, turbo: 1, city: 24, hwy: 33, comb: 27}),
  V(48001, 2025, 'Volkswagen', 'Tiguan 4motion', {base: 'Tiguan', drive: 'All-Wheel Drive', trany: 'Automatic (S8)', displ: 2.0, cyl: 4, turbo: 1, city: 22, hwy: 30, comb: 25}),
  V(41000, 2020, 'Tesla', 'Model Y Performance AWD', {base: 'Model Y', drive: 'All-Wheel Drive', trany: 'Automatic (A1)', atv: 'EV', fuel: 'Electricity', city: 127, hwy: 114, comb: 121, range: 315}),
  V(41001, 2020, 'Tesla', 'Model Y Performance AWD (21in Wheels)', {base: 'Model Y', drive: 'All-Wheel Drive', trany: 'Automatic (A1)', atv: 'EV', fuel: 'Electricity', city: 115, hwy: 106, comb: 111, range: 291}),
  V(41002, 2020, 'Tesla', 'Model Y Long Range AWD', {base: 'Model Y', drive: 'All-Wheel Drive', trany: 'Automatic (A1)', atv: 'EV', fuel: 'Electricity', city: 128, hwy: 113, comb: 121, range: 316}),
  V(41003, 2020, 'Tesla', 'Model Y Long Range RWD', {base: 'Model Y', drive: 'Rear-Wheel Drive', trany: 'Automatic (A1)', atv: 'EV', fuel: 'Electricity', city: 131, hwy: 117, comb: 125, range: 320}),
  V(41100, 2020, 'Nissan', 'Leaf (40 kW-hr battery pack)', {base: 'Leaf', trany: 'Automatic (A1)', atv: 'EV', fuel: 'Electricity', city: 123, hwy: 99, comb: 111, range: 149}),
  V(41101, 2020, 'Nissan', 'Leaf (62 kW-hr battery pack)', {base: 'Leaf', trany: 'Automatic (A1)', atv: 'EV', fuel: 'Electricity', city: 118, hwy: 97, comb: 108, range: 226}),
  V(51000, 2026, 'Kia', 'EV9 Standard Range RWD', {base: 'EV9', drive: 'Rear-Wheel Drive', trany: 'Automatic (A1)', atv: 'EV', fuel: 'Electricity', city: 97, hwy: 79, comb: 88, range: 230}),
  V(51001, 2026, 'Kia', 'EV9 Long Range RWD', {base: 'EV9', drive: 'Rear-Wheel Drive', trany: 'Automatic (A1)', atv: 'EV', fuel: 'Electricity', city: 100, hwy: 78, comb: 89, range: 305}),
  V(47500, 2024, 'Genesis', 'GV60 Advanced (19 inch Wheels)', {base: 'GV60', drive: 'All-Wheel Drive', trany: 'Automatic (A1)', atv: 'EV', fuel: 'Electricity', city: 109, hwy: 91, comb: 100, range: 264}),
  V(47501, 2024, 'Genesis', 'GV60 Advanced (20 inch Wheels)', {base: 'GV60', drive: 'All-Wheel Drive', trany: 'Automatic (A1)', atv: 'EV', fuel: 'Electricity', city: 103, hwy: 86, comb: 95, range: 248}),
  V(36000, 2016, 'Nissan', 'Versa', {trany: 'Automatic (variable gear ratios)', displ: 1.6, cyl: 4, city: 31, hwy: 39, comb: 34}),
  V(36001, 2016, 'Nissan', 'Versa', {trany: 'Manual 5-spd', displ: 1.6, cyl: 4, city: 27, hwy: 36, comb: 30}),
  V(37000, 2017, 'Jeep', 'Wrangler 4WD', {base: 'Wrangler', drive: '4-Wheel Drive', trany: 'Automatic 5-spd', displ: 3.6, cyl: 6, city: 16, hwy: 21, comb: 18}),
  V(37001, 2017, 'Jeep', 'Wrangler 4WD', {base: 'Wrangler', drive: '4-Wheel Drive', trany: 'Manual 6-spd', displ: 3.6, cyl: 6, city: 17, hwy: 21, comb: 18}),
  V(31500, 2012, 'Dodge', 'Journey FWD', {base: 'Journey', trany: 'Automatic 6-spd', displ: 3.6, cyl: 6, atv: 'FFV', fuel: 'Gasoline or E85', city: 17, hwy: 25, comb: 20}),
  V(31506, 2012, 'Dodge', 'Journey AWD', {base: 'Journey', drive: 'All-Wheel Drive', trany: 'Automatic 6-spd', displ: 3.6, cyl: 6, city: 16, hwy: 24, comb: 19}),
  V(31441, 2012, 'Dodge', 'Ram 1500 Pickup 2WD', {base: 'Ram 1500 Pickup', drive: 'Rear-Wheel Drive', trany: 'Automatic 6-spd', displ: 5.7, cyl: 8, city: 14, hwy: 20, comb: 16}),
  V(47828, 2024, 'Honda', 'Prologue FWD', {base: 'Prologue', trany: 'Automatic (A1)', atv: 'EV', fuel: 'Electricity', city: 107, hwy: 90, comb: 99, range: 296}),
  V(47829, 2024, 'Honda', 'Prologue AWD Elite', {base: 'Prologue', drive: 'All-Wheel Drive', trany: 'Automatic (A1)', atv: 'EV', fuel: 'Electricity', city: 99, hwy: 84, comb: 92, range: 273}),
  V(47830, 2024, 'Honda', 'Prologue AWD Touring', {base: 'Prologue', drive: 'All-Wheel Drive', trany: 'Automatic (A1)', atv: 'EV', fuel: 'Electricity', city: 101, hwy: 88, comb: 95, range: 281}),
  V(37800, 2017, 'Honda', 'Ridgeline FWD', {base: 'Ridgeline', trany: 'Automatic 6-spd', displ: 3.5, cyl: 6, city: 19, hwy: 26, comb: 22}),
  V(37801, 2017, 'Honda', 'Ridgeline AWD', {base: 'Ridgeline', drive: 'All-Wheel Drive', trany: 'Automatic 6-spd', displ: 3.5, cyl: 6, city: 18, hwy: 25, comb: 21}),
  V(32000, 2013, 'Infiniti', 'M37x', {base: 'M', drive: 'All-Wheel Drive', trany: 'Automatic (S7)', displ: 3.7, cyl: 6, city: 18, hwy: 24, comb: 20}),
];
const EMISSIONS = [['DTYXV02.0XXX', 37000],['FFMXT02.73DH', 35922], ['STYXV01.8P3A', 49139], ['STYXV01.8P3A', 48490], ['STYXV01.8Q2B', 48490], ['MGMXT03.65A1', 42200]];

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
  assert.equal(f.summary, '47-50 mpg combined across 2 EPA configurations of this model; the VIN does not say which: EPA listing: Sport/Normal/Eco Modes or Normal/Eco Modes');
  // What separates them, in plain words, per configuration and for the whole set.
  assert.deepEqual(f.configurations.map(c => c.label).sort(), ['Normal/Eco Modes', 'Sport/Normal/Eco Modes']);
  assert.deepEqual(f.separated_by, ['EPA listing: Sport/Normal/Eco Modes or Normal/Eco Modes']);
  assert.deepEqual(f.efids, ['STYXV01.8P3A']); // shared by both; STYXV01.8Q2B is only one's
  // Never the Corolla Cross or the gasoline Corolla.
  assert.ok(f.configurations.every(c => !/Cross/.test(c.epa_model) && c.powertrain === 'hybrid'));
});

test('closest: what differs is stated; the engine is never another size; cylinders relax only when the size agrees', async () => {
  const acadia = await fuel(vin(2020, 'GMC', 'Acadia', {displ: 3.6, cyl: 6, trans: 'Automatic', speeds: 6, drive: 'AWD/All-Wheel Drive'}));
  assert.deepEqual([acadia.available, acadia.match, acadia.vehicle_id, acadia.combined_mpg], [true, 'closest', '42200', 21]);
  assert.ok(acadia.match_basis.includes('differs: the VIN says 6 speeds; EPA lists Automatic 9-spd'));
  assert.match(acadia.summary, /closest EPA configuration.*Not an exact match: the VIN says 6 speeds/);
  // vPIC says 6 cylinders for the 2.5 L: the 2.5 L (4 cylinders) differs in cylinders, and only the 3.6 L fits the
  // 6 cylinders. One of the two decode fields is wrong and the decode cannot say which: both are shown, said so.
  const colorado = await fuel(vin(2015, 'CHEVROLET', 'Colorado', {displ: 2.5, cyl: 6, drive: '4WD/4-Wheel Drive/4x4'}));
  assert.deepEqual([colorado.match, colorado.configurations.map(c => c.displacement).sort()], ['multiple_configurations', [2.5, 3.6]]);
  assert.ok(colorado.match_basis.some(b => /VIN says 6 cylinders; EPA lists the 2\.5 L engine with 4/.test(b)));
  assert.ok(colorado.match_basis.some(b => /only EPA's 3\.6 L configuration fits the VIN's other details; its decoded 2\.5 L engine size or those details are wrong/.test(b)));
  assert.match(colorado.summary, /none matches every detail the VIN gives.*2\.5 L 4-cylinder or 3\.6 L 6-cylinder/);
  // With 4 cylinders the 2.5 L is exact.
  const four = await fuel(vin(2015, 'CHEVROLET', 'Colorado', {displ: 2.5, cyl: 4, drive: '4WD/4-Wheel Drive/4x4'}));
  assert.deepEqual([four.match, four.vehicle_id], ['exact', '35100']);
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

test('same rating: every configuration the VIN fits has one combined figure, which is then given, with what separates them', async () => {
  const f = await fuel(vin(2017, 'JEEP', 'Wrangler', {displ: 3.6, cyl: 6, drive: '4WD/4-Wheel Drive/4x4'}));
  assert.deepEqual([f.available, f.match, f.combined_mpg, f.city_mpg, f.highway_mpg, f.configuration_count, f.closest], [true, 'same_rating', 18, null, 21, 2, false]);
  assert.equal(f.reason, undefined);
  assert.deepEqual(f.configurations.map(c => c.label), ['5-speed automatic', '6-speed manual']);
  assert.deepEqual(f.separated_by, ['5-speed automatic or 6-speed manual']);
  assert.equal(f.summary, '18 mpg combined for both EPA configurations this VIN fits, so the figure holds whichever it is (they differ in 5-speed automatic or 6-speed manual)');
  assert.deepEqual([f.displacement, f.cylinders, f.transmission, f.efids], [3.6, 6, null, []]);
});

test('EPA name rules: weight series, Infiniti x, truck and MPV words, sister models, series and electric sub-names', async () => {
  assert.deepEqual(nameRelation('Suburban 2500 2WD', 'Suburban').weights, [2]);
  assert.ok(nameRelation('M37x', 'M37', {make: 'INFINITI'}).infinitiX);
  assert.equal(nameRelation('M37x', 'M37', {make: 'NISSAN'}), null);
  assert.deepEqual(nameRelation('Ridgeline Truck 4WD', 'Ridgeline').body, ['pickup']);
  assert.ok(modelAlternatives('Kicks MPV', 'NISSAN').includes('KICKS'));
  // Half ton: the 1500 listing, never the 2500.
  const half = await fuel(vin(2012, 'CHEVROLET', 'Suburban', {displ: 5.3, cyl: 8, drive: '4x2', raw: {Series: '1/2 Ton'}}));
  assert.deepEqual([half.match, half.vehicle_id], ['exact', '31000']);
  assert.ok(half.match_basis.includes('weight series (half ton / 1500)'));
  // Ram 1500 and 1500 Classic share the vPIC model: the assembly plant tells them apart.
  const ram = plant => fuel(vin(2019, 'RAM', '1500', {displ: 3.6, cyl: 6, drive: '4x2', raw: {PlantCity: plant}}));
  assert.deepEqual([(await ram('WARREN')).vehicle_id, (await ram('STERLING HEIGHTS')).vehicle_id, (await ram('')).match], ['40501', '40500', 'multiple_configurations']);
  // Electric versions under their own name, for an electric VIN only.
  const energi = await fuel(vin(2013, 'FORD', 'Fusion', {displ: 2.0, cyl: 4, ev: 'PHEV (Plug-in Hybrid Electric Vehicle)'}));
  assert.deepEqual([energi.match, energi.epa_model, energi.ev_range], ['exact', 'Fusion Energi Plug-in Hybrid', 21]);
  const gas = await fuel(vin(2013, 'FORD', 'Fusion', {displ: 2.0, cyl: 4}));
  assert.equal(gas.reason, 'no_matching_variant');
  // vPIC "Corolla Matrix" is EPA's Matrix; MINI "Countryman" with series "Cooper S" is EPA's "Cooper S Countryman".
  const matrix = await fuel(vin(2005, 'TOYOTA', 'Corolla Matrix', {displ: 1.8}));
  assert.deepEqual([matrix.match, matrix.vehicle_id, matrix.match_basis[0]], ['exact', '21000', 'EPA lists the Corolla Matrix as Matrix']);
  const mini = await fuel(vin(2023, 'MINI', 'Countryman', {displ: 2.0, raw: {Series: 'Cooper S'}}));
  assert.deepEqual([mini.match, mini.vehicle_id], ['exact', '46000']);
  const infiniti = await fuel(vin(2013, 'INFINITI', 'M37', {displ: 3.7}));
  assert.deepEqual([infiniti.match, infiniti.epa_model], ['exact', 'M37x']);
  // A sub-name EPA does not list: its leading name, never exact.
  const note = await fuel(vin(2016, 'NISSAN', 'Versa Note', {displ: 1.6, trans: 'Continuously Variable Transmission (CVT)'}));
  assert.deepEqual([note.match, note.vehicle_id], ['closest', '36000']);
  assert.ok(note.match_basis.includes('differs: EPA lists no Versa Note; its Versa listings are shown'));
  // Lexus names the engine by number: the decode's "350" trim with a 2.5 L engine is EPA's NX 250, as closest.
  const nx = await fuel(vin(2022, 'LEXUS', 'NX', {displ: 2.5, cyl: 4, drive: 'AWD/All-Wheel Drive', trim: '350 Base'}));
  assert.deepEqual([nx.match, nx.epa_model], ['closest', 'NX 250 AWD']);
  assert.match(nx.summary, /names another engine; EPA lists the 2\.5 L engine as NX 250/);
});

test('drive named in the trim, and version words the decode states, narrow the configurations', async () => {
  const tiguan = trim => fuel(vin(2025, 'VOLKSWAGEN', 'Tiguan', {displ: 2.0, cyl: 4, turbo: 'Yes', trim}));
  const awd = await tiguan('4Motion SE');
  assert.deepEqual([awd.match, awd.vehicle_id], ['exact', '48001']);
  assert.ok(awd.match_basis.includes('drive from the trim (4Motion SE)'));
  assert.equal((await tiguan('SE')).match, 'multiple_configurations');
  // The decode's drive against its trim: neither is used.
  const both = await fuel(vin(2025, 'VOLKSWAGEN', 'Tiguan', {displ: 2.0, cyl: 4, turbo: 'Yes', trim: '4Motion SE', drive: 'FWD/Front-Wheel Drive'}));
  assert.equal(both.match, 'multiple_configurations');
  assert.ok(both.match_basis.some(b => /^drive not used: the decode says front-wheel drive, its trim \(4Motion SE\) says/.test(b)));
  const ev = o => vin(o.year, o.make, o.model, {fuel: 'Electric', ev: 'BEV (Battery Electric Vehicle)', ...o});
  // Two motors: all-wheel drive; "Standard": not the Performance listing.
  const y = await fuel(ev({year: 2020, make: 'TESLA', model: 'Model Y', raw: {OtherEngineInfo: 'Dual Motor - Standard'}}));
  assert.deepEqual([y.match, y.vehicle_id], ['exact', '41002']);
  const perf = await fuel(ev({year: 2020, make: 'TESLA', model: 'Model Y', raw: {OtherEngineInfo: 'Dual Motor: Performance'}}));
  assert.deepEqual([perf.match, perf.configurations.map(c => c.vehicle_id).sort()], ['multiple_configurations', ['41000', '41001']]);
  assert.deepEqual(perf.configurations.map(c => c.label).sort(), ['Performance, 21-inch wheels, 291 mi electric range', 'Performance, 315 mi electric range']);
  // Battery written in the engine note, range words and wheel size in the trim.
  const leaf = await fuel(ev({year: 2020, make: 'NISSAN', model: 'Leaf', raw: {OtherEngineInfo: 'Motor (BAT:62kw)'}}));
  assert.deepEqual([leaf.match, leaf.vehicle_id], ['exact', '41101']);
  const ev9 = await fuel(ev({year: 2026, make: 'KIA', model: 'EV9', trim: 'Light LR', drive: 'RWD/Rear-Wheel Drive'}));
  assert.deepEqual([ev9.match, ev9.vehicle_id], ['exact', '51001']);
  const gv60 = await fuel(ev({year: 2024, make: 'GENESIS', model: 'GV60', trim: 'AWD Advanced with 20"', drive: '4WD/4-Wheel Drive/4x4'}));
  assert.deepEqual([gv60.match, gv60.vehicle_id], ['exact', '47501']);
  assert.ok(gv60.match_basis.includes('20-inch wheels (from the trim)'));
});

test('a decode field that names both drives, another weight series and a flex-fuel label never decide alone', async () => {
  // vPIC "2WD/4WD" names both drives.
  const ridgeline = await fuel(vin(2017, 'HONDA', 'Ridgeline', {displ: 3.5, cyl: 6, drive: '2WD/4WD'}));
  assert.deepEqual([ridgeline.match, ridgeline.separated_by], ['multiple_configurations', ['front-wheel drive or all-wheel drive']]);
  // A 2500 is never matched to the 1500 listing: EPA does not rate it.
  const hd = await fuel(vin(2012, 'DODGE', 'Ram', {displ: 5.7, cyl: 8, raw: {Series: '2500'}}));
  assert.deepEqual([hd.available, hd.reason, hd.match_basis[0]], [false, 'heavy_duty_not_rated', 'weight series three-quarter ton / 2500: EPA lists this model only as 1500']);
  assert.equal((await fuel(vin(2012, 'DODGE', 'Ram', {displ: 5.7, cyl: 8, raw: {Series: '1500'}}))).vehicle_id, '31441');
  // A flex-fuel AWD VIN: EPA lists the AWD engine as gasoline only, which beats the flex-fuel FWD listing.
  const journey = await fuel(vin(2012, 'DODGE', 'Journey', {displ: 3.6, cyl: 6, drive: 'AWD/All-Wheel Drive', raw: {FuelTypeSecondary: 'Ethanol (E85)'}, fuel: 'Gasoline'}));
  assert.deepEqual([journey.match, journey.vehicle_id], ['exact', '31506']);
  assert.ok(journey.match_basis.includes('the VIN says flex-fuel; EPA lists this engine as gasoline'));
  // The AWD version EPA lists only under trim names: those, as closest, not the FWD listing.
  const prologue = await fuel(vin(2024, 'HONDA', 'Prologue', {fuel: 'Electric', ev: 'BEV (Battery Electric Vehicle)', drive: 'AWD/All-Wheel Drive', trim: 'EX'}));
  assert.deepEqual([prologue.match, prologue.configurations.map(c => c.vehicle_id).sort()], ['multiple_configurations', ['47829', '47830']]);
  assert.ok(prologue.match_basis.includes('differs: EPA lists the four/all-wheel drive Prologue only under trim names (Prologue AWD Elite, Prologue AWD Touring), not the VIN\'s trim'));
  // Range words count only when every trim alternative states them.
  const ev9 = await fuel(vin(2026, 'KIA', 'EV9', {fuel: 'Electric', ev: 'BEV (Battery Electric Vehicle)', drive: 'RWD/Rear-Wheel Drive', trim: 'Light, Light LR'}));
  assert.equal(ev9.match, 'multiple_configurations');
});

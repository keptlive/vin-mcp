import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {lookupTestVehicleData, selectClosest, compareWheelbases, electrification, keyName, powertrainClass, MAX_YEAR_GAP} from '../lib/tire-placards.mjs';

const importer = fileURLToPath(new URL('../scripts/import-tire-placards.py', import.meta.url));
const url = n => `https://nrd-static.nhtsa.dot.gov/reports/vehdb/v10000/v11400/v${n}R001.pdf`;
const row = o => ({make: 'FORD', model: 'F-150', model_year: 2021, tested_as: '2021 Ford F-150 4x4 SuperCrew', vpic_trim: 'XLT', fuel_type: 'Gasoline',
  tires: {front: '275/60R20 115T', rear: '275/60R20 115T'}, cold_pressure_kpa: {front: 240, rear: 240}, cold_pressure_psi: {front: 35, rear: 35},
  test_no: 11490, report_url: url(11490), confidence: 'normal', other_reports: [], powertrain: 'not_battery_electric', ...o});
const spec = o => ({make: 'FORD', model: 'F-150', model_year: 2021, tested_as: '2021 Ford F-150 4x4 SuperCrew', vpic_trim: 'XLT', fuel_type: 'Gasoline',
  powertrain: 'not_battery_electric', test_no: 11490, report_url: url(11490), test_type: 'NEW CAR ASSESSMENT TEST',
  fuel_tank_standard: {litres: 98.4, printed: 98.4, unit_printed: 'L', method: 'label_line'}, vehicle_capacity_weight_kg: 650,
  seating: {front: 3, rear: 3, third: 0, total: 6}, gvwr: {value: 3175, unit_printed: 'kg'}, gawr_front: {value: 1724, unit_printed: 'kg'},
  gawr_rear: {value: 1814, unit_printed: 'kg'}, curb_weight_kg: {front: 1250, rear: 900, total: 2150}, wheelbase_mm: 3680, ...o});
const vin = o => ({make: 'FORD', model: 'F-150', year: 2021, trim: null, fuelType: 'Gasoline', evType: null, ...o});
/** A Transport Canada stub: wheelbase in cm per model year; counts calls. */
const tc = (byYear = {}) => { const f = async ({year}) => { f.calls++; return {available: true, data: (byYear[year] || []).map(v => ({Specs: [{Name: 'WB', Value: String(v)}]}))}; }; f.calls = 0; return f; };

/** Build an index from rows with the real import script (same schema as production). */
function buildIndex(rows, specs) {
  const dir = mkdtempSync(join(tmpdir(), 'placards-')), src = join(dir, 'tire-placards.jsonl'), file = join(dir, 'tire-placards.db');
  writeFileSync(src, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const args = [importer, src, file];
  if (specs) { const s = join(dir, 'specs.jsonl'); writeFileSync(s, specs.map(r => JSON.stringify(r)).join('\n') + '\n'); args.push(s); }
  const code = `import importlib.util,sys;s=importlib.util.spec_from_file_location('i',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.build(sys.argv[2],sys.argv[3],None,*(sys.argv[4:5] or [None]))`;
  const run = spawnSync('python3', ['-c', code, ...args], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
  return {dir, file};
}
const kinds = r => r.vehicles.map(v => [v.model_year, v.test_no, v.match.kind]);

test('a missing index is unavailable for both blocks, never an empty or zero answer', async () => {
  const r = await lookupTestVehicleData(vin(), {file: join(tmpdir(), 'no-such-placards.db'), dims: tc()});
  for (const b of [r.tire_placard, r.test_vehicle_specs]) {
    assert.equal(b.available, false); assert.equal(b.reason, 'dataset_not_indexed');
    assert.equal(b.vin_specific, false); assert.equal(b.scope, 'nhtsa_test_vehicle'); assert.equal(b.vehicles, undefined);
  }
});

test('exact: same make, model, year and version; every same-year variant when the VIN gives no trim', async () => {
  const {dir, file} = buildIndex([
    row(),
    row({tires: {front: 'P265/70R17 113T', rear: 'P265/70R17 113T'}, test_no: 11491, report_url: url(11491), confidence: 'high',
      other_reports: [{test_no: 11492, report_url: url(11492)}], tested_as: '2021 Ford F-150 SuperCab'}),
    row({model_year: 2020, cold_pressure_kpa: {front: 250, rear: 250}, cold_pressure_psi: {front: 36, rear: 36}, test_no: 11000, report_url: url(11000)}),
    row({make: 'BMW', model: '330i', model_year: 2021, tested_as: '2021 BMW 330i xDrive', vpic_trim: null, tires: {front: 'P225/45 R18 95Y', rear: 'P225/45 R18 95Y'},
      cold_pressure_kpa: {front: 220, rear: 270}, cold_pressure_psi: {front: 32, rear: 39}, test_no: 11571, report_url: url(11571)}),
  ]);
  try {
    const dims = tc();
    const r = (await lookupTestVehicleData(vin({make: 'ford', model: ' F-150 ', year: '2021'}), {file, dims})).tire_placard;
    assert.equal(r.available, true); assert.equal(r.vin_specific, false); assert.equal(r.scope, 'nhtsa_test_vehicle'); assert.equal(r.match_kind, 'exact');
    assert.deepEqual(kinds(r), [[2021, 11491, 'exact'], [2021, 11490, 'exact']]);  // the 2020 test is not used when the year was tested
    assert.equal(dims.calls, 0, 'no generation check for an exact match');
    const m = r.vehicles[0].match;
    assert.deepEqual(m, {kind: 'exact', tested_model_year: 2021, vin_model_year: 2021, year_gap: 0, differences: [], generation_check: null});
    assert.equal(r.vehicles[0].confidence, 'high'); assert.deepEqual(r.vehicles[0].other_reports, [{test_no: 11492, report_url: url(11492)}]);
    assert.deepEqual(r.vehicles[1].cold_pressure_psi, {front: 35, rear: 35}); assert.deepEqual(r.vehicles[1].cold_pressure_kpa, {front: 240, rear: 240});
    assert.match(r.note, /your own door placard governs/i); assert.match(r.note, /Not this VIN/);
    // Front and rear stay separate.
    assert.deepEqual((await lookupTestVehicleData(vin({make: 'BMW', model: '330i'}), {file, dims})).tire_placard.vehicles[0].cold_pressure_psi, {front: 32, rear: 39});
    // Near-miss names never match; a missing model is no lookup.
    for (const q of [{model: 'F150'}, {model: 'F-150 Lightning'}, {make: 'LINCOLN'}]) {
      const none = (await lookupTestVehicleData(vin(q), {file, dims})).tire_placard;
      assert.equal(none.available, true, JSON.stringify(q)); assert.deepEqual(none.vehicles, []); assert.equal(none.reason, 'no_close_match');
      assert.match(none.note, /not tested, or not indexed/);
    }
    assert.equal((await lookupTestVehicleData(vin({model: ''}), {file, dims})).tire_placard.available, false);
    assert.equal(keyName('  mercedes-benz  c-class '), 'MERCEDES-BENZ C-CLASS');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('nearest model year: within the reach only, both years on a tie, a different wheelbase ranked last', async () => {
  const {dir, file} = buildIndex([
    row({model_year: 2019, test_no: 1019, report_url: url(1019), tires: {front: '265/70R17 115T', rear: '265/70R17 115T'}}),
    row({model_year: 2021, test_no: 1021, report_url: url(1021)}),
    row({model_year: 2023, test_no: 1023, report_url: url(1023), tires: {front: '275/65R18 116T', rear: '275/65R18 116T'}}),
  ]);
  try {
    // 2022: 2021 and 2023 are both one year away; both are shown, the same-wheelbase one first.
    let dims = tc({2022: [367], 2021: [367], 2023: [367]});
    let r = (await lookupTestVehicleData(vin({year: 2022}), {file, dims})).tire_placard;
    assert.equal(r.match_kind, 'nearest_model_year');
    assert.deepEqual(kinds(r), [[2023, 1023, 'nearest_model_year'], [2021, 1021, 'nearest_model_year']]);
    assert.deepEqual(r.vehicles[0].match, {kind: 'nearest_model_year', tested_model_year: 2023, vin_model_year: 2022, year_gap: 1,
      differences: [{field: 'model_year', tested: 2023, yours: 2022}], generation_check: 'same_wheelbase'});
    // Another generation (different wheelbase) is ranked last: 2021 wins alone.
    dims = tc({2022: [367], 2021: [367], 2023: [370]});
    r = (await lookupTestVehicleData(vin({year: 2022}), {file, dims})).tire_placard;
    assert.deepEqual(kinds(r), [[2021, 1021, 'nearest_model_year']]);
    // ...but is still used, marked, when nothing else is within reach.
    dims = tc({2025: [370], 2023: [367]});
    r = (await lookupTestVehicleData(vin({year: 2025}), {file, dims})).tire_placard;
    assert.deepEqual(kinds(r), [[2023, 1023, 'nearest_model_year']]); assert.equal(r.vehicles[0].match.generation_check, 'different_wheelbase');
    // No Transport Canada record: unknown, never assumed.
    r = (await lookupTestVehicleData(vin({year: 2024}), {file, dims: tc()})).tire_placard;
    assert.equal(r.vehicles[0].match.generation_check, 'unknown'); assert.equal(r.vehicles[0].match.year_gap, 1);
    // Beyond the reach: nothing.
    assert.equal(MAX_YEAR_GAP, 2);
    r = (await lookupTestVehicleData(vin({year: 2026}), {file, dims: tc()})).tire_placard;
    assert.deepEqual(r.vehicles, []); assert.equal(r.reason, 'no_close_match'); assert.equal(r.max_year_gap, 2);
    r = (await lookupTestVehicleData(vin({year: 2017}), {file, dims: tc()})).tire_placard;
    assert.deepEqual(kinds(r), [[2019, 1019, 'nearest_model_year']]);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('different variant: same year with a visible difference; a same-version nearby year ranks above it', async () => {
  const {dir, file} = buildIndex([
    row({model_year: 2021, test_no: 2021, report_url: url(2021), vpic_trim: 'Raptor', drive_type: '4WD/4-Wheel Drive/4x4', tires: {front: 'LT315/70R17 121/118S', rear: 'LT315/70R17 121/118S'}}),
    row({model_year: 2020, test_no: 2020, report_url: url(2020), vpic_trim: 'XLT', drive_type: '4x2'}),
  ]);
  try {
    let r = (await lookupTestVehicleData(vin({trim: 'Raptor', drive_type: 'RWD/Rear-Wheel Drive'}), {file, dims: tc()})).tire_placard;
    assert.deepEqual(kinds(r), [[2021, 2021, 'different_variant']]);
    assert.deepEqual(r.vehicles[0].match.differences, [{field: 'drive', tested: '4WD/4-Wheel Drive/4x4', yours: 'RWD/Rear-Wheel Drive'}]);
    // An XLT VIN: the 2020 XLT (same version, one year away) is closer than the 2021 Raptor.
    r = (await lookupTestVehicleData(vin({trim: 'XLT'}), {file, dims: tc()})).tire_placard;
    assert.deepEqual(kinds(r), [[2020, 2020, 'nearest_model_year']]);
    // Trim lists from vPIC count as the same version when they share an option; 4x2 is not a different drive than RWD.
    r = (await lookupTestVehicleData(vin({year: 2020, trim: 'XL/XLT', drive_type: 'RWD/Rear-Wheel Drive'}), {file, dims: tc()})).tire_placard;
    assert.deepEqual(kinds(r), [[2020, 2020, 'exact']]);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('vPIC powertrain class and electrification', () => {
  assert.equal(powertrainClass('Electric', 'BEV (Battery Electric Vehicle)'), 'battery_electric');
  assert.equal(powertrainClass('Electric', null), 'battery_electric');
  assert.equal(powertrainClass('Electric', 'PHEV (Plug-in Hybrid Electric Vehicle)'), 'not_battery_electric');
  assert.equal(powertrainClass('Gasoline', 'Strong HEV (Hybrid Electric Vehicle)'), 'not_battery_electric');
  assert.equal(powertrainClass('Flexible Fuel Vehicle (FFV)', ''), 'not_battery_electric');
  assert.equal(powertrainClass(null, undefined), 'unknown');
  assert.equal(electrification('Gasoline', 'PHEV (Plug-in Hybrid Electric Vehicle)'), 'plug_in_hybrid');
  assert.equal(electrification('Gasoline', 'HEV (Hybrid Electric Vehicle) - Level Unknown'), 'hybrid');
  assert.equal(electrification('Gasoline', 'Strong HEV (Hybrid Electric Vehicle)'), 'hybrid');
  assert.equal(electrification('Gasoline', 'Mild HEV (Hybrid Electric Vehicle)'), 'mild_hybrid');
  assert.equal(electrification('Electric', null), 'battery_electric');
  assert.equal(electrification('Gasoline', null), 'none');
  assert.equal(electrification(null, null), null);
});

test('a test vehicle with a different known powertrain is never shown (one vPIC model name for gas and EV)', async () => {
  const ev = row({make: 'CHEVROLET', model: 'Silverado', model_year: 2025, tested_as: '2025 Chevrolet Silverado EV', powertrain: 'battery_electric', fuel_type: 'Electric',
    ev_type: 'BEV (Battery Electric Vehicle)', vpic_trim: null,
    tires: {front: 'LT265/70R18 124/121S', rear: 'LT265/70R18 124/121S'}, cold_pressure_kpa: {front: 420, rear: 420}, cold_pressure_psi: {front: 61, rear: 61}, test_no: 15451, report_url: url(15451)});
  const old = row({make: 'SUBARU', model: 'Legacy', model_year: 2013, tested_as: '2013 Subaru Legacy four door sedan', powertrain: 'unknown', fuel_type: null, vpic_trim: null,
    tires: {front: 'P205/60R16 91V', rear: 'P205/60R16 91V'}, cold_pressure_kpa: {front: 230, rear: 220}, cold_pressure_psi: {front: 33, rear: 32}, test_no: 8063, report_url: url(8063)});
  const {dir, file} = buildIndex([ev, old]);
  try {
    const q = {make: 'CHEVROLET', model: 'Silverado', year: 2025};
    const gas = (await lookupTestVehicleData(vin({...q, fuelType: 'Gasoline'}), {file, dims: tc()})).tire_placard;
    assert.equal(gas.available, true); assert.deepEqual(gas.vehicles, []); assert.equal(gas.reason, 'other_powertrain_only');
    assert.equal(gas.other_powertrain_not_shown, 1); assert.match(gas.note, /different powertrain/);
    // ...also as a nearby year.
    assert.equal((await lookupTestVehicleData(vin({...q, year: 2026, fuelType: 'Gasoline'}), {file, dims: tc()})).tire_placard.reason, 'other_powertrain_only');
    const bev = (await lookupTestVehicleData(vin({...q, fuelType: 'Electric', evType: 'BEV (Battery Electric Vehicle)'}), {file, dims: tc()})).tire_placard;
    assert.equal(bev.vehicles.length, 1); assert.equal(bev.vehicles[0].powertrain, 'battery_electric'); assert.deepEqual(bev.vehicles[0].cold_pressure_psi, {front: 61, rear: 61});
    assert.equal(bev.other_powertrain_not_shown, undefined);
    // Unknown on either side: the make/model/year match decides (the as-tested line names the vehicle).
    assert.equal((await lookupTestVehicleData(vin({...q, fuelType: null}), {file, dims: tc()})).tire_placard.vehicles.length, 1);
    assert.equal((await lookupTestVehicleData(vin({make: 'SUBARU', model: 'Legacy', year: 2013}), {file, dims: tc()})).tire_placard.vehicles.length, 1);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('capacities and weights: one tested vehicle, both units, the fuel tank labelled exact or best guess', async () => {
  const {dir, file} = buildIndex([row()], [
    spec(),
    spec({model_year: 2019, test_no: 1019, report_url: url(1019), fuel_tank_standard: {litres: 87.1, printed: 23, unit_printed: 'gal', method: 'label_line'}}),
    spec({model_year: 2023, test_no: 1023, report_url: url(1023), vpic_trim: 'Hybrid', ev_type: 'Strong HEV (Hybrid Electric Vehicle)',
      fuel_tank_standard: {litres: 113.6, printed: 113.6, unit_printed: 'L', method: 'label_line'}, fuel_tank_optional: undefined}),
    spec({model_year: 2023, test_no: 1024, report_url: url(1024), vpic_trim: 'XL', fuel_tank_standard: {litres: 87.1, printed: 87.1, unit_printed: 'L', method: 'label_line'},
      fuel_tank_optional: {litres: 136.3, printed: 136.3, unit_printed: 'L', method: 'label_line'}, vehicle_capacity_weight_kg: undefined, seating: undefined}),
  ]);
  try {
    const dims = tc();
    let s = (await lookupTestVehicleData(vin(), {file, dims})).test_vehicle_specs;
    assert.equal(s.available, true); assert.equal(s.match_kind, 'exact'); assert.equal(s.vin_specific, false);
    const v = s.vehicles[0];
    assert.equal(v.test_no, 11490); assert.deepEqual(v.fuel_tank, {litres: 98.4, gallons: 26, printed: '98.4 L'});
    assert.deepEqual(v.payload_vehicle_capacity_weight, {kg: 650, lb: 1433}); assert.deepEqual(v.seating, {front: 3, rear: 3, third: 0, total: 6});
    assert.deepEqual(v.gvwr, {kg: 3175, lb: 7000, printed: '3175 kg'});
    assert.deepEqual(v.curb_weight_as_delivered.total, {kg: 2150, lb: 4740}); assert.equal(v.curb_weight_as_delivered.front_percent, 58.1);
    assert.equal(s.fuel_tank.shown, true); assert.equal(s.fuel_tank.best_guess, false); assert.equal(s.fuel_tank.label, 'NHTSA test vehicle, same model year');
    assert.deepEqual(s.fuel_tank.values.map(x => [x.litres, x.gallons, x.test_no]), [[98.4, 26, 11490]]);
    // The model shows several tank sizes across tested vehicles: listed, never averaged.
    assert.deepEqual(s.fuel_tank.model_tank_sizes.map(x => [x.litres, x.model_years]), [[87.1, [2019, 2023]], [98.4, [2021]], [113.6, [2023]]]);
    // 2022 (untested): nearest year, best guess; 2021 and 2023 tie; the 2023 hybrid is skipped for a gasoline VIN.
    s = (await lookupTestVehicleData(vin({year: 2022}), {file, dims})).test_vehicle_specs;
    assert.equal(s.match_kind, 'nearest_model_year');
    assert.deepEqual(s.vehicles.map(x => [x.test_no, x.model_year]), [[11490, 2021], [1024, 2023]]);
    assert.equal(s.fuel_tank.best_guess, true); assert.equal(s.fuel_tank.label, 'best guess');
    assert.deepEqual(s.fuel_tank.values.map(x => [x.litres, x.model_year, x.match_kind]), [[98.4, 2021, 'nearest_model_year'], [87.1, 2023, 'nearest_model_year']]);
    assert.deepEqual(s.fuel_tank.optional_tank_listed, {litres: 136.3, gallons: 36, printed: '136.3 L'});  // listed by the 2023 XL's report
    // A hybrid VIN: only the hybrid test vehicle is used.
    s = (await lookupTestVehicleData(vin({year: 2023, trim: 'Hybrid', evType: 'Strong HEV (Hybrid Electric Vehicle)'}), {file, dims})).test_vehicle_specs;
    assert.deepEqual(s.vehicles.map(x => [x.test_no, x.match.kind]), [[1023, 'exact']]);
    // A hybrid VIN of a year with no tested hybrid nearby: other vehicles may be shown, but no tank.
    s = (await lookupTestVehicleData(vin({year: 2019, evType: 'HEV (Hybrid Electric Vehicle) - Level Unknown'}), {file, dims})).test_vehicle_specs;
    assert.equal(s.vehicles[0].test_no, 1019); assert.equal(s.fuel_tank.shown, false); assert.equal(s.fuel_tank.reason, 'different_electrification');
    assert.match(s.fuel_tank.note, /no tank size is shown/);
    // The gallon-printed tank keeps its printed value.
    s = (await lookupTestVehicleData(vin({year: 2019}), {file, dims})).test_vehicle_specs;
    assert.deepEqual(s.vehicles[0].fuel_tank, {litres: 87.1, gallons: 23, printed: '23 gal'});
    // Optional tank listed by the report.
    s = (await lookupTestVehicleData(vin({year: 2023, trim: 'XL'}), {file, dims})).test_vehicle_specs;
    assert.deepEqual(s.fuel_tank.optional_tank_listed, {litres: 136.3, gallons: 36, printed: '136.3 L'});
    assert.equal(s.vehicles[0].payload_vehicle_capacity_weight, undefined); assert.equal(s.vehicles[0].seating, undefined);
    // Without a specs table the block is reported as not indexed.
    const {dir: d2, file: f2} = buildIndex([row()]);
    try { assert.equal((await lookupTestVehicleData(vin(), {file: f2, dims})).test_vehicle_specs.reason, 'dataset_not_indexed'); }
    finally { rmSync(d2, {recursive: true, force: true}); }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('generation check compares Transport Canada wheelbases, or the measured one when the tested year has no record', () => {
  assert.equal(compareWheelbases([276], [276]), 'same_wheelbase');
  assert.equal(compareWheelbases([369, 412], [369, 412, 442]), 'same_wheelbase');
  assert.equal(compareWheelbases([276], [268]), 'different_wheelbase');
  assert.equal(compareWheelbases([369, 400], [369, 412]), 'unknown');
  assert.equal(compareWheelbases([], [276]), 'unknown');
  assert.equal(compareWheelbases(null, null, [2755]), 'unknown');
  assert.equal(compareWheelbases([276], [], [2755]), 'same_wheelbase');
  assert.equal(compareWheelbases([276], [], [2681]), 'different_wheelbase');
  assert.equal(compareWheelbases([276], [], [2738]), 'unknown');
  // Pure selection: annotated, best tier only.
  const r = (year, trim, test_no) => ({year, vpic_trim: trim, test_no, fuel_type: 'Gasoline'});
  const picked = selectClosest([r(2020, 'A', 1), r(2022, 'A', 2), r(2021, 'B', 3)], {year: 2021, trim: 'A', fuelType: 'Gasoline'});
  assert.deepEqual(picked.map(c => [c.row.test_no, c.match.kind]), [[2, 'nearest_model_year'], [1, 'nearest_model_year']]);
});

test('an unreadable index is unavailable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'placards-bad-')), file = join(dir, 'tire-placards.db');
  writeFileSync(file, 'not a database');
  try {
    const r = await lookupTestVehicleData(vin(), {file, dims: tc()});
    assert.equal(r.tire_placard.available, false); assert.equal(r.tire_placard.reason, 'index_unreadable');
    assert.equal(r.test_vehicle_specs.reason, 'index_unreadable');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

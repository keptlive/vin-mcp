import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {lookupTirePlacards, keyName, powertrainClass} from '../lib/tire-placards.mjs';

const importer = fileURLToPath(new URL('../scripts/import-tire-placards.py', import.meta.url));
const url = n => `https://nrd-static.nhtsa.dot.gov/reports/vehdb/v10000/v11400/v${n}R001.pdf`;
const row = o => ({make: 'FORD', model: 'F-150', model_year: 2021, tested_as: '2021 Ford F-150 4x4 SuperCrew', vpic_trim: 'XLT',
  tires: {front: '275/60R20 115T', rear: '275/60R20 115T'}, cold_pressure_kpa: {front: 240, rear: 240}, cold_pressure_psi: {front: 35, rear: 35},
  test_no: 11490, report_url: url(11490), confidence: 'normal', other_reports: [], powertrain: 'not_battery_electric', ...o});

/** Build a placard index from rows with the real import script (same schema as production). */
function buildIndex(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'placards-')), src = join(dir, 'tire-placards.jsonl'), file = join(dir, 'tire-placards.db');
  writeFileSync(src, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const code = `import importlib.util,sys;s=importlib.util.spec_from_file_location('i',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.build(sys.argv[2],sys.argv[3])`;
  const run = spawnSync('python3', ['-c', code, importer, src, file], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
  return {dir, file};
}

test('a missing index is unavailable, never an empty or zero answer', () => {
  const r = lookupTirePlacards({make: 'FORD', model: 'F-150', year: 2021}, join(tmpdir(), 'no-such-placards.db'));
  assert.equal(r.available, false); assert.equal(r.reason, 'dataset_not_indexed');
  assert.equal(r.vin_specific, false); assert.equal(r.scope, 'nhtsa_test_vehicle'); assert.equal(r.vehicles, undefined);
});

test('only an exact vPIC make, model and model year matches; every tested variant is returned', () => {
  const {dir, file} = buildIndex([
    row(),
    row({tires: {front: 'P265/70R17 113T', rear: 'P265/70R17 113T'}, test_no: 11491, report_url: url(11491), confidence: 'high',
      other_reports: [{test_no: 11492, report_url: url(11492)}], tested_as: '2021 Ford F-150 SuperCab'}),
    row({model_year: 2020, cold_pressure_kpa: {front: 250, rear: 250}, cold_pressure_psi: {front: 36, rear: 36}, test_no: 11000, report_url: url(11000)}),
    row({make: 'BMW', model: '330i', model_year: 2021, tested_as: '2021 BMW 330i xDrive', tires: {front: 'P225/45 R18 95Y', rear: 'P225/45 R18 95Y'},
      cold_pressure_kpa: {front: 220, rear: 270}, cold_pressure_psi: {front: 32, rear: 39}, test_no: 11571, report_url: url(11571)}),
  ]);
  try {
    const r = lookupTirePlacards({make: 'ford', model: ' F-150 ', year: '2021'}, file);
    assert.equal(r.available, true); assert.equal(r.vin_specific, false); assert.equal(r.scope, 'nhtsa_test_vehicle');
    assert.equal(r.vehicles.length, 2);
    assert.equal(r.vehicles[0].confidence, 'high'); assert.equal(r.vehicles[0].tested_as, '2021 Ford F-150 SuperCab');
    assert.deepEqual(r.vehicles[0].other_reports, [{test_no: 11492, report_url: url(11492)}]);
    assert.deepEqual(r.vehicles[1].cold_pressure_psi, {front: 35, rear: 35}); assert.deepEqual(r.vehicles[1].cold_pressure_kpa, {front: 240, rear: 240});
    assert.equal(r.vehicles[1].report_url, url(11490)); assert.equal(r.vehicles[1].test_no, 11490); assert.equal(r.vehicles[1].model_year, 2021);
    assert.match(r.note, /your own door placard governs/i); assert.match(r.note, /Not this VIN/);
    // Front and rear stay separate.
    assert.deepEqual(lookupTirePlacards({make: 'BMW', model: '330i', year: 2021}, file).vehicles[0].cold_pressure_psi, {front: 32, rear: 39});
    // Another model year's value is never applied; near-miss names do not match.
    for (const q of [{make: 'FORD', model: 'F-150', year: 2022}, {make: 'FORD', model: 'F150', year: 2021}, {make: 'FORD', model: 'F-150 Lightning', year: 2021}, {make: 'LINCOLN', model: 'F-150', year: 2021}]) {
      const none = lookupTirePlacards(q, file);
      assert.equal(none.available, true, JSON.stringify(q)); assert.deepEqual(none.vehicles, []); assert.equal(none.reason, 'no_exact_match');
      assert.match(none.note, /not tested, or not indexed/);
    }
    assert.equal(lookupTirePlacards({make: 'FORD', model: '', year: 2021}, file).available, false);
    assert.equal(keyName('  mercedes-benz  c-class '), 'MERCEDES-BENZ C-CLASS');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('vPIC powertrain class: battery-electric or not; hybrids and plug-ins are not', () => {
  assert.equal(powertrainClass('Electric', 'BEV (Battery Electric Vehicle)'), 'battery_electric');
  assert.equal(powertrainClass('Electric', null), 'battery_electric');
  assert.equal(powertrainClass('Electric', 'PHEV (Plug-in Hybrid Electric Vehicle)'), 'not_battery_electric');
  assert.equal(powertrainClass('Gasoline', 'Strong HEV (Hybrid Electric Vehicle)'), 'not_battery_electric');
  assert.equal(powertrainClass('Flexible Fuel Vehicle (FFV)', ''), 'not_battery_electric');
  assert.equal(powertrainClass(null, undefined), 'unknown');
});

test('a test vehicle with a different known powertrain is never shown (one vPIC model name for gas and EV)', () => {
  // 2025 Chevrolet "Silverado": vPIC names the Silverado EV and the gasoline Silverado alike.
  const ev = row({make: 'CHEVROLET', model: 'Silverado', model_year: 2025, tested_as: '2025 Chevrolet Silverado EV', powertrain: 'battery_electric',
    tires: {front: 'LT265/70R18 124/121S', rear: 'LT265/70R18 124/121S'}, cold_pressure_kpa: {front: 420, rear: 420}, cold_pressure_psi: {front: 61, rear: 61}, test_no: 15451, report_url: url(15451)});
  const old = row({make: 'SUBARU', model: 'Legacy', model_year: 2013, tested_as: '2013 Subaru Legacy four door sedan', powertrain: 'unknown',
    tires: {front: 'P205/60R16 91V', rear: 'P205/60R16 91V'}, cold_pressure_kpa: {front: 230, rear: 220}, cold_pressure_psi: {front: 33, rear: 32}, test_no: 8063, report_url: url(8063)});
  const {dir, file} = buildIndex([ev, old]);
  try {
    const q = {make: 'CHEVROLET', model: 'Silverado', year: 2025};
    const gas = lookupTirePlacards({...q, fuelType: 'Gasoline', evType: null}, file);
    assert.equal(gas.available, true); assert.deepEqual(gas.vehicles, []); assert.equal(gas.reason, 'other_powertrain_only');
    assert.equal(gas.other_powertrain_not_shown, 1); assert.match(gas.note, /different powertrain/);
    const bev = lookupTirePlacards({...q, fuelType: 'Electric', evType: 'BEV (Battery Electric Vehicle)'}, file);
    assert.equal(bev.vehicles.length, 1); assert.equal(bev.vehicles[0].powertrain, 'battery_electric'); assert.deepEqual(bev.vehicles[0].cold_pressure_psi, {front: 61, rear: 61});
    assert.equal(bev.other_powertrain_not_shown, undefined);
    // Unknown on either side: only an exact make/model/year match decides (the as-tested line names the vehicle).
    assert.equal(lookupTirePlacards(q, file).vehicles.length, 1);
    assert.equal(lookupTirePlacards({make: 'SUBARU', model: 'Legacy', year: 2013, fuelType: 'Gasoline'}, file).vehicles.length, 1);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('an unreadable index is unavailable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'placards-bad-')), file = join(dir, 'tire-placards.db');
  writeFileSync(file, 'not a database');
  try {
    const r = lookupTirePlacards({make: 'FORD', model: 'F-150', year: 2021}, file);
    assert.equal(r.available, false); assert.equal(r.reason, 'index_unreadable');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

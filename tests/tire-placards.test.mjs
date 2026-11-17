import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {lookupTirePlacards, keyName} from '../lib/tire-placards.mjs';

const importer = fileURLToPath(new URL('../scripts/import-tire-placards.py', import.meta.url));
const url = n => `https://nrd-static.nhtsa.dot.gov/reports/vehdb/v10000/v11400/v${n}R001.pdf`;
const row = o => ({make: 'FORD', model: 'F-150', model_year: 2021, tested_as: '2021 Ford F-150 4x4 SuperCrew', vpic_trim: 'XLT',
  tires: {front: '275/60R20 115T', rear: '275/60R20 115T'}, cold_pressure_kpa: {front: 240, rear: 240}, cold_pressure_psi: {front: 35, rear: 35},
  test_no: 11490, report_url: url(11490), confidence: 'normal', other_reports: [], ...o});

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

test('an unreadable index is unavailable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'placards-bad-')), file = join(dir, 'tire-placards.db');
  writeFileSync(file, 'not a database');
  try {
    const r = lookupTirePlacards({make: 'FORD', model: 'F-150', year: 2021}, file);
    assert.equal(r.available, false); assert.equal(r.reason, 'index_unreadable');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

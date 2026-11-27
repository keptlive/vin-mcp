import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
import {checkDecode, checkedDecode, matcherSignature, patternEvidence, patternKey, fixTestVehicleRow, PRECEDENCE, decodeChecksFor} from '../lib/decode-checks.mjs';
import {validateDecodeCorrection, insertDecodeCorrection, listDecodeCorrections, DecodeCorrectionError} from '../lib/decode-corrections.mjs';
import {compactDecodeChecks} from '../lib/decode-report.mjs';
import {summarize} from '../lib/decode-epa.mjs';
import {validateVin} from '../lib/validate.mjs';

// ── fixtures ──
const withCheck = v => v.slice(0, 8) + validateVin(v).checksum.expected + v.slice(9);
const VIN = withCheck('1V2BR2CA0JC513174'); // 2018 Volkswagen Atlas pattern; serial changed
const decoded = (o = {}) => ({
  vehicle: {year: 2018, make: 'VOLKSWAGEN', model: 'Atlas', trim: 'S', body_class: 'Sport Utility Vehicle (SUV)/Multi-Purpose Vehicle (MPV)', ...o.vehicle},
  engine: {displacement_l: 3.6, cylinders: 6, fuel_type: 'Gasoline', ev_type: null, ...o.engine},
  transmission: {type: 'Automatic', speeds: 8, drive_type: 'AWD/All-Wheel Drive', ...o.transmission},
  dimensions: {gvwr: 'Class 2E: 6,001 - 7,000 lb (2,722 - 3,175 kg)', ...o.dimensions},
  raw: {DriveType: 'AWD/All-Wheel Drive', DisplacementL: '3.6', EngineCylinders: '6', FuelTypePrimary: 'Gasoline', TransmissionStyle: 'Automatic', TransmissionSpeeds: '8', Seats: '', ...o.raw},
});
const tv = (values, o = {}) => ({vin: o.vin || withCheck('1V2BR2CA0JC51' + String(4000 + (tv.n = (tv.n || 0) + 1))), model_year: 2018, make: 'VOLKSWAGEN', model: 'Atlas', title: '2018 Volkswagen Atlas SUV',
  tests: [{test_no: 10000 + tv.n, report_url: `https://nrd-static.nhtsa.dot.gov/reports/vehdb/v10000/v10000/v${10000 + tv.n}R001.pdf`}],
  values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, typeof v === 'object' && v !== null ? v : {value: v, sources: ['data sheet']}])), ...o});
const evidence = vehicles => ({available: true, pattern: patternKey(VIN), vehicles});
const epa = configs => ({available: true, basis: 'test', models: ['Atlas', 'Atlas 4motion'], configs, strict: summarize(configs), broad: summarize(configs)});
const cfg = o => ({id: String(cfg.n = (cfg.n || 0) + 1), model: 'Atlas', drive: 'all', size: 3.6, cylinders: 6, powertrain: 'gas', transmission: 'auto', speeds: 8, strict: true, ...o});
const field = (r, f) => r.fields.find(x => x.field === f);

// ── decode checks ──
test('two agreeing test vehicles correct vPIC; the original value stays and the matcher uses the corrected one', () => {
  const r = checkDecode(decoded(), {vin: VIN, evidence: evidence([tv({drive: 'front'}), tv({drive: 'front'})]), epa: null});
  const d = field(r, 'drive');
  assert.equal(d.status, 'corrected'); assert.equal(d.rule, 'two_test_vehicles'); assert.equal(d.basis, 'nhtsa_test_vehicle_pattern');
  assert.equal(d.original, 'AWD/All-Wheel Drive'); assert.equal(d.shown_value, 'front'); assert.equal(d.matching, 'checked_value');
  assert.equal(d.evidence.test_vehicles.length, 2); assert.match(d.evidence.test_vehicles[0].report_url, /^https:\/\/nrd-static\.nhtsa\.dot\.gov\//);
  const original = decoded(), used = checkedDecode(original, r);
  assert.equal(used.transmission.drive_type, 'FWD/Front-Wheel Drive');
  assert.equal(original.transmission.drive_type, 'AWD/All-Wheel Drive'); // never changed in place
  assert.notEqual(matcherSignature(used), matcherSignature(original));
});

test('one test vehicle that differs makes the field doubtful (both shown, matcher widened) unless EPA settles it', () => {
  let r = checkDecode(decoded(), {vin: VIN, evidence: evidence([tv({drive: 'front'})]), epa: epa([cfg({drive: 'all'}), cfg({drive: 'front'})])});
  let d = field(r, 'drive');
  assert.equal(d.status, 'doubtful'); assert.equal(d.rule, 'test_vehicle_differs'); assert.equal(d.matching, 'widened');
  assert.deepEqual(d.candidates.map(c => [c.tier, c.value]), [['nhtsa_test_vehicle_pattern', 'front'], ['vpic_decode', 'all']]);
  assert.equal(checkedDecode(decoded(), r).transmission.drive_type, null);
  // EPA lists only the test vehicle's value for this model year: corrected
  r = checkDecode(decoded(), {vin: VIN, evidence: evidence([tv({drive: 'front'})]), epa: epa([cfg({drive: 'front'})])});
  d = field(r, 'drive');
  assert.equal(d.status, 'corrected'); assert.equal(d.rule, 'test_vehicle_and_epa');
});

test('a disputed lab value never corrects on its own; test vehicles that differ among themselves give doubt', () => {
  const disputed = {value: 'front', sources: ['data sheet'], disputed: true};
  let r = checkDecode(decoded(), {vin: VIN, evidence: evidence([tv({drive: disputed}), tv({drive: disputed})]), epa: null});
  assert.notEqual(field(r, 'drive').status, 'corrected');
  r = checkDecode(decoded(), {vin: VIN, evidence: evidence([tv({drive: 'front'}), tv({drive: 'all'})]), epa: null});
  assert.equal(field(r, 'drive').status, 'doubtful'); assert.equal(field(r, 'drive').rule, 'pattern_varies');
});

test('agreement confirms; a blank decode is filled and labelled; test-vehicle drive fills do not narrow the matchers', () => {
  const r = checkDecode(decoded({transmission: {drive_type: null}, raw: {DriveType: ''}}), {vin: VIN, evidence: evidence([tv({drive: 'front', engine_size: 3.6})]), epa: null});
  assert.equal(field(r, 'engine_size').status, 'confirmed');
  const d = field(r, 'drive');
  assert.equal(d.status, 'filled'); assert.equal(d.rule, 'test_vehicle_fill'); assert.equal(d.original, null); assert.equal(d.matching, 'official_value');
});

test('cross-checks with no test vehicle: 2WD/4WD, EPA not listing the value, impossible combinations', () => {
  let r = checkDecode(decoded({transmission: {drive_type: '2WD/4WD'}, raw: {DriveType: '2WD/4WD'}}), {vin: VIN, evidence: evidence([]), epa: null});
  assert.equal(field(r, 'drive').status, 'doubtful'); assert.equal(field(r, 'drive').rule, 'vpic_either');
  r = checkDecode(decoded({transmission: {speeds: 6}, raw: {TransmissionSpeeds: '6'}}), {vin: VIN, evidence: evidence([]), epa: epa([cfg({speeds: 8})])});
  assert.equal(field(r, 'speeds').status, 'doubtful'); assert.equal(field(r, 'speeds').rule, 'epa_not_listed');
  r = checkDecode(decoded({engine: {fuel_type: 'Electric', ev_type: 'BEV (Battery Electric Vehicle)', cylinders: 4, displacement_l: null}, raw: {FuelTypePrimary: 'Electric', EngineCylinders: '4', DisplacementL: ''}}), {vin: VIN, evidence: evidence([]), epa: null});
  assert.ok(r.fields.some(f => f.status === 'doubtful' && f.rule === 'electric_with_engine'));
  r = checkDecode(decoded({engine: {displacement_l: 6.2, cylinders: 3}, raw: {DisplacementL: '6.2', EngineCylinders: '3'}}), {vin: VIN, evidence: evidence([]), epa: null});
  assert.ok(r.fields.some(f => f.status === 'doubtful' && f.rule === 'size_cylinders'));
});

test('EPA listing only one kind of hybrid fills the electrification; a value EPA lists under another model name is not doubted', () => {
  // 2026 BMW 330i: vPIC gasoline with electrification blank; EPA lists every version as a mild hybrid
  let r = checkDecode(decoded(), {vin: VIN, evidence: evidence([]), epa: epa([cfg({powertrain: 'mhev'}), cfg({powertrain: 'mhev', drive: 'rear'})])});
  let p = field(r, 'powertrain');
  assert.equal(p.status, 'filled'); assert.equal(p.basis, 'assumption'); assert.equal(p.rule, 'epa_hybrid_only'); assert.equal(p.shown_value, 'mhev');
  assert.equal(p.original, 'Gasoline'); assert.equal(checkedDecode(decoded(), r).engine.ev_type, 'Mild Hybrid (MHEV)');
  // EPA lists mild and full hybrids: which one is not settled
  r = checkDecode(decoded(), {vin: VIN, evidence: evidence([]), epa: epa([cfg({powertrain: 'mhev'}), cfg({powertrain: 'hev'})])});
  assert.equal(field(r, 'powertrain').status, 'doubtful');
  // a 5.2 L the model's own listings lack, but EPA lists under "Shelby GT500 Mustang"
  const e = epa([cfg({size: 2.3, cylinders: 4}), cfg({size: 5.0, cylinders: 8})]);
  const big = decoded({engine: {displacement_l: 5.2, cylinders: 8}, raw: {DisplacementL: '5.2', EngineCylinders: '8'}});
  assert.equal(field(checkDecode(big, {vin: VIN, evidence: evidence([]), epa: e}), 'engine_size').status, 'doubtful');
  const other = [cfg({model: 'Shelby GT500 Mustang', size: 5.2, cylinders: 8, transmission: 'am', speeds: 7})];
  r = checkDecode(big, {vin: VIN, evidence: evidence([]), epa: {...e, elsewhere: {...summarize(other), configs: other, models: ['Shelby GT500 Mustang']}}});
  assert.equal(field(r, 'engine_size').status, 'unverified'); assert.equal(field(r, 'engine_size').rule, 'epa_listed_elsewhere');
});

test('GVWR varies with options inside a pattern: one differing test vehicle is a note, never a correction', () => {
  const r = checkDecode(decoded(), {vin: VIN, evidence: evidence([tv({gvwr_class: '3'})]), epa: null});
  const g = field(r, 'gvwr_class');
  assert.notEqual(g.status, 'corrected'); assert.notEqual(g.status, 'doubtful');
});

test('precedence: owner > mcp.vin rule fix > NHTSA test-vehicle pattern > vPIC > assumption; no manufacturer record', () => {
  assert.deepEqual(PRECEDENCE, ['owner', 'mcp_vin_rule_fix', 'nhtsa_test_vehicle_pattern', 'vpic_decode', 'assumption']);
  // two agreeing test vehicles correct vPIC; the owner outranks them
  let r = checkDecode(decoded(), {vin: VIN, evidence: evidence([tv({drive: 'front'}), tv({drive: 'front'})]), epa: null});
  assert.equal(field(r, 'drive').basis, 'nhtsa_test_vehicle_pattern'); assert.equal(field(r, 'drive').shown_value, 'front');
  r = checkDecode(decoded(), {vin: VIN, evidence: evidence([tv({drive: 'front'}), tv({drive: 'front'})]), epa: null, owner: {drive: 'awd'}});
  assert.equal(field(r, 'drive').basis, 'owner'); assert.equal(field(r, 'drive').shown_value, 'all');
  // mcp.vin no longer reads a manufacturer's VIN record (2026-11-18): one passed in by an old caller is ignored
  r = checkDecode(decoded(), {vin: VIN, evidence: evidence([]), epa: null, manufacturer: {available: true, text: 'ATLAS FWD', parsed: {drive: 'front'}}});
  assert.equal(field(r, 'drive').shown_value, 'all'); assert.notEqual(field(r, 'drive').basis, 'manufacturer_vin_record');
  assert.equal(r.sources.manufacturer_record, undefined);
  assert.ok(r.fields.every(f => (f.candidates || []).every(c => c.tier !== 'manufacturer_vin_record')));
  assert.doesNotMatch(r.note, /manufacturer/i);
  assert.equal(compactDecodeChecks(r).sources.manufacturer_record, undefined);
});

test('the compact MCP block keeps status, both values, the reason and report links', () => {
  const r = checkDecode(decoded(), {vin: VIN, evidence: evidence([tv({drive: 'front'})]), epa: epa([cfg({drive: 'all'}), cfg({drive: 'front'})])});
  const c = compactDecodeChecks(r);
  const d = c.fields.find(f => f.field === 'drive');
  assert.equal(d.status, 'doubtful'); assert.equal(d.official, 'AWD/All-Wheel Drive'); assert.equal(d.candidates.length, 2);
  assert.match(d.test_reports[0], /^https:\/\/nrd-static/);
  assert.ok(JSON.stringify(c).length < JSON.stringify(r).length);
  assert.deepEqual(c.precedence, PRECEDENCE);
});

test('test-vehicle rows for the tire lookup are fixed only where the audit found the test vehicle\'s own decode wrong', () => {
  const row = {test_no: 999999991, drive_type: 'AWD/All-Wheel Drive', fuel_type: 'Gasoline'};
  assert.deepEqual(fixTestVehicleRow(row), row); // unknown test number: unchanged
});

// ── the importer and the real index ──
const importer = fileURLToPath(new URL('../scripts/import-decode-evidence.py', import.meta.url));
test('the importer validates rows and refuses a short or malformed source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decode-evidence-'));
  try {
    const run = rows => {
      const code = `import importlib.util,sys,pathlib;s=importlib.util.spec_from_file_location('i',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.SOURCE=pathlib.Path(sys.argv[2]);m.SOURCE_META=pathlib.Path(sys.argv[2]+'.meta');m.TARGET=pathlib.Path(sys.argv[3]);m.main()`;
      writeFileSync(join(dir, 'src.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
      return spawnSync('python3', ['-c', code, importer, join(dir, 'src.jsonl'), join(dir, 'out.db')], {encoding: 'utf8'});
    };
    const good = i => { const vin = withCheck('1V2BR2CA0JC5' + String(10000 + i)); return {pattern: vin.slice(0, 8) + '*' + vin.slice(9, 11), vin, model_year: 2018, make: 'VOLKSWAGEN', model: 'Atlas', title: 't', tests: [{test_no: 10000 + i, report_url: 'https://nrd-static.nhtsa.dot.gov/x.pdf'}], values: {drive: {value: 'front', sources: ['data sheet']}}}; };
    assert.notEqual(run([good(1)]).status, 0); // fewer than 100 rows
    const rows = Array.from({length: 120}, (_, i) => good(i));
    assert.equal(run(rows).status, 0);
    const db = new Database(join(dir, 'out.db'), {readonly: true});
    assert.equal(db.prepare('SELECT COUNT(*) c FROM vehicles').get().c, 120); db.close();
    assert.notEqual(run([...rows, {...good(200), values: {drive: {value: 'sideways', sources: []}}}]).status, 0);
    assert.notEqual(run([...rows, {...good(201), tests: [{test_no: 1, report_url: 'https://example.com/x.pdf'}]}]).status, 0);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

const INDEX = fileURLToPath(new URL('../data/decode-evidence.db', import.meta.url));
let hasIndex = false; try { readFileSync(INDEX); hasIndex = true; } catch {}
test('real index: the 2018 Atlas pattern and the 2014 RDX pattern', {skip: !hasIndex && 'data/decode-evidence.db not built'}, () => {
  const atlas = patternEvidence(withCheck('1V2BR2CA0JC599999'));
  assert.equal(atlas.available, true); assert.ok(atlas.vehicles.length >= 2);
  // the test vehicle itself is left out of its own evidence
  assert.ok(!patternEvidence('1V2BR2CA3JC513174').vehicles.some(v => v.vin === '1V2BR2CA3JC513174'));
  const rdx = decodeChecksFor(withCheck('5J8TB3H30EL099999'), decoded({vehicle: {year: 2014, make: 'ACURA', model: 'RDX', trim: null}, engine: {displacement_l: 3.5, cylinders: 6}, transmission: {type: 'Automatic', speeds: 6, drive_type: 'AWD/All-Wheel Drive'}, raw: {DriveType: 'AWD/All-Wheel Drive', DisplacementL: '3.5', TransmissionSpeeds: '6'}}));
  const d = rdx.fields.find(f => f.field === 'drive');
  assert.equal(d.status, 'corrected'); assert.equal(d.shown_value, 'front'); assert.equal(d.original, 'AWD/All-Wheel Drive');
});

// ── "Report a decode error" ──
test('decode-error reports: validation, 11-character VIN prefix, no IP, list for review', () => {
  assert.throws(() => validateDecodeCorrection(null), DecodeCorrectionError);
  assert.throws(() => validateDecodeCorrection({vin: '1V2BR2CA3JC513175', field: 'drive', value: 'FWD'}), /valid VIN/);
  assert.throws(() => validateDecodeCorrection({vin: '1V2BR2CA3JC513174', field: 'colour', value: 'red'}), /Choose which field/);
  assert.throws(() => validateDecodeCorrection({vin: '1V2BR2CA3JC513174', field: 'drive'}), /Say what/);
  assert.throws(() => validateDecodeCorrection({vin: '1V2BR2CA3JC513174', field: 'drive', value: 'x'.repeat(81)}), /too long/);
  assert.throws(() => validateDecodeCorrection({vin: '1V2BR2CA3JC513174', field: 'drive', value: 'FWD', source: 'friend'}), /How you know/);
  const input = validateDecodeCorrection({vin: '1v2br2ca3jc513174', field: 'drive', value: ' front\u0000wheel drive ', source: 'owner', ip: '203.0.113.9'});
  assert.equal(input.value, 'front wheel drive'); assert.equal(input.ip, undefined);
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE decode_corrections (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')), vin_prefix TEXT NOT NULL,
    model_year INTEGER, make TEXT, model TEXT, trim TEXT, field TEXT NOT NULL, reported_value TEXT, source TEXT, note TEXT, shown TEXT NOT NULL)`);
  const report = {vehicle: decoded().vehicle, decode_checks: checkDecode(decoded(), {vin: VIN, evidence: evidence([tv({drive: 'front'})]), epa: null})};
  insertDecodeCorrection(db, input, report);
  const list = listDecodeCorrections(db);
  assert.equal(list.count, 1);
  const row = list.corrections[0];
  assert.equal(row.vin_prefix, '1V2BR2CA3JC'); assert.equal(row.field, 'drive'); assert.equal(row.shown.status, 'doubtful'); assert.equal(row.shown.original, 'AWD/All-Wheel Drive');
  assert.ok(!JSON.stringify(row).includes('513174')); assert.ok(!('ip' in row));
});

// ── browser: markers keep the official value visible ──
test('web markers: corrected and doubtful values show the official decode beside them, escaped', () => {
  const ctx = vm.createContext({console});
  vm.runInContext(readFileSync(new URL('../public/decode-checks.js', import.meta.url), 'utf8') + '\nthis.DecodeChecks = DecodeChecks;', ctx);
  const DC = ctx.DecodeChecks;
  const corrected = checkDecode(decoded(), {vin: VIN, evidence: evidence([tv({drive: 'front'}), tv({drive: 'front'})]), epa: null});
  let html = DC.valueHtml({decode_checks: corrected}, 'drive', 'AWD/All-Wheel Drive');
  assert.match(html, /front-wheel drive/); assert.match(html, /Corrected/); assert.match(html, /official decode: AWD\/All-Wheel Drive/);
  const doubtful = checkDecode(decoded(), {vin: VIN, evidence: evidence([tv({drive: 'front'})]), epa: null});
  html = DC.valueHtml({decode_checks: doubtful}, 'drive', 'AWD/All-Wheel Drive');
  assert.match(html, /^AWD\/All-Wheel Drive /); assert.match(html, /Doubtful/); assert.match(html, /front-wheel drive/);
  assert.equal(DC.valueHtml({}, 'drive', '<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;');
  const card = DC.cardHtml({vin: VIN, decode_checks: corrected});
  assert.match(card, /Report a decode error/); assert.match(card, /\/privacy\/#decode-corrections/); assert.match(card, /nrd-static\.nhtsa\.dot\.gov/);
  assert.match(DC.cardHtml({vin: VIN}), /not available/);
});

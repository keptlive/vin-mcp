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
import {descriptionOf, parseDescription, manufacturerDescription} from '../lib/manufacturer-description.mjs';
import {validateDecodeCorrection, insertDecodeCorrection, listDecodeCorrections, DecodeCorrectionError} from '../lib/decode-corrections.mjs';
import {compactDecodeChecks, manufacturerRecordOf} from '../lib/decode-report.mjs';
import {createRecallStatusLookup} from '../lib/recall-status.mjs';
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

// Real reply shapes (trimmed) from the makers' recall lookups, 2026-11-16/17; test-vehicle and examples-page VINs.
const REPLY = {
  vwAtlas: {vin: '1V2BR2CA3JC513174', status: true, year: 2018, make: 'VW', model: 'ATLAS S 3.6 LAUNCH FWD', manufacturerId: 1, isRecallsAvailable: false, numberOfRecalls: 0, refreshDate: 'Nov 17, 2026'},
  vwPassat: {vin: '1VWAS7A33GC011306', status: true, year: 2016, make: 'VW', model: 'PASSAT GP S 1.8T FED AUTO', manufacturerId: 1, isRecallsAvailable: false, numberOfRecalls: 0, refreshDate: 'Nov 17, 2026'},
  vwPzev: {vin: '1VWCP7A35CC101500', status: true, year: 2012, make: 'VW', model: 'PASSAT SEL PREMIUM 2.5L Auto PZEV', manufacturerId: 1, isRecallsAvailable: false, numberOfRecalls: 0, refreshDate: 'Nov 13, 2026'},
  vwTdi: {vin: '1VWBN7A38DC042297', status: true, year: 2013, make: 'VW', model: 'PASSAT TDI SE W/SUNROOF & NAV 2.0L AUTO', manufacturerId: 1, isRecallsAvailable: false, numberOfRecalls: 0, refreshDate: 'Nov 13, 2026'},
  audiA6: {data: {vehicleRecalls: {brand: 'AUDI', model: 'A6 SEDAN 2.0T FWD MULTITRONIC', modelYear: 2014, refreshDate: 'Nov 17, 2026', recalls: []}}},
  audiQ5h: {data: {vehicleRecalls: {brand: 'AUDI', model: 'Q5 2.0T QUATTRO HYBRID', modelYear: 2013, refreshDate: 'Nov 17, 2026', recalls: []}}},
  audiA3: {data: {vehicleRecalls: {brand: 'AUDI', model: 'A3 Sedan 1.8T FWD S tronic', modelYear: 2015, refreshDate: 'Nov 17, 2026', recalls: []}}},
  lrEvoque: {model: '2017', vin: 'SALVP2BG3HH247669', error: 204, vehicle: 'Range Rover Evoque 2.0L Si4 Petrol 4WD A'},
  lrDisco: {model: '2015', vin: 'SALCT2BG3FH522411', error: 204, vehicle: 'Discovery Sport 2.0L Si4 Petrol 4WD  5 D'}, // two spaces, as sent
  jagFpace: {model: '2017', vin: 'SADCJ2BN8HA088546', error: 204, vehicle: 'F-PACE 2.0L i4D 180PS Diesel AWD 5 Door'},
  lrDefender: {vehicleIdentificationNumber: 'SALEJ7EXXP2148570', make: 'LAND ROVER', vehicleName: 'Defender 2.0L T/C Petrol AWD 5 Door Auto', year: 2023, manufacturerId: 146, numberOfRecalls: 0, recallsAvailable: false, recalls: []},
  subaru25x: {modelYear: 2011, modelName: 'Forester', trimName: '2.5X', vin: 'JF2SHBBC8BG700171', recalls: []},
  honda: (name, division) => ({actions: [{id: '1;a', state: 'SUCCESS', error: [], returnValue: {returnValue: {response: {recalls_response: {response: {error: 'false', recall: {campaignType: {}, division_cd: division, model_group_name: name, VIN: '1HGCM82633A004352'}}}}}}}]}),
};

// ── manufacturer descriptions ──
test('manufacturer descriptions: the field each maker uses is read with its year; makers without one give nothing', () => {
  assert.deepEqual(descriptionOf('vw', REPLY.vwAtlas), {text: 'ATLAS S 3.6 LAUNCH FWD', reply_field: 'model', model_year: 2018});
  assert.equal(descriptionOf('audi', REPLY.audiA6).text, 'A6 SEDAN 2.0T FWD MULTITRONIC');
  assert.equal(descriptionOf('landrover', REPLY.lrEvoque).truncated, true);
  assert.equal(descriptionOf('landrover', REPLY.lrDefender).reply_field, 'vehicleName');
  assert.equal(descriptionOf('subaru', REPLY.subaru25x).text, 'Forester 2.5X');
  assert.equal(descriptionOf('honda', REPLY.honda('MDX', 'B')).division, 'Acura');
  for (const p of ['tesla', 'ford', 'gm', 'nissan', 'mopar']) assert.equal(descriptionOf(p, {model: 'X 2.0T AWD'}), null, p);
  assert.equal(manufacturerDescription('gm', {}).reason, 'not_supplied_by_manufacturer');
  assert.equal(manufacturerDescription('vw', {vin: 'x', status: true}).reason, 'not_in_reply');
});

test('manufacturer descriptions: only what the text states unambiguously is parsed', () => {
  const p = (body, prov) => manufacturerDescription(prov, body, {provider: 'x', retrieved_at: '2026-11-17T10:00:00Z'});
  let d = p(REPLY.vwAtlas, 'vw');
  assert.deepEqual(d.parsed, {engine_size_l: 3.6, drive: 'front'}); assert.equal(d.text, 'ATLAS S 3.6 LAUNCH FWD');
  assert.equal(d.source.retrieved_at, '2026-11-17T10:00:00Z');
  assert.deepEqual(p(REPLY.audiA6, 'audi').parsed, {body: 'sedan', engine_size_l: 2, drive: 'front', transmission: 'cvt'});
  assert.deepEqual(p(REPLY.audiA3, 'audi').parsed.transmission, 'am'); // "S tronic" = dual clutch
  assert.equal(p(REPLY.audiQ5h, 'audi').parsed.powertrain, 'hev');
  d = p(REPLY.jagFpace, 'jaguar');
  assert.deepEqual(d.parsed, {engine_size_l: 2, cylinders: 4, powertrain: 'diesel', drive: 'all', doors: 5});
  assert.equal(p(REPLY.vwTdi, 'vw').parsed.powertrain, 'diesel');
  // cut at 40 characters: a final "A" after a drive word is the start of "Auto"; "5 D" is "5 Door"
  assert.equal(p(REPLY.lrEvoque, 'landrover').parsed.transmission, 'auto');
  assert.equal(p(REPLY.lrDisco, 'landrover').parsed.doors, 5);
});

test('manufacturer descriptions: strings that must not be over-read', () => {
  const parsed = t => parseDescription(t).parsed;
  // emissions labels and trims are not engines, fuels or drives
  assert.deepEqual(parsed('PASSAT SEL PREMIUM 2.5L Auto PZEV'), {engine_size_l: 2.5, transmission: 'auto'});
  assert.deepEqual(parsed('PASSAT GP S 1.8T FED AUTO'), {engine_size_l: 1.8, transmission: 'auto'});
  // Subaru's "2.5X" is a trim: engine size only, no drive, no cylinders
  assert.deepEqual(manufacturerDescription('subaru', REPLY.subaru25x).parsed, {engine_size_l: 2.5, trim: '2.5X'});
  // "e-tron" names Audi plug-ins and battery-electric cars alike: not parsed
  assert.equal(parsed('A3 Sportback e-tron 1.4T S tronic').powertrain, undefined);
  assert.equal(parsed('e-tron quattro').powertrain, undefined);
  // a lone "A" is not "Auto" unless the text was cut and a drive word came first
  assert.equal(parsed('A4 2.0T A').transmission, undefined);
  assert.equal(parseDescription('Range Rover Evoque 2.0L Si4 Petrol A', {truncated: true}).parsed.transmission, undefined);
  // Honda gives only the model line: a body word is read, nothing else
  assert.deepEqual(manufacturerDescription('honda', REPLY.honda('Accord Coupe', 'A')).parsed, {body: 'coupe', division: 'Honda'});
  assert.deepEqual(manufacturerDescription('honda', REPLY.honda('CR-V', 'A')).parsed, {division: 'Honda'});
  // two words that disagree leave the field unset
  const c = parseDescription('GOLF 2.0T FWD AWD');
  assert.equal(c.parsed.drive, undefined); assert.ok(c.conflicts.includes('drive'));
  // model numbers are not engine sizes
  assert.equal(parsed('Q5 3.0T QUATTRO TIPTRONIC').engine_size_l, 3);
  assert.equal(parsed('MODEL 3').engine_size_l, undefined);
});

test('recall status carries the manufacturer description from the same reply, with no extra request', async () => {
  const calls = [];
  const lookup = createRecallStatusLookup(async url => { calls.push(url); return {ok: true, json: async () => REPLY.vwAtlas, text: async () => JSON.stringify(REPLY.vwAtlas)}; });
  const r = await lookup('1V2BR2CA3JC513174');
  assert.equal(calls.length, 1);
  assert.equal(r.available, true);
  assert.equal(r.manufacturer_description.available, true);
  assert.equal(r.manufacturer_description.text, 'ATLAS S 3.6 LAUNCH FWD');
  assert.equal(r.manufacturer_description.parsed.drive, 'front');
  assert.match(r.manufacturer_description.source.provider, /Volkswagen/);
  assert.ok(r.manufacturer_description.source.retrieved_at);
  assert.equal(await lookup('1V2BR2CA3JC513174'), r); // cached: still one request
  assert.equal(calls.length, 1);
});

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

test('precedence: owner > manufacturer VIN record > NHTSA test-vehicle pattern > vPIC > assumption', () => {
  assert.deepEqual(PRECEDENCE, ['owner', 'manufacturer_vin_record', 'nhtsa_test_vehicle_pattern', 'vpic_decode', 'assumption']);
  const mfr = manufacturerDescription('vw', REPLY.vwAtlas, {provider: 'Volkswagen U.S. VIN Recall Lookup', retrieved_at: '2026-11-17T10:00:00Z'});
  // the manufacturer's record alone corrects vPIC
  let r = checkDecode(decoded(), {vin: VIN, evidence: evidence([]), epa: null, manufacturer: mfr});
  let d = field(r, 'drive');
  assert.equal(d.status, 'corrected'); assert.equal(d.basis, 'manufacturer_vin_record'); assert.equal(d.shown_value, 'front');
  assert.equal(r.sources.manufacturer_record.status, 'used'); assert.equal(r.sources.manufacturer_record.text, 'ATLAS S 3.6 LAUNCH FWD');
  // ... and outranks two test vehicles that say otherwise
  r = checkDecode(decoded(), {vin: VIN, evidence: evidence([tv({drive: 'all'}), tv({drive: 'all'})]), epa: null, manufacturer: mfr});
  assert.equal(field(r, 'drive').basis, 'manufacturer_vin_record'); assert.equal(field(r, 'drive').shown_value, 'front');
  // the owner outranks the manufacturer's record
  r = checkDecode(decoded(), {vin: VIN, evidence: evidence([]), epa: null, manufacturer: mfr, owner: {drive: 'awd'}});
  assert.equal(field(r, 'drive').basis, 'owner'); assert.equal(field(r, 'drive').shown_value, 'all');
  // no record yet / none supplied is said in the data
  assert.equal(checkDecode(decoded(), {vin: VIN, evidence: evidence([]), epa: null}).sources.manufacturer_record.status, 'not_checked');
  assert.equal(checkDecode(decoded(), {vin: VIN, evidence: evidence([]), epa: null, manufacturer: {available: false, reason: 'not_supplied_by_manufacturer'}}).sources.manufacturer_record.status, 'not_available');
  assert.equal(manufacturerRecordOf({available: false, reason: 'manufacturer_not_supported'}).reason, 'manufacturer_not_supported');
  assert.equal(manufacturerRecordOf({available: true, open_count: 0}).reason, 'not_supplied_by_manufacturer');
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

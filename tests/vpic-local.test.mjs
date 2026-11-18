import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildFixtureDb} from '../scripts/make-vpic-fixture.mjs';
import {checkRuleFixes} from '../scripts/check-vpic-rule-fixes.mjs';
import {decodeLocal, closeVpicLocal, LIVE_VALUE_KEYS} from '../lib/vpic-local.mjs';
import {decodeVin, batchDecode, localFallbackReason, DECODE_SOURCE_LOCAL, DECODE_SOURCE_LIVE} from '../lib/nhtsa.mjs';
import {checkDecode, checkedDecode, officialDecode, patternKey, PRECEDENCE} from '../lib/decode-checks.mjs';
import {compactDecodeChecks, decodedFromReport} from '../lib/decode-report.mjs';
import {summarize} from '../lib/decode-epa.mjs';
import {specificationsProvenance} from '../lib/reports.mjs';

// tests/fixtures/vpic-mini.json: the rows of NHTSA release 2026_11 (with mcp.vin's rule fixes) that these VINs read,
// cut by scripts/make-vpic-fixture.mjs, with the full release's decode of each VIN.
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/vpic-mini.json', import.meta.url), 'utf8'));
const NOW = new Date(FIXTURE.now);
const ATLAS = '1V2BR2CA3JC513174';     // 2018 Atlas Launch Edition FWD, NHTSA test vehicle: rule fix rf-008
const GR = 'JTNABAAE3PA004901';        // 2023 GR Corolla, NHTSA test vehicle: rule fix rf-023
const ACCENT = '3KPC24A67LE094049';    // 2020 Accent, NHTSA test vehicle: no fix
const WRANGLER27 = '1C4PJXDG7VW100001'; // synthetic 2027 Wrangler: model year newer than the release
const UNKNOWN = '1ZZAB1236C1234567';    // synthetic, WMI not in the release
const dir = mkdtempSync(join(tmpdir(), 'vpic-local-test-'));
const DB = buildFixtureDb(FIXTURE, join(dir, 'vpic.db'));
test.after(() => { closeVpicLocal(); rmSync(dir, {recursive: true, force: true}); });

const noNetwork = () => { throw new Error('no network call expected'); };
/** A fetch that answers DecodeVinValues / DecodeVINValuesBatch like the live API and records the calls. */
function liveApi(answers) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({url: String(url), body: init.body ?? null});
    let vins;
    if (String(url).includes('DecodeVINValuesBatch')) vins = new URLSearchParams(init.body).get('DATA').split(';').map(s => s.replace(/,$/, ''));
    else vins = [decodeURIComponent(String(url).match(/DecodeVinValues\/([^?]+)/)[1])];
    const Results = vins.reverse().map(v => answers[v] && {VIN: v, ...answers[v]}).filter(Boolean); // reversed: answers are matched by VIN
    return {ok: true, status: 200, json: async () => ({Count: Results.length, Results})};
  };
  return {fetch, calls};
}
const LIVE_WRANGLER = {ModelYear: '2027', Make: 'JEEP', Model: 'Wrangler', DriveType: '4WD/4-Wheel Drive/4x4', ErrorCode: '0'};
const LIVE_UNKNOWN = {ModelYear: '', Make: '', Model: '', ErrorCode: '7', ErrorText: '7 - Manufacturer is not registered with NHTSA'};

test('the fixture decodes exactly as the full release did, on fixed and on NHTSA\'s pristine rules', () => {
  for (const vin of FIXTURE.vins) {
    for (const rules of ['fixed', 'pristine']) {
      const d = decodeLocal(vin, {file: DB, rules, now: NOW});
      assert.equal(d.available, true, vin);
      assert.deepEqual(d.values, FIXTURE.expected[vin][rules].values, `${vin} ${rules}`);
      assert.deepEqual(d.rule_fixes, FIXTURE.expected[vin][rules].rule_fixes, `${vin} ${rules} rule_fixes`);
    }
  }
});

test('flat values have the live API\'s DecodeVinValues keys, all strings, blank as \'\'', () => {
  const d = decodeLocal(ACCENT, {file: DB, now: NOW});
  assert.deepEqual(Object.keys(d.values), [...LIVE_VALUE_KEYS]);
  assert.equal(LIVE_VALUE_KEYS.length, 154);
  assert.ok(Object.values(d.values).every(v => typeof v === 'string'));
  assert.equal(d.values.VIN, ACCENT); assert.equal(d.values.ModelYear, '2020'); assert.equal(d.values.Make, 'HYUNDAI');
  assert.equal(d.release, '2026_11'); assert.equal(d.rules, 'fixed'); assert.equal(d.rule_fixes, null);
  assert.equal(decodeLocal(ACCENT, {file: join(dir, 'missing.db')}).reason, 'dataset_not_indexed');
  assert.equal(decodeLocal(ACCENT, {file: DB, rules: 'other'}).available, false);
});

test('a rule fix gives our value and discloses NHTSA\'s official one, the fix, its reason and evidence', () => {
  const fixed = decodeLocal(ATLAS, {file: DB, now: NOW}), pristine = decodeLocal(ATLAS, {file: DB, rules: 'pristine', now: NOW});
  assert.equal(fixed.values.DriveType, 'FWD/Front-Wheel Drive');
  assert.equal(pristine.values.DriveType, 'AWD/All-Wheel Drive');
  assert.equal(pristine.rule_fixes, null);
  assert.deepEqual(fixed.rule_fixes.changed, [{field: 'DriveType', official_value: 'AWD/All-Wheel Drive', value: 'FWD/Front-Wheel Drive', fix_ids: ['rf-008']}]);
  const f = fixed.rule_fixes.fixes[0];
  assert.equal(f.id, 'rf-008'); assert.equal(f.written_against, '2026_11'); assert.match(f.reason, /Launch/);
  assert.ok(f.evidence.length && f.evidence.every(e => /^https:\/\/nrd-static\.nhtsa\.dot\.gov\//.test(e.url)));
  // only the fixed field differs between the two rule views
  assert.deepEqual(Object.keys(fixed.values).filter(k => fixed.values[k] !== pristine.values[k]), ['DriveType']);
  const gr = decodeLocal(GR, {file: DB, now: NOW});
  assert.equal(gr.values.TransmissionStyle, 'Manual/Standard');
  assert.equal(gr.rule_fixes.changed[0].official_value, 'Continuously Variable Transmission (CVT)');
});

test('the changeset\'s own checks pass on the fixture (rf-008, rf-023)', () => {
  const res = checkRuleFixes({db: DB, ids: ['rf-008', 'rf-023']});
  assert.deepEqual(res.map(r => [r.id, r.status]), [['rf-008', 'ok'], ['rf-023', 'ok']]);
});

test('decodeVin decodes locally first: no network, provenance names the release and the rule fixes', async () => {
  const d = await decodeVin(ATLAS, {vpicFile: DB, fetch: noNetwork, now: NOW});
  assert.equal(d.decode_source.source, DECODE_SOURCE_LOCAL);
  assert.equal(d.decode_source.vpic_release, '2026_11'); assert.equal(d.decode_source.fallback_reason, null);
  assert.equal(d.decode_source.rules, 'nhtsa_with_mcp_vin_rule_fixes'); assert.equal(d.decode_source.rule_fixes_changed_this_vin, true);
  assert.equal(d.transmission.drive_type, 'FWD/Front-Wheel Drive'); assert.equal(d.raw.DriveType, 'FWD/Front-Wheel Drive');
  assert.equal(d.vpic_rule_fixes.changed[0].official_value, 'AWD/All-Wheel Drive');
  assert.equal(officialDecode(d).transmission.drive_type, 'AWD/All-Wheel Drive');
  assert.equal(officialDecode(d).raw.DriveType, 'AWD/All-Wheel Drive');
  assert.match(specificationsProvenance(d), /release 2026_11, with \d+ reviewed mcp\.vin fixes/);
  const accent = await decodeVin(ACCENT, {vpicFile: DB, fetch: noNetwork, now: NOW});
  assert.equal(accent.decode_source.rule_fixes_changed_this_vin, false); assert.equal(accent.vpic_rule_fixes, undefined);
});

test('fallback to the live API: unknown WMI, model year newer than the release, no dataset, decoder off', async () => {
  const local = v => decodeLocal(v, {file: DB, now: NOW});
  assert.equal(localFallbackReason(local(UNKNOWN)), 'wmi_unknown');
  assert.equal(localFallbackReason(local(WRANGLER27)), 'model_year_newer_than_release');
  assert.equal(localFallbackReason(local(ACCENT)), null);
  assert.equal(localFallbackReason({available: true, release: '2026_11', values: {ErrorCode: '0', Model: '', ModelYear: '2020'}}), 'no_model');
  assert.equal(localFallbackReason(null), 'dataset_not_indexed');
  const api = liveApi({[WRANGLER27]: LIVE_WRANGLER, [UNKNOWN]: LIVE_UNKNOWN, [ACCENT]: {ModelYear: '2020', Make: 'HYUNDAI', Model: 'Accent'}});
  let d = await decodeVin(WRANGLER27, {vpicFile: DB, fetch: api.fetch, now: NOW});
  assert.equal(d.decode_source.source, DECODE_SOURCE_LIVE); assert.equal(d.decode_source.fallback_reason, 'model_year_newer_than_release');
  assert.equal(d.decode_source.local_vpic_release, '2026_11'); assert.equal(d.vehicle.model, 'Wrangler');
  assert.match(api.calls[0].url, /DecodeVinValues\/1C4PJXDG7VW100001\?format=json$/);
  d = await decodeVin(UNKNOWN, {vpicFile: DB, fetch: api.fetch, now: NOW});
  assert.equal(d.decode_source.fallback_reason, 'wmi_unknown');
  d = await decodeVin(ACCENT, {vpicFile: join(dir, 'missing.db'), fetch: api.fetch, now: NOW});
  assert.equal(d.decode_source.source, DECODE_SOURCE_LIVE); assert.equal(d.decode_source.fallback_reason, 'dataset_not_indexed');
  d = await decodeVin(ACCENT, {vpicFile: null, fetch: api.fetch, now: NOW});
  assert.equal(d.decode_source.fallback_reason, 'local_decoder_off');
  assert.equal(api.calls.length, 4);
  // the live API failing on a fallback: the local decode, saying so; nothing at all without a dataset
  const down = async () => ({ok: false, status: 503, json: async () => ({})});
  d = await decodeVin(WRANGLER27, {vpicFile: DB, fetch: down, now: NOW});
  assert.equal(d.decode_source.source, DECODE_SOURCE_LOCAL); assert.equal(d.decode_source.live_api, 'failed');
  assert.equal(d.decode_source.fallback_reason, 'model_year_newer_than_release'); assert.equal(d.vehicle.model, 'Wrangler');
  assert.equal(await decodeVin(ACCENT, {vpicFile: join(dir, 'missing.db'), fetch: down}), null);
});

test('batchDecode: local where it can, one live request for the rest, answers matched by VIN', async () => {
  const api = liveApi({[WRANGLER27]: LIVE_WRANGLER, [UNKNOWN]: LIVE_UNKNOWN});
  const res = await batchDecode([ATLAS, WRANGLER27, ACCENT, UNKNOWN], {vpicFile: DB, fetch: api.fetch, now: NOW});
  assert.equal(api.calls.length, 1);
  assert.equal(new URLSearchParams(api.calls[0].body).get('DATA'), `${WRANGLER27},;${UNKNOWN},`);
  assert.deepEqual(res.map(r => r.decode_source.source), [DECODE_SOURCE_LOCAL, DECODE_SOURCE_LIVE, DECODE_SOURCE_LOCAL, DECODE_SOURCE_LIVE]);
  assert.equal(res[1].vehicle.model, 'Wrangler'); assert.equal(res[3].raw.ErrorCode, '7');
  assert.equal(res[0].transmission.drive_type, 'FWD/Front-Wheel Drive'); assert.ok(res[0].vpic_rule_fixes);
  // all local: no request at all
  const none = liveApi({});
  await batchDecode([ATLAS, ACCENT], {vpicFile: DB, fetch: none.fetch, now: NOW});
  assert.equal(none.calls.length, 0);
});

const evidence = (vin, vehicles = []) => ({available: true, pattern: patternKey(vin), vehicles});
const field = (r, f) => r.fields.find(x => x.field === f);

test('decode checks: a rule fix corrects the field (basis mcp.vin rule fix), keeps NHTSA\'s value, below owner and manufacturer', async () => {
  assert.deepEqual(PRECEDENCE, ['owner', 'manufacturer_vin_record', 'mcp_vin_rule_fix', 'nhtsa_test_vehicle_pattern', 'vpic_decode', 'assumption']);
  const d = await decodeVin(ATLAS, {vpicFile: DB, fetch: noNetwork, now: NOW});
  // two test vehicles that say all-wheel drive do not outrank the reviewed fix
  const tvAll = {vin: ATLAS, model_year: 2018, title: 'test', tests: [{test_no: 1, report_url: 'https://nrd-static.nhtsa.dot.gov/reports/x.pdf'}], values: {drive: {value: 'all', sources: ['data sheet']}}};
  let r = checkDecode(d, {vin: ATLAS, evidence: evidence(ATLAS, [tvAll, tvAll]), epa: null});
  let x = field(r, 'drive');
  assert.equal(x.status, 'corrected'); assert.equal(x.basis, 'mcp_vin_rule_fix'); assert.equal(x.rule, 'mcp_vin_rule_fix');
  assert.equal(x.original, 'AWD/All-Wheel Drive'); assert.equal(x.original_value, 'all'); assert.equal(x.shown_value, 'front');
  assert.equal(x.matching, 'checked_value');
  assert.match(x.note, /mcp\.vin rule fix .* gives front-wheel drive; the official decode says all-wheel or four-wheel drive\. .*Launch/);
  assert.deepEqual(x.evidence.rule_fix.changed, [{field: 'DriveType', official_value: 'AWD/All-Wheel Drive', value: 'FWD/Front-Wheel Drive'}]);
  assert.equal(x.evidence.rule_fix.fixes[0].id, 'rf-008');
  assert.deepEqual(x.candidates.map(c => c.tier), ['mcp_vin_rule_fix', 'nhtsa_test_vehicle_pattern', 'vpic_decode']);
  assert.deepEqual(r.sources.rule_fixes.ids, ['rf-008']); assert.equal(r.sources.rule_fixes.status, 'used');
  assert.equal(checkedDecode(d, r).transmission.drive_type, 'FWD/Front-Wheel Drive');
  const c = compactDecodeChecks(r).fields.find(f => f.field === 'drive');
  assert.equal(c.official, 'AWD/All-Wheel Drive'); assert.deepEqual(c.rule_fixes, ['rf-008']); assert.match(c.fix_reports[0], /^https:\/\/nrd-static/);
  // the owner outranks the fix (the fix stays listed)
  r = checkDecode(d, {vin: ATLAS, evidence: evidence(ATLAS), epa: null, owner: {drive: 'awd'}});
  x = field(r, 'drive');
  assert.equal(x.basis, 'owner'); assert.equal(x.shown_value, 'all'); assert.equal(x.status, 'confirmed');
  assert.ok(x.candidates.some(k => k.tier === 'mcp_vin_rule_fix' && k.value === 'front'));
  // a report rebuilt from its JSON checks the same way (raw_nhtsa is NHTSA's official decode)
  const report = {vehicle: d.vehicle, engine: d.engine, transmission: d.transmission, dimensions: d.dimensions, plant: d.plant, safety_equipment: d.safety,
    raw_nhtsa: officialDecode(d).raw, decode_source: d.decode_source, vpic_rule_fixes: d.vpic_rule_fixes};
  assert.equal(report.raw_nhtsa.DriveType, 'AWD/All-Wheel Drive');
  const again = checkDecode(decodedFromReport(report), {vin: ATLAS, evidence: evidence(ATLAS), epa: null});
  assert.equal(field(again, 'drive').basis, 'mcp_vin_rule_fix'); assert.equal(field(again, 'drive').original, 'AWD/All-Wheel Drive');
  // a live-API decode gets no rule fix, and says so
  const live = await decodeVin(WRANGLER27, {vpicFile: DB, fetch: liveApi({[WRANGLER27]: LIVE_WRANGLER}).fetch, now: NOW});
  assert.equal(checkDecode(live, {vin: WRANGLER27, evidence: evidence(WRANGLER27), epa: null}).sources.rule_fixes.status, 'not_applied');
});

const cfg = o => ({id: String(cfg.n = (cfg.n || 0) + 1), model: 'Accent', drive: 'front', size: 1.6, cylinders: 4, powertrain: 'gas', strict: true, ...o});
const epaOf = configs => ({available: true, basis: 'test', models: ['Accent'], configs, strict: summarize(configs), broad: summarize(configs)});
const tvManual = n => ({vin: ACCENT, model_year: 2020, title: '2020 Hyundai Accent', tests: [{test_no: 9000 + n, report_url: `https://nrd-static.nhtsa.dot.gov/reports/vehdb/v09000/v${9000 + n}R001.pdf`}],
  values: {transmission: {value: 'manual', sources: ['data sheet']}, speeds: {value: 6, sources: ['data sheet']}, drive: {value: 'front', sources: ['data sheet']}}});

test('2020 Accent: test vehicles do not settle the transmission when EPA lists manual and automatic; the owner\'s does', async () => {
  const d = await decodeVin(ACCENT, {vpicFile: DB, fetch: noNetwork, now: NOW});
  assert.equal(d.transmission.type, null); assert.equal(d.transmission.speeds, null); // vPIC leaves both blank
  const both = epaOf([cfg({transmission: 'manual', speeds: 6}), cfg({transmission: 'cvt', speeds: null})]);
  let r = checkDecode(d, {vin: ACCENT, evidence: evidence(ACCENT, [tvManual(1), tvManual(2)]), epa: both});
  for (const k of ['transmission', 'speeds']) {
    const x = field(r, k);
    assert.equal(x.status, 'unverified', k); assert.equal(x.shown_value, null, k); assert.equal(x.rule, 'test_vehicle_not_settled', k);
    assert.equal(x.matching, 'official_value', k);
    assert.match(x.note, /EPA lists both manual and automatic transmissions/);
  }
  assert.equal(checkedDecode(d, r).transmission.type, null);
  // EPA lists only the manual: the test vehicles fill it (control)
  r = checkDecode(d, {vin: ACCENT, evidence: evidence(ACCENT, [tvManual(1), tvManual(2)]), epa: epaOf([cfg({transmission: 'manual', speeds: 6})])});
  assert.equal(field(r, 'transmission').status, 'filled'); assert.equal(field(r, 'transmission').shown_value, 'manual');
  // the owner states the gearbox: used
  r = checkDecode(d, {vin: ACCENT, evidence: evidence(ACCENT, [tvManual(1), tvManual(2)]), epa: both, owner: {transmission: 'cvt'}});
  assert.equal(field(r, 'transmission').basis, 'owner'); assert.equal(field(r, 'transmission').status, 'filled'); assert.equal(field(r, 'transmission').shown_value, 'cvt');
  assert.equal(checkedDecode(d, r).transmission.type, 'Continuously Variable Transmission (CVT)');
});

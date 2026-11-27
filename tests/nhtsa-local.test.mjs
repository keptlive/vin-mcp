// Local NHTSA copies (lib/nhtsa-local.mjs) through the public lookups in lib/nhtsa.mjs: answers shaped like the live
// API's, no network when the local copy answers, the live API on a fallback reason, and the local copy again when
// the live API fails. Fixtures are built by the real importers (python3) from tiny flat files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getRecalls, getComplaints, getSafetyRatings, getRelatedModelRecalls } from '../lib/nhtsa.mjs';
import { closeNhtsaLocal, localDataFallbackReason, STALE_DAYS } from '../lib/nhtsa-local.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let dir, files;
const NOW = new Date('2026-11-27T12:00:00Z');
const noNet = async url => { throw new Error('network used: ' + url); };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const py = String.raw`
import importlib.util, json, sys, zipfile, pathlib
root, d = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
def load(n, f):
    s = importlib.util.spec_from_file_location(n, root / 'scripts' / f); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
def rcl(rec, camp, make, model, year, comp, rtype='V', rcdate='20241003', dnd='No', park='No', summary='Defect.'):
    r = [''] * 29
    r[0], r[1], r[2], r[3], r[4], r[6], r[7], r[10], r[14], r[15], r[16] = rec, camp, make, model, year, comp, 'Honda (American Honda Motor Co.)', rtype, 'Honda', rcdate, rcdate
    r[19], r[20], r[21], r[22], r[27], r[28] = summary, 'Crash risk.', 'Dealers will fix it.', 'Call NHTSA.', dnd, park
    return '\t'.join(r)
def cmpl(cid, odi, make, model, year, comp, text, ldate, faildate='20240105', crash='N', prod='V'):
    r = [''] * 51
    r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[16], r[19], r[45] = str(cid), str(odi), 'HONDA', make, model, year, crash, faildate, 'N', '0', '0', comp, ldate, text, prod
    return '\t'.join(r)
with zipfile.ZipFile(d / 'pre.zip', 'w') as z: z.writestr('FLAT_RCL_PRE_2010.txt', rcl('1', '04V001000', 'FORD', 'TAURUS', '2004', 'BRAKES', rcdate='20040105') + '\r\n')
with zipfile.ZipFile(d / 'post.zip', 'w') as z:
    z.writestr('FLAT_RCL_POST_2010.txt', '\r\n'.join([
        rcl('10', '24V508000', 'HONDA', 'CR-V', '2024', 'TIRES:MARKINGS', rcdate='20240702'),
        rcl('11', '24V744000', 'HONDA', 'CR-V', '2024', 'STEERING', dnd='Yes'),
        rcl('12', '24V744000', 'HONDA', 'CR-V', '2024', 'ELECTRICAL SYSTEM', dnd='Yes'),
        rcl('13', '24V763000', 'HONDA', 'CR-V HYBRID', '2024', 'ENGINE', rcdate='20241015'),
        rcl('14', '24V744000', 'HONDA', 'CR-V HYBRID', '2024', 'STEERING', dnd='Yes'),
        rcl('15', '24E001000', 'HONDA', 'CR-V', '2024', 'EQUIPMENT', rtype='E', rcdate='20240101'),
    ]) + '\r\n')
cc = load('cc', 'harvest-nhtsa-recall-campaigns.py')
cs = cc.open_state(d / 'campaigns.db')
def api_row(model, comp, date, ota):
    return {'NHTSACampaignNumber': '24V744000', 'Component': comp, 'ReportReceivedDate': date, 'overTheAirUpdate': ota, 'parkIt': True, 'parkOutSide': False,
            'Summary': 'Defect.', 'Consequence': 'Crash risk.', 'Remedy': 'Dealers will\r\nfix it.', 'Notes': 'Call NHTSA.', 'Make': 'HONDA', 'Model': model, 'ModelYear': '2024'}
h = cc.Harvester(cs, 0, 5, 'fixture', lambda m: None)
h._store('24V744000', 'x', cc.sheet({'results': [api_row('CR-V', 'ELECTRICAL SYSTEM', '04/10/2024', True), api_row('CR-V HYBRID', 'ELECTRICAL SYSTEM', '04/10/2024', True)]}), 1)
cs.close()
load('r', 'import-nhtsa-recalls.py').build(d / 'pre.zip', d / 'post.zip', d / 'nhtsa-recalls.db', 'Thu, 26 Nov 2026 08:04:00 GMT', campaign_sheets=d / 'campaigns.db')
with zipfile.ZipFile(d / 'cmpl.zip', 'w') as z:
    z.writestr('FLAT_CMPL.txt', '\r\n'.join([
        cmpl(1, 11000001, 'HONDA', 'CR-V', '2024', 'SERVICE BRAKES:DISC', 'BRAKES SQUEAL.', '20240110'),
        cmpl(2, 11000001, 'HONDA', 'CR-V', '2024', 'ENGINE', 'BRAKES SQUEAL.', '20240110'),
        cmpl(3, 11000003, 'HONDA', 'CR-V', '2024', 'AIR BAGS', 'AIR BAG LIGHT.', '20240110', faildate='', crash='Y'),
        cmpl(4, 11000002, 'HONDA', 'CR-V', '2024', 'STEERING:COLUMN', 'HEAVY STEERING.', '20240301'),
    ]) + '\r\n')
load('c', 'import-nhtsa-complaints.py').build(d / 'cmpl.zip', d / 'nhtsa-complaints.db', 'Thu, 26 Nov 2026 10:13:32 GMT')
h = load('h', 'harvest-nhtsa-ratings.py')
st = h.open_state(d / 'crawl.db')
def put(path, rows): st.execute("INSERT INTO responses(path,status,body,fetched_at,tries) VALUES(?, 'ok', ?, '2026-11-26T00:00:00Z', 1)", (path, json.dumps({'Count': len(rows), 'Results': rows})))
put(h.path_years(), [{'ModelYear': 2024}])
put(h.path_makes(2024), [{'Make': 'HONDA'}])
put(h.path_models(2024, 'HONDA'), [{'Model': 'CR-V'}, {'Model': 'PILOT'}])
put(h.path_variants(2024, 'HONDA', 'CR-V'), [{'VehicleDescription': '2024 Honda CR-V SUV AWD', 'VehicleId': 19599}, {'VehicleDescription': '2024 Honda CR-V SUV FWD', 'VehicleId': 19598}])
put(h.path_detail(19599), [{'VehicleDescription': '2024 Honda CR-V SUV AWD', 'OverallRating': '5', 'FrontCrashDriversideRating': '5', 'FrontCrashPassengersideRating': '4', 'SideCrashDriversideRating': '5', 'SideCrashPassengersideRating': '5', 'RolloverRating': '4', 'SidePoleCrashRating': '5'}])
put(h.path_detail(19598), [{'VehicleDescription': '2024 Honda CR-V SUV FWD', 'OverallRating': 'Not Rated'}])
put(h.path_variants(2024, 'HONDA', 'PILOT'), [{'VehicleDescription': '2024 Honda Pilot', 'VehicleId': 19000}])
st.execute("INSERT INTO responses(path,status,fetched_at,tries,error) VALUES(?, 'failed', '2026-11-26T00:00:00Z', 4, 'timed out')", (h.path_detail(19000),))
st.execute("INSERT INTO runs(run, started_at, finished_at) VALUES('r', '2026-11-26T00:00:00Z', '2026-11-26T05:00:00Z')")
st.commit()
load('g', 'import-nhtsa-ratings.py').build(d / 'crawl.db', d / 'nhtsa-ratings.db')
`;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'nhtsa-local-'));
  writeFileSync(join(dir, 'fixture.py'), py);
  const r = spawnSync('python3', ['-I', join(dir, 'fixture.py'), ROOT, dir], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  files = { recalls: join(dir, 'nhtsa-recalls.db'), complaints: join(dir, 'nhtsa-complaints.db'), ratings: join(dir, 'nhtsa-ratings.db') };
});
after(() => { closeNhtsaLocal(); rmSync(dir, { recursive: true, force: true }); });

test('recalls answer locally in the live shape, newest report first, without network', async () => {
  const r = await getRecalls('honda', 'cr-v', 2024, { file: files.recalls, fetch: noNet, now: NOW });
  assert.equal(r.available, true);
  assert.equal(r.count, 3);
  assert.deepEqual(r.recalls.map(c => c.campaign_number), ['24V744000', '24V508000', '24E001000']);
  const crawled = r.recalls[0];                                      // crawled campaign answer: the API's own values
  assert.equal(crawled.component, 'ELECTRICAL SYSTEM');               // the API's one component, not the file's first
  assert.deepEqual(crawled.components, ['STEERING', 'ELECTRICAL SYSTEM']);
  assert.equal(crawled.report_date, '04/10/2024');                    // the API's date (a day after the flat file's), day first
  assert.equal(crawled.report_received_date, '2024-10-04');
  assert.equal(crawled.remedy, 'Dealers will\r\nfix it.');             // the API's line break; same words as the flat file
  assert.equal(crawled.over_the_air_update, true);
  assert.equal(crawled.manufacturer, 'Honda (American Honda Motor Co.)');
  assert.equal(crawled.park_it, true);
  assert.equal(crawled.park_outside, false);
  const flatOnly = r.recalls[1];                                      // not crawled yet: the flat files' values
  assert.deepEqual([flatOnly.component, flatOnly.report_date, flatOnly.over_the_air_update, flatOnly.components], ['TIRES:MARKINGS', '02/07/2024', null, undefined]);
  const equipment = r.recalls[2];
  assert.equal(equipment.park_it, null);                             // the API carries no advisories on equipment campaigns
  assert.equal(r.scope, 'make_model_year');
  assert.equal(r.verification_url, 'https://www.nhtsa.gov/recalls');
  assert.equal(r.data_source.source, 'mcp_vin_nhtsa_local');
  assert.equal(r.data_source.fallback_reason, null);
  assert.equal(r.data_source.file_date, '2026-11-26T08:04:00+00:00');
  assert.equal(r.data_source.latest_report_date, '2024-10-15');
  const none = await getRecalls('HONDA', 'CR-V', 1999, { file: files.recalls, fetch: noNet, now: NOW });
  assert.deepEqual([none.available, none.count, none.data_source.source], [true, 0, 'mcp_vin_nhtsa_local']);
});

test('recalls: missing or stale copy asks the live API; a failed live call falls back to the stale copy', async () => {
  let calls = 0;
  const live = async url => { calls++; assert.match(String(url), /recallsByVehicle/); return json({ Count: 1, results: [{ NHTSACampaignNumber: '24V744000', Component: 'STEERING', ReportReceivedDate: '04/10/2024', overTheAirUpdate: false, parkIt: false, parkOutSide: false }] }); };
  const missing = await getRecalls('HONDA', 'CR-V', 2024, { file: join(dir, 'absent.db'), fetch: live, now: NOW });
  assert.equal(calls, 1);
  assert.deepEqual([missing.count, missing.data_source.source, missing.data_source.fallback_reason], [1, 'nhtsa_api', 'dataset_not_installed']);
  assert.equal(missing.recalls[0].over_the_air_update, false);
  const later = new Date(Date.parse('2026-11-26T08:04:00Z') + (STALE_DAYS.recalls + 1) * 86_400_000);
  const stale = await getRecalls('HONDA', 'CR-V', 2024, { file: files.recalls, fetch: live, now: later });
  assert.deepEqual([stale.data_source.source, stale.data_source.fallback_reason, stale.data_source.local_file_date], ['nhtsa_api', 'dataset_stale', '2026-11-26T08:04:00+00:00']);
  const down = await getRecalls('HONDA', 'CR-V', 2024, { file: files.recalls, fetch: async () => json({ message: 'busy' }, 503), now: later });
  assert.equal(down.count, 3);
  assert.deepEqual([down.data_source.source, down.data_source.fallback_reason, down.data_source.live_api], ['mcp_vin_nhtsa_local', 'dataset_stale', 'failed']);
  const nothing = await getRecalls('HONDA', 'CR-V', 2024, { file: join(dir, 'absent.db'), fetch: async () => json({}, 503), now: NOW });
  assert.deepEqual([nothing.available, nothing.count, nothing.error], [false, null, 'Recall lookup unavailable']);
  assert.equal(localDataFallbackReason('recalls', { available: true, info: { file_date: null } }, NOW), 'dataset_date_unknown');
});

test('related model names come from the local copy; the products API is not asked', async () => {
  const exact = await getRecalls('HONDA', 'CR-V', 2024, { file: files.recalls, fetch: noNet, now: NOW });
  const saved = globalThis.fetch;
  globalThis.fetch = noNet;
  try {
    const r = await getRelatedModelRecalls('HONDA', 'CR-V', 2024, exact.recalls, { labelIndex: () => { throw new Error('label index used'); }, local: { file: files.recalls, fetch: noNet, now: NOW } });
    assert.equal(r.available, true);
    assert.deepEqual(r.models.map(m => [m.nhtsa_model, m.match, m.recalls.map(c => c.campaign_number)]), [['CR-V HYBRID', 'longer_name', ['24V763000']]]);
    assert.equal(r.count, 1);
    assert.equal(r.flat_file_only, null);
    assert.equal(r.label_sources.products_api, 'not_asked');
    assert.equal(r.label_sources.flat_file_index.local_copy, true);
    assert.equal(r.decoded_name_in_recall_data, true);
  } finally { globalThis.fetch = saved; }
});

test('complaints answer locally: newest received first, top-level components of all products, null incident date', async () => {
  const r = await getComplaints('Honda', 'CR-V', '2024', { file: files.complaints, fetch: noNet, now: NOW });
  assert.equal(r.available, true);
  assert.equal(r.count, 3);
  assert.deepEqual(r.complaints.map(c => c.odi_number), [11000002, 11000001, 11000003]);
  assert.deepEqual(r.complaints[0], { odi_number: 11000002, date_of_incident: '01/05/2024', date_complaint_filed: '03/01/2024', component: 'STEERING', summary: 'HEAVY STEERING.', crash: false, fire: false, injuries: 0, deaths: 0 });
  assert.equal(r.complaints[1].component, 'SERVICE BRAKES,ENGINE');
  assert.equal(r.complaints[2].date_of_incident, null);
  assert.deepEqual(r.summary, { crashes: 1, fires: 0, injuries: 0, deaths: 0 });
  assert.equal(r.data_source.source, 'mcp_vin_nhtsa_local');
  assert.equal(r.data_source.latest_received_date, '2024-03-01');
  const none = await getComplaints('HONDA', 'PILOT', 2024, { file: files.complaints, fetch: noNet, now: NOW });
  assert.deepEqual([none.available, none.count], [true, 0]);
});

test('safety ratings answer locally in the API order; an uncrawled variant goes to the live API', async () => {
  const r = await getSafetyRatings('HONDA', 'cr-v', 2024, { file: files.ratings, fetch: noNet, now: NOW });
  assert.equal(r.rated, true);
  assert.deepEqual(r.variants.map(v => v.vehicle_id), [19599, 19598]);
  assert.deepEqual([r.overall, r.frontal_passenger, r.rollover, r.side_pole], [5, 4, 4, 5]);
  assert.equal(r.variants[1].overall, null);
  assert.equal(r.data_source.source, 'mcp_vin_nhtsa_local');
  assert.equal(r.data_source.file_date, '2026-11-26T05:00:00Z');
  for (const [make, model, year] of [['HONDA', 'ACCORD', 2024], ['ACME', 'X', 2024], ['HONDA', 'CR-V', 1980]]) {
    const n = await getSafetyRatings(make, model, year, { file: files.ratings, fetch: noNet, now: NOW });
    assert.deepEqual([n.rated, n.variants.length, n.data_source.source], [false, 0, 'mcp_vin_nhtsa_local'], `${make} ${model} ${year}`);
  }
  const urls = [];
  const live = async url => { urls.push(String(url)); return String(url).includes('/VehicleId/') ? json({ Results: [{ VehicleDescription: '2024 Honda Pilot', OverallRating: '5' }] }) : json({ Count: 1, Results: [{ VehicleId: 19000 }] }); };
  const pilot = await getSafetyRatings('HONDA', 'PILOT', 2024, { file: files.ratings, fetch: live, now: NOW });
  assert.deepEqual([pilot.rated, pilot.overall, pilot.data_source.source, pilot.data_source.fallback_reason], [true, 5, 'nhtsa_api', 'not_crawled']);
  assert.equal(urls.length, 2);
});

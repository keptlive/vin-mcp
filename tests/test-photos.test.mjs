import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {lookupTestVehicleData} from '../lib/tire-placards.mjs';
import {testDescription, photoLabel} from '../lib/test-photos.mjs';

const importer = fileURLToPath(new URL('../scripts/import-tire-placards.py', import.meta.url));
const report = n => `https://nrd-static.nhtsa.dot.gov/reports/vehdb/v10000/v10000/v${n}R001.pdf`;
const SUV = 'Sport Utility Vehicle (SUV)/Multi-Purpose Vehicle (MPV)';
const stem = (test, n) => `v${String(test).padStart(5, '0')}P${String(n).padStart(3, '0')}`;
const p = (test, n, phase, view) => ({stem: stem(test, n), phase, view, web: false,
  w960: {width: 960, height: 640, bytes: 50000}, w320: {width: 320, height: 213, bytes: 9000},
  nhtsa_url: `https://nrd-static.nhtsa.dot.gov/photos/vehdb/v10000/v10000/${stem(test, n)}.jpg`, original_file_name: `No. ${n}.jpg`});
const pre3 = t => [p(t, 5, 'pre', 'front_34_left'), p(t, 7, 'pre', 'side_left'), p(t, 2, 'pre', 'rear_34_left')];
const row = o => ({make: 'HONDA', model: 'CR-V', model_year: 2017, tested_as: '2017 Honda CR-V AWD LX', vpic_trim: 'LX', body_class: SUV,
  drive_type: 'AWD/All-Wheel Drive', fuel_type: 'Gasoline', powertrain: 'not_battery_electric', report_url: report(o.test_no), test_type: 'NCAP',
  test_kind: 'side', struck_side: 'left', closing_speed_kmh: 61.9, vpic_extra: {doors: 4}, ...o});
const vin = o => ({make: 'HONDA', model: 'CR-V', year: 2017, trim: null, body_class: SUV, drive_type: 'AWD', fuelType: 'Gasoline', evType: null, doors: 4, cab: null, ...o});
const tc = (byYear = {}) => async ({year}) => ({available: true, data: (byYear[year] || []).map(v => ({Specs: [{Name: 'WB', Value: String(v)}]}))});

/** An index with photo rows (the real import script) and a photo folder holding every listed file. */
function build(rows, {files = true} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'photos-')), file = join(dir, 'tire-placards.db'), folder = join(dir, 'nhtsa-photos');
  writeFileSync(join(dir, 'p.jsonl'), JSON.stringify({make: 'FORD', model: 'F-150', model_year: 2021, tested_as: '2021 Ford F-150', tires: {front: '275/60R20 115T', rear: '275/60R20 115T'},
    powertrain: 'not_battery_electric', cold_pressure_kpa: {front: 240, rear: 240}, cold_pressure_psi: {front: 35, rear: 35}, test_no: 11490,
    report_url: report(11490), confidence: 'normal', other_reports: []}) + '\n');
  writeFileSync(join(dir, 'photos.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  if (files) for (const r of rows) {
    mkdirSync(join(folder, String(r.test_no)), {recursive: true});
    for (const x of r.photos) for (const w of [960, 320]) writeFileSync(join(folder, String(r.test_no), `${x.stem}-${w}.webp`), 'RIFF');
  }
  const code = `import importlib.util,sys;s=importlib.util.spec_from_file_location('i',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.build(sys.argv[2],sys.argv[3],None,None,None,sys.argv[4],None,sys.argv[5])`;
  const run = spawnSync('python3', ['-c', code, importer, join(dir, 'p.jsonl'), file, join(dir, 'photos.jsonl'), folder], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
  return {dir, file, folder};
}
const lookup = async (v, idx, o = {}) => (await lookupTestVehicleData(v, {file: idx.file, photosDir: idx.folder, dims: tc(), ...o})).photos;
const brief = photos => photos.items.map(i => [i.test_no, i.phase, i.view]);

const FAMILY = [
  row({test_no: 10060, photos: [...pre3(10060), p(10060, 8, 'post', 'side_left')]}),
  row({test_no: 10061, test_kind: 'frontal', struck_side: null, closing_speed_kmh: 56.3, photos: [p(10061, 13, 'pre', 'front_34_right'), p(10061, 14, 'post', 'front_34_right')]}),
  row({test_no: 10062, test_kind: 'pole', closing_speed_kmh: 32.1, photos: [p(10062, 8, 'post', 'side_left')]}),  // no photo before the test
  row({test_no: 10063, test_kind: 'side', vpic_trim: 'EX', photos: [p(10063, 8, 'post', 'side_left')]}),  // a second side test: one per kind
  row({test_no: 9001, model_year: 2016, tested_as: '2016 Honda CR-V AWD LX', test_kind: 'frontal', photos: [p(9001, 13, 'pre', 'front_34_right'), p(9001, 14, 'post', 'front_34_right')]}),
];

test('the test car before the test first, then one crash view per test kind of that model year', async () => {
  const idx = build(FAMILY);
  try {
    const photos = await lookup(vin(), idx);
    assert.equal(photos.scope, 'nhtsa_test_vehicle'); assert.equal(photos.vin_specific, false);
    assert.match(photos.note, /Not this vehicle/);
    assert.deepEqual(brief(photos), [
      [10060, 'pre_test', 'front_34_left'], [10060, 'pre_test', 'side_left'], [10060, 'pre_test', 'rear_34_left'],
      [10061, 'post_test', 'front_34_right'], [10060, 'post_test', 'side_left'], [10062, 'post_test', 'side_left'],
    ]);
    const [first, , , frontal, side, pole] = photos.items;
    assert.match(first.url, /\/nhtsa-photos\/10060\/v10060P005-960\.webp$/); assert.match(first.thumbnail_url, /\/nhtsa-photos\/10060\/v10060P005-320\.webp$/);
    assert.equal(first.width, 960); assert.equal(first.thumbnail_height, 213);
    assert.equal(first.label, 'Before the test: left front three-quarter view');
    assert.equal(first.tested_as, '2017 Honda CR-V AWD LX'); assert.equal(first.test_label, 'NHTSA side barrier crash test 10060');
    assert.equal(first.nhtsa_test_url, report(10060)); assert.equal(first.match.kind, 'exact');
    assert.match(first.nhtsa_photo_url, /^https:\/\/nrd-static\.nhtsa\.dot\.gov\/photos\/vehdb\//);
    assert.equal(frontal.label, 'After NHTSA\'s frontal crash test: right front three-quarter view');
    assert.equal(frontal.test_description, 'The car was driven into a rigid barrier at 56 km/h (35 mph).');
    assert.equal(side.test_description, 'A moving barrier was driven into the car\'s left side at 62 km/h (38 mph).');
    assert.equal(pole.test_description, 'The car was moved sideways into a rigid pole at 32 km/h (20 mph), left side first.');
    // the 2016 test is not used for a 2017 VIN when 2017 was tested
    assert.ok(!photos.items.some(i => i.test_no === 9001));
  } finally { rmSync(idx.dir, {recursive: true, force: true}); }
});

test('never another body style, door count or cab; another year only of the same generation', async () => {
  const idx = build(FAMILY);
  try {
    assert.equal(await lookup(vin({body_class: 'Sedan/Saloon'}), idx), null);
    assert.equal(await lookup(vin({doors: 2}), idx), null);
    assert.equal(await lookup(vin({fuelType: 'Electric', evType: 'BEV (Battery Electric Vehicle)'}), idx), null, 'powertrain guard');
    assert.equal(await lookup(vin({model: 'HR-V'}), idx), null);
    // 2018 VIN: the 2017 tests only when Transport Canada lists the same wheelbase for both years
    const same = await lookup(vin({year: 2018}), idx, {dims: tc({2018: [266], 2017: [266], 2016: [262]})});
    assert.equal(same.items[0].test_no, 10060); assert.equal(same.items[0].match.kind, 'nearest_model_year');
    assert.equal(same.items[0].match.generation_check, 'same_wheelbase');
    assert.equal(await lookup(vin({year: 2018}), idx, {dims: tc()}), null, 'generation unknown');
    assert.equal(await lookup(vin({year: 2018}), idx, {dims: tc({2018: [270], 2017: [266]})}), null, 'another wheelbase');
    assert.equal(await lookup(vin({year: 2020}), idx), null, 'out of reach');
  } finally { rmSync(idx.dir, {recursive: true, force: true}); }
});

test('a closer tier with another shape or an unknown generation falls through to the next tier', async () => {
  const idx = build([
    row({test_no: 11001, model_year: 2018, tested_as: '2018 Honda CR-V EX', vpic_trim: 'EX', photos: pre3(11001)}),
    row({test_no: 11002, model_year: 2017, tested_as: '2017 Honda CR-V LX', vpic_trim: 'LX', photos: pre3(11002)}),
    row({test_no: 11003, model_year: 2017, tested_as: '2017 Honda CR-V EX 2-door', vpic_trim: 'EX', vpic_extra: {doors: 2}, photos: pre3(11003)}),
  ]);
  try {
    // VIN 2017 EX: the 2-door EX has the same trim but another door count; the 2018 EX's generation is unknown
    const photos = await lookup(vin({trim: 'EX'}), idx);
    assert.deepEqual([...new Set(photos.items.map(i => i.test_no))], [11002]);
    assert.equal(photos.items[0].match.kind, 'different_variant');
    assert.deepEqual(photos.items[0].match.differences.map(d => d.field), ['trim']);
    assert.equal(photos.items.length, 3, 'no crash views when none of that year has a view after the test');
  } finally { rmSync(idx.dir, {recursive: true, force: true}); }
});

test('no photo folder, or only crash views: photos is null', async () => {
  const idx = build(FAMILY);
  try {
    assert.equal(await lookup(vin(), {...idx, folder: join(idx.dir, 'missing')}), null);
  } finally { rmSync(idx.dir, {recursive: true, force: true}); }
  const crashOnly = build([row({test_no: 10062, test_kind: 'pole', photos: [p(10062, 8, 'post', 'side_left')]})]);
  try {
    assert.equal(await lookup(vin(), crashOnly), null);
  } finally { rmSync(crashOnly.dir, {recursive: true, force: true}); }
});

test('labels and test descriptions never guess', () => {
  assert.equal(testDescription({test_kind: 'side', struck_side: null, closing_speed_kmh: null}), 'A moving barrier was driven into the car\'s side.');
  assert.equal(testDescription({test_kind: 'rear', closing_speed_kmh: 80}), 'A moving barrier was driven into the car\'s rear at 80 km/h (50 mph).');
  assert.equal(testDescription({test_kind: null}), null);
  assert.equal(photoLabel({phase: 'pre', view: 'as_delivered'}, {}), 'Before the test: as delivered to the test lab');
  assert.equal(photoLabel({phase: 'post', view: 'rear_34_left'}, {test_kind: 'rear'}), 'After NHTSA\'s rear impact test: left rear three-quarter view');
});

// ---- the page script (public/test-photos.js) with a small DOM adapter ----
function page() {
  const make = () => ({hidden: false, innerHTML: '', attrs: {}, classes: new Set(), listeners: [],
    classList: {add(k) { this.o.classes.add(k); }, remove(k) { this.o.classes.delete(k); }, toggle(k, on) { on ? this.o.classes.add(k) : this.o.classes.delete(k); }},
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; this[k] = undefined; }});
  const el = () => { const e = make(); e.classList.o = e; return e; };
  const head = el(), box = el(), main = el(), caption = el(), thumbs = el();
  box.closest = () => head;
  box.querySelector = s => ({'.photo-main': main, '.photo-caption': caption, '.photo-thumbs': thumbs})[s];
  box.querySelectorAll = () => [];
  thumbs.querySelectorAll = () => [];
  const window = {};
  const context = {window, document: {getElementById: id => id === 'hero-photos' ? box : null}, location: {origin: 'https://mcp.vin'}, URL};
  vm.runInNewContext(readFileSync(new URL('../public/test-photos.js', import.meta.url), 'utf8'), context);
  return {TestPhotos: window.TestPhotos, head, box, main, caption};
}
const item = o => ({url: 'https://mcp.vin/nhtsa-photos/10060/v10060P005-960.webp', thumbnail_url: 'https://mcp.vin/nhtsa-photos/10060/v10060P005-320.webp',
  width: 960, height: 640, thumbnail_width: 320, thumbnail_height: 213, phase: 'pre_test', view: 'front_34_left', label: 'Before the test: left front three-quarter view',
  tested_as: '2017 Honda CR-V AWD LX', test_no: 10060, test_label: 'NHTSA side barrier crash test 10060', test_description: 'A moving barrier was driven into the car\'s left side.',
  match: {kind: 'exact'}, nhtsa_test_url: report(10060), ...o});

test('page: only this site\'s photo files are shown, each caption names the test car and says it is not this vehicle', () => {
  const {TestPhotos} = page();
  const good = item();
  const list = TestPhotos.items({photos: {items: [good,
    item({url: 'https://cdn.imagin.studio/getImage?make=honda'}),
    item({url: 'https://evil.example/nhtsa-photos/10060/v10060P005-960.webp'}),
    item({thumbnail_url: '/nhtsa-photos/10060/v10060P005-320.jpg'}),
    item({url: 'https://mcp.vin/nhtsa-photos/10060/v10060P005-960.webp?x=1'}),
    item({tested_as: ''}), item({test_no: '10060'}), item({width: 0}),
    item({url: '/nhtsa-photos/14432/v14432N007-960.webp', thumbnail_url: '/nhtsa-photos/14432/v14432N007-320.webp'}),
  ]}});
  assert.equal(list.length, 2);
  assert.equal(TestPhotos.items({photos: null}).length, 0);
  const cap = TestPhotos.caption(good);
  assert.match(cap, /NHTSA's test car: 2017 Honda CR-V AWD LX\./); assert.match(cap, /Not this vehicle; trim, colour and equipment may differ\./);
  assert.match(cap, /<a href="https:\/\/nrd-static\.nhtsa\.dot\.gov\/reports\/vehdb\/[^"]+" target="_blank" rel="noopener">NHTSA side barrier crash test 10060<\/a>/);
  assert.doesNotMatch(cap, /moving barrier/, 'the test is described on crash views only');
  const crash = TestPhotos.caption(item({phase: 'post_test', label: 'After NHTSA\'s side barrier crash test: left side', match: {kind: 'nearest_model_year', tested_model_year: 2017, vin_model_year: 2018}}));
  assert.match(crash, /A moving barrier was driven/); assert.match(crash, /NHTSA tested the 2017 model \(yours is 2018\)/);
  const hostile = TestPhotos.caption(item({tested_as: '<img src=x onerror=alert(1)>', nhtsa_test_url: 'javascript:alert(1)'}));
  assert.doesNotMatch(hostile, /<img/); assert.doesNotMatch(hostile, /javascript:/);
});

test('page: no photos means no photo area; a report with photos shows the first one', () => {
  const {TestPhotos, head, box, main, caption} = page();
  TestPhotos.render({photos: null});
  assert.equal(box.hidden, true); assert.ok(head.classes.has('no-photos'));
  TestPhotos.render({photos: {items: [item({phase: 'post_test'})]}});
  assert.equal(box.hidden, true, 'a crash view alone is not shown');
  TestPhotos.render({photos: {items: [item()]}});
  assert.equal(box.hidden, false); assert.ok(!head.classes.has('no-photos'));
  assert.equal(main.src, 'https://mcp.vin/nhtsa-photos/10060/v10060P005-960.webp');
  assert.match(main.alt, /NHTSA's test car: 2017 Honda CR-V AWD LX/);
  assert.match(caption.innerHTML, /Before the test: left front three-quarter view/);
});

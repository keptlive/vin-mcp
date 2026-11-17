import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

// Load the browser scripts as the page does (qr.js, then car-sheet.js) into one context.
function load(extra = {}) {
  const ctx = {console, URLSearchParams, setTimeout, ...extra};
  vm.createContext(ctx);
  for (const file of ['qr.js', 'car-sheet.js']) vm.runInContext(readFileSync(new URL('../public/' + file, import.meta.url), 'utf8'), ctx);
  return {ctx, sheet: vm.runInContext('CarSheet', ctx), qr: vm.runInContext('VinQr', ctx)};
}

const base = () => ({
  valid: true, vin: '1G1FW6S06H4188545',
  validation: {checksum: {valid: true, expected: '6', actual: '6'}, wmi: {manufacturer: 'Chevrolet', country: 'United States'}},
  vehicle: {year: 2017, make: 'CHEVROLET', model: 'Bolt EV', trim: 'LT', body_class: 'Hatchback/Liftback/Notchback', doors: 4, vehicle_type: 'PASSENGER CAR'},
  engine: {hp: 200, fuel_type: 'Electric', ev_type: 'BEV (Battery Electric Vehicle)'},
  transmission: {}, dimensions: {gvwr: 'Class 1: 6,000 lb or less (2,722 kg or less)', curb_weight: 3580, wheel_base: 102.4},
  plant: {city: 'LANSING - GRAND RIVER', state: 'MICHIGAN', country: 'UNITED STATES (USA)'},
  safety_equipment: {tpms: 'Direct'},
  raw_nhtsa: {Manufacturer: 'GENERAL MOTORS LLC', Seats: '5', SeatRows: '2', WheelSizeFront: '17', WheelSizeRear: '17'},
  recalls: {available: true, count: 4, recalls: [], related_models: {available: true, count: 0}},
  complaints: {available: true, count: 47, complaints: []},
  safety_ratings: {rated: false},
  fuel_economy: {available: false, reason: 'no_matching_variant'},
  provenance: {assembled_at: '2026-11-16T22:42:11.046Z'},
  recall_status: {available: true, open_count: 0, completed_count: 6, unknown_count: 0, service_campaign_count: 2, verification_url: 'https://experience.gm.com/ownercenter/recalls?vin=1G1FW6S06H4188545', source: {provider: 'GM Recall and Warranty Center', retrieved_at: '2026-11-16T22:42:12Z'}},
});
const text = html => html.replace(/<wbr>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the sheet shows public facts and leaves unknown values out, never zero', () => {
  const {sheet} = load();
  const r = base();
  const out = text(sheet.html(r).body);
  assert.match(out, /Make Chevrolet/);
  assert.match(out, /Body Hatchback\/Liftback\/Notchback/);
  assert.match(out, /Seats 5 in 2 rows/);
  assert.match(out, /Assembly plant Lansing - Grand River, Michigan, United States \(USA\)/);
  assert.match(out, /Motor 200 hp/);
  assert.match(out, /Wheel diameter 17 in/);
  assert.match(out, /Pressure monitor \(TPMS\) Direct/);
  assert.match(out, /Manufacturer General Motors LLC/);
  // Missing and zero source values: no row at all.
  const sparse = {...base(), vehicle: {...r.vehicle, doors: null, trim: ''}, dimensions: {curb_weight: 0, wheel_base: null}, raw_nhtsa: {}, safety_equipment: {}};
  const s = text(sheet.html(sparse).body);
  for (const label of ['Doors', 'Trim', 'Curb weight', 'Wheelbase', 'Wheel diameter', 'Seats', 'Pressure monitor']) assert.doesNotMatch(s, new RegExp(label + ' '), label);
  // Unavailable lookups are "Unknown", not zero.
  const down = {...base(), recalls: {available: false, count: null}, complaints: {available: false, count: null}, recall_status: {available: false, reason: 'upstream_unavailable'}};
  const d = text(sheet.html(down).body);
  assert.equal((d.match(/Unknown \(lookup unavailable\)/g) || []).length, 2);
  assert.match(d, /This VIN’s recall status Unknown\. Not available for this vehicle here\./);
  assert.doesNotMatch(d, /\b0 open\b|\b0 for the\b|\b0 for this model year\b/);
});

test('tire pressures, sizes and manual facts are labelled write-in spaces, never filled from data', () => {
  const {sheet} = load();
  const body = sheet.html(base()).body;
  for (const label of ['Tire size, front', 'Tire size, rear', 'Cold pressure, front', 'Cold pressure, rear', 'Spare', 'Fuse box locations', 'Wiper blade sizes', '12-volt battery'])
    assert.match(body, new RegExp(`<label class="write-in"><span class="write-label">${label}</span><span class="write-field"><input type="text" autocomplete="off" spellcheck="false">`), label);
  assert.doesNotMatch(body, /<input[^>]*value=/);
  assert.match(text(body), /Tire and Loading Information placard, normally on the driver’s door pillar \(FMVSS No\. 110\)\. No public source lists them per vehicle/);
  // An electric car has no engine oil line; a gasoline car does.
  assert.doesNotMatch(body, /Engine oil/);
  assert.match(sheet.html({...base(), engine: {fuel_type: 'Gasoline', cylinders: 6, displacement_l: 3}}).body, /Engine oil grade and capacity/);
});

test('owner’s manual links go only to the maker’s official library', () => {
  const {sheet} = load();
  const link = make => sheet.manualFor({vehicle: {make, model: 'X', year: 2015}});
  assert.equal(link('CHEVROLET').url, 'https://www.chevrolet.com/support/vehicle/manuals-guides');
  assert.equal(link('HONDA').url, 'https://mygarage.honda.com/s/manuals-search?brand=honda');
  assert.match(link('FORD').url, /^https:\/\/www\.ford\.com\//);
  assert.equal(sheet.manualFor({vehicle: {make: 'TESLA', model: 'Model S', year: 2013}}).url, 'https://www.tesla.com/ownersmanual/2012_2020_models/en_us/');
  assert.equal(sheet.manualFor({vehicle: {make: 'TESLA', model: 'Model S', year: 2022}}).url, 'https://www.tesla.com/ownersmanual/models/en_us/');
  assert.equal(sheet.manualFor({vehicle: {make: 'TESLA', model: 'Model 3', year: 2022}}), null);
  assert.equal(link('SUBARU'), null);
  const out = text(sheet.html({...base(), vehicle: {...base().vehicle, make: 'SUBARU'}}).body);
  assert.match(out, /No official online manual library is listed here for Subaru/);
  assert.match(sheet.html(base()).body, /<a href="https:\/\/www\.chevrolet\.com\/support\/vehicle\/manuals-guides" target="_blank" rel="noopener">Chevrolet owner’s manuals<\/a>/);
});

test('VIN recall status names its maker source; model-year campaigns are not repair status', () => {
  const {sheet} = load();
  const out = text(sheet.html(base()).body);
  assert.match(out, /0 open · 6 completed or closed · 2 other maker programs Reported by GM Recall and Warranty Center, checked 16 Nov 2026, 22:42 UTC\./);
  assert.match(out, /Model-year recall campaigns 4 for the 2017 Chevrolet Bolt EV NHTSA campaigns for the make, model and year\. Not this car’s repair status\./);
  assert.match(out, /Owner complaints to NHTSA 47 for this model year Reports, not confirmed defects\./);
  // Open recalls are emphasized; an active-only source does not claim completed history.
  const ford = sheet.html({...base(), recall_status: {available: true, open_count: 2, completed_count: 1, service_campaign_count: 1, source: {provider: 'Ford Owner Support VIN Recalls', retrieved_at: '2026-11-16T22:42:00Z'}}}).body;
  assert.match(ford, /<span class="sheet-alert">2 open · 1 completed or closed · 1 other maker program<\/span>/);
  const honda = text(sheet.html({...base(), recall_status: {available: true, open_count: 0, completed_count: null, coverage: {completed_history: false}, source: {provider: 'Honda MyGarage VIN Recall Search'}}}).body);
  assert.match(honda, /0 open · completed history not supplied by this source Reported by Honda MyGarage VIN Recall Search\./);
  const mopar = text(sheet.html({...base(), recall_status: {available: true, open_count: null, open_record_count: 1, completed_count: null, source: {provider: 'Mopar fleet lookup'}}}).body);
  assert.match(mopar, /1 open recall or campaign records · unknown completed or closed/);
  const toyota = text(sheet.html({...base(), recall_status: {available: false, reason: 'interactive_verification_required', verification_url: 'https://www.toyota.com/recall/'}}).body);
  assert.match(toyota, /Unknown\. The maker’s check needs a person to verify\. Check this VIN with the official source www\.toyota\.com /);
  const related = text(sheet.html({...base(), recalls: {available: true, count: 3, recalls: [], related_models: {available: true, count: 2}}}).body);
  assert.match(related, /3 for the 2017 Chevrolet Bolt EV \(plus 2 filed under related model names; they may not apply\)/);
});

test('values from upstream sources are escaped', () => {
  const {sheet} = load();
  const out = sheet.html({...base(), vehicle: {...base().vehicle, trim: '<img src=x onerror=alert(1)>'}, recall_status: {available: true, open_count: 1, source: {provider: '<script>x</script>'}}});
  assert.doesNotMatch(out.body + out.foot, /<img src=x|<script>/);
  assert.match(out.body, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('Transport Canada variants: one value when they agree, a range when not, zero as missing', () => {
  const {sheet} = load();
  const variant = (name, ol, wb, cw) => ({Specs: [{Name: 'Model', Value: name}, {Name: 'OL', Value: String(ol)}, {Name: 'OW', Value: '177'}, {Name: 'OH', Value: '0'}, {Name: 'WB', Value: String(wb)}, {Name: 'CW', Value: String(cw)}]});
  const one = sheet.dimensionSummary([variant('BOLT 4DR HATCHBACK', 417, 260, 1625)]);
  assert.equal(one.length, '164.2 in (417 cm)');
  assert.equal(one.height, null);
  assert.equal(one.curb, '3,583 lb (1,625 kg)');
  const two = sheet.dimensionSummary([variant('A', 477, 267, 1365), variant('B', 481, 274, 1504)]);
  assert.equal(two.length, '187.8–189.4 in (477–481 cm)');
  assert.equal(two.width, '69.7 in (177 cm)');
  assert.equal(sheet.dimensionSummary([]), null);
  const html = text(sheet.dimensionsHtml(two, base()));
  assert.match(html, /Length 187\.8–189\.4 in/);
  assert.doesNotMatch(html, /Height|Wheelbase|Curb weight/); // height is missing; vPIC already gives wheelbase and weight
  assert.match(html, /Transport Canada model data, 2 records \(A; B\)\. Not specific to this VIN\./);
});

test('the QR code matches the reference encoding and is labelled', () => {
  const {qr} = load();
  // Verified against python-qrcode 8.2 (all eight masks) and decoded with zxing-cpp 3.1.1.
  const expected = ['1fc2327f', '10490c41', '1759545d', '175f1f5d', '1753e25d', '1050f941', '1fd5557f', '0012a500', '17c86e7c', '070a3171', '0f730d00', '038c52ea', '08d20c0c', '12b9e1d1', '1af1eddc', '152c8312', '0bdd702c', '149805f5', '155d3464', '112370d2', '17ce3ff7', '0015c11f', '1fc5f55c', '105a8710', '175a7df6', '175f828f', '175e64fe', '104ab77a', '1fd9fc64'];
  const m = qr.matrix('https://mcp.vin/1HGCM82633A004352');
  assert.deepEqual(Array.from(m, row => parseInt(row.map(Number).join(''), 2).toString(16).padStart(8, '0')), expected);
  const svg = qr.svg('https://mcp.vin/1HGCM82633A004352', 'QR code linking to https://mcp.vin/1HGCM82633A004352');
  assert.match(svg, /^<svg class="qr-code" viewBox="0 0 37 37" role="img" aria-label="QR code linking to https:\/\/mcp\.vin\/1HGCM82633A004352"/);
  assert.throws(() => qr.matrix('x'.repeat(200)), /too long/);
});

test('render fills the sheet, retries a multi-word model name once, and ignores stale replies', async () => {
  const nodes = new Map(), requests = [];
  const node = () => ({innerHTML: '', textContent: ''});
  const document = {querySelector: s => { if (s === '#sheet-body [data-dims]') return nodes.get('#sheet-body').innerHTML.includes('data-dims') ? (nodes.get('dims') || nodes.set('dims', node()).get('dims')) : null; if (!nodes.has(s)) nodes.set(s, node()); return nodes.get(s); }};
  const replies = [];
  const fetch = url => { requests.push(url); return new Promise(resolve => replies.push(resolve)); };
  const ok = data => ({ok: true, json: async () => ({available: true, data})});
  const {sheet} = load({document, fetch});
  const r = base();
  sheet.render(r);
  assert.equal(nodes.get('#vehicle-title').textContent, '2017 Chevrolet Bolt EV LT');
  assert.match(nodes.get('#sheet-prepared').textContent, /^Data gathered 16 Nov 2026, 22:42 UTC/);
  assert.match(nodes.get('#sheet-foot').innerHTML, /Live report: <a href="https:\/\/mcp\.vin\/1G1FW6S06H4188545">/);
  assert.match(nodes.get('#sheet-foot').innerHTML, /<svg class="qr-code"/);
  assert.match(requests[0], /^\/api\/research\/dimensions\?year=2017&make=CHEVROLET&model=Bolt\+EV$/);
  replies.shift()(ok([]));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(requests[1], /model=Bolt$/);
  replies.shift()(ok([{Specs: [{Name: 'Model', Value: 'BOLT 4DR HATCHBACK'}, {Name: 'OL', Value: '417'}]}]));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(nodes.get('dims').innerHTML, /164\.2 in/);
  assert.equal(requests.length, 2);
  // A reply for an older report never overwrites the current one.
  nodes.get('dims').innerHTML = 'current';
  sheet.render({...base(), vin: '1HGCM82633A004352', vehicle: {...base().vehicle, model: 'Accord'}});
  const stale = replies.shift();
  sheet.render(base());
  nodes.get('dims').innerHTML = 'newest';
  stale(ok([{Specs: [{Name: 'Model', Value: 'ACCORD'}, {Name: 'OL', Value: '477'}]}]));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(nodes.get('dims').innerHTML, 'newest');
});

test('the page loads the sheet before the app and prints it on its own page', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const order = ['/qr.js', '/car-sheet.js', '/app.js'].map(f => html.indexOf('<script src="' + f));
  assert.ok(order.every(i => i > 0) && order[0] < order[1] && order[1] < order[2], 'script order');
  assert.match(html, /<article id="car-sheet" class="car-sheet" aria-labelledby="vehicle-title">/);
  assert.match(html, /<button type="button" id="print-sheet">Print this sheet<\/button>/);
  assert.match(css, /html\.print-sheet-only #results>:not\(#car-sheet\)/);
  assert.match(css, /\.car-sheet\{[^}]*break-after:page/);
  // No new outside resources: the sheet CSS and scripts reference no other hosts.
  for (const file of ['car-sheet.js', 'qr.js']) assert.doesNotMatch(readFileSync(new URL('../public/' + file, import.meta.url), 'utf8'), /<script|<link|@import|fetch\(['"`]https?:/);
});

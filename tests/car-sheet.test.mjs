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
  // The link block (lib/recall-links.mjs): mcp.vin does not check this VIN's recall repairs.
  recall_status: {vin: '1G1FW6S06H4188545', available: false, reason: 'manufacturer_link_only', checked_by_mcp_vin: false, maker: 'GM',
    manufacturer_lookup_url: 'https://experience.gm.com/ownercenter/recalls', manufacturer_page_url: 'https://experience.gm.com/ownercenter/recalls', vin_prefilled: false,
    nhtsa_lookup_url: 'https://www.nhtsa.gov/recalls?vin=1G1FW6S06H4188545', nhtsa_vin_prefilled: null, open_count: null, completed_count: null, recalls: []},
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
  assert.match(d, /This VIN’s recall repairs Not checked by mcp\.vin\. Check on NHTSA/);
  assert.doesNotMatch(d, /\b0 open\b|\b0 for the\b|\b0 for this model year\b/);
});

test('tire pressures, sizes and manual facts are labelled write-in spaces, never filled from data', () => {
  const {sheet} = load();
  const body = sheet.html(base()).body;
  for (const label of ['Tire size, front', 'Tire size, rear', 'Cold pressure, front', 'Cold pressure, rear', 'Spare', 'Fuse box locations', 'Wiper blade sizes', '12-volt battery'])
    assert.match(body, new RegExp(`<label class="write-in"><span class="write-label">${label}</span><span class="write-field"><input type="text" autocomplete="off" spellcheck="false">`), label);
  assert.doesNotMatch(body, /<input[^>]*value=/);
  // No placard index in the report: nothing is shown and the sheet says it was not checked.
  assert.match(text(body), /Tire and Loading Information placard, normally on the driver’s door pillar \(FMVSS No\. 110\)\. NHTSA’s test-vehicle index was not checked for this report, so mcp\.vin shows no values\./);
  assert.doesNotMatch(body, /NHTSA test vehicle/);
  // An electric car has no engine oil line; a gasoline car does.
  assert.doesNotMatch(body, /Engine oil/);
  assert.match(sheet.html({...base(), engine: {fuel_type: 'Gasoline', cylinders: 6, displacement_l: 3}}).body, /Engine oil grade and capacity/);
});

const tested = (o = {}) => ({model_year: 2017, make: 'CHEVROLET', model: 'Bolt EV', tested_as: '2017 Chevrolet Bolt EV LT 5-Door Hatchback',
  tires: {front: '215/50R17 91H', rear: '215/50R17 91H'}, cold_pressure_psi: {front: 38, rear: 38}, cold_pressure_kpa: {front: 260, rear: 260},
  report_url: 'https://nrd-static.nhtsa.dot.gov/reports/vehdb/v10000/v10000/v10000R001.pdf', test_no: 10000, confidence: 'high', other_reports: [], ...o});
const placard = vehicles => ({available: true, scope: 'nhtsa_test_vehicle', vin_specific: false, vehicles, note: 'fixture'});

test('NHTSA test-vehicle placard values show above the blanks, labelled, linked, and never fill the blanks', () => {
  const {sheet} = load();
  const body = sheet.html({...base(), tire_placard: placard([tested()])}).body;
  const out = text(body);
  assert.match(out, /NHTSA test vehicle: 2017 Chevrolet Bolt EV LT 5-Door Hatchback Same model year\. Tires 215\/50R17 91H front and rear Cold 38 psi front and rear \(260 kPa\) NHTSA test report 10000/);
  assert.match(out, /Your own door placard governs \(driver’s door pillar\) ?; it can differ by trim and tire size ?\./); // the trim clause is screen only
  assert.match(body, /<a href="https:\/\/nrd-static\.nhtsa\.dot\.gov\/reports\/vehdb\/v10000\/v10000\/v10000R001\.pdf" target="_blank" rel="noopener">NHTSA test report 10000<\/a>/);
  // The values sit above the write-in blanks, which stay empty.
  assert.ok(body.indexOf('NHTSA test vehicle') < body.indexOf('Copy from the tire placard'));
  assert.doesNotMatch(body, /<input[^>]*value=/);
  assert.match(out, /Copy your car’s own values from its Tire and Loading Information placard/);
  // On paper the two placard notes are one: the copy note is screen-only when tested values are shown.
  assert.match(body, /<p class="sheet-note sheet-screen-only">Copy your car’s own values/);
  assert.match(sheet.html({...base(), tire_placard: placard([tested()])}).foot, /NHTSA test reports \(test-vehicle tire placard\)/);
  // Front and rear differ: both printed; several tested variants: all listed.
  const two = text(sheet.html({...base(), tire_placard: placard([
    tested({tires: {front: 'P245/40ZR20 95Y', rear: 'P275/35ZR20 97Y'}, cold_pressure_psi: {front: 32, rear: 39}, cold_pressure_kpa: {front: 220, rear: 270}}),
    tested({tested_as: '2017 Chevrolet Bolt EV Premier', test_no: 10001})])}).body);
  assert.match(two, /Tires P245\/40ZR20 95Y front, P275\/35ZR20 97Y rear Cold 32 psi front \(220 kPa\), 39 psi rear \(270 kPa\)/);
  assert.match(two, /NHTSA test vehicle: 2017 Chevrolet Bolt EV Premier/);
});

test('no placard value without an exact indexed match, a complete value and an NHTSA report link', () => {
  const {sheet} = load();
  const none = text(sheet.html({...base(), tire_placard: {available: true, scope: 'nhtsa_test_vehicle', vin_specific: false, vehicles: [], reason: 'no_close_match', max_year_gap: 2}}).body);
  assert.doesNotMatch(none, /NHTSA test vehicle|Your own door placard governs/);
  assert.match(none, /none of this make and model within 2 model years is indexed \(not tested, or not indexed yet\), so mcp\.vin shows no values/);
  assert.doesNotMatch(none, /\b0 psi\b/);
  const other = text(sheet.html({...base(), tire_placard: {available: true, scope: 'nhtsa_test_vehicle', vin_specific: false, vehicles: [], reason: 'other_powertrain_only', other_powertrain_not_shown: 1}}).body);
  assert.match(other, /only with a different powertrain \(battery-electric or not\), so mcp\.vin shows no values/); assert.doesNotMatch(other, /NHTSA test vehicle:/);
  const down = text(sheet.html({...base(), tire_placard: {available: false, reason: 'dataset_not_indexed', vin_specific: false}}).body);
  assert.match(down, /index was not checked/); assert.doesNotMatch(down, /NHTSA test vehicle/);
  for (const bad of [tested({cold_pressure_psi: {front: 38, rear: null}}), tested({cold_pressure_psi: {front: 0, rear: 0}}), tested({tires: {front: '', rear: '215/50R17'}}),
    tested({report_url: 'https://example.com/r.pdf'}), tested({cold_pressure_kpa: {front: 260}}), tested({tested_as: ''})])
    assert.doesNotMatch(sheet.html({...base(), tire_placard: placard([bad])}).body, /NHTSA test vehicle/, JSON.stringify(bad));
  const evil = sheet.html({...base(), tire_placard: placard([tested({tested_as: '<img src=x onerror=alert(1)>', tires: {front: '<b>x</b>', rear: '<b>x</b>'}})])}).body;
  assert.doesNotMatch(evil, /<img src=x|<b>x/); assert.match(evil, /&lt;img src=x/);
});

const nearMatch = (o = {}) => ({kind: 'nearest_model_year', tested_model_year: 2023, vin_model_year: 2025, year_gap: 2,
  differences: [{field: 'model_year', tested: 2023, yours: 2025}], generation_check: 'unknown', ...o});

test('the match is stated in plain words for each tested vehicle', () => {
  const {sheet} = load();
  const out = v => text(sheet.html({...base(), tire_placard: placard([v])}).body);
  assert.match(out(tested({match: {kind: 'exact', differences: [], year_gap: 0}})), /Same model year\. Tires/);
  assert.match(out(tested({match: nearMatch()})), /NHTSA tested the 2023 model \(yours is 2025\)\. Tires and pressures can change between years\. Tires 215/);
  assert.match(out(tested({match: nearMatch({generation_check: 'same_wheelbase'})})), /Transport Canada lists the same wheelbase for both years\./);
  assert.match(out(tested({match: nearMatch({generation_check: 'different_wheelbase'})})), /different wheelbase for 2023, so it is likely another generation and these values may not apply\./);
  assert.match(out(tested({match: nearMatch({differences: [{field: 'model_year', tested: 2023, yours: 2025}, {field: 'trim', tested: 'Premier', yours: 'LT'}]})})),
    /Also different: trim Premier \(yours: LT\)\./);
  assert.match(out(tested({match: {kind: 'different_variant', tested_model_year: 2017, vin_model_year: 2017, year_gap: 0,
    differences: [{field: 'electrification', tested: 'plug_in_hybrid', yours: 'none'}]}})),
    /Same model year, different version: electrification plug-in hybrid \(yours: not hybrid or electric\)\. Tires and pressures can differ between versions\./);
  assert.match(out(tested({match: nearMatch()})), /Your own door placard governs/);
});

const specsVehicle = (o = {}) => ({model_year: 2023, make: 'HYUNDAI', model: 'Tucson', tested_as: '2023 Hyundai Tucson SEL AWD', electrification: 'none', test_no: 14989,
  report_url: 'https://nrd-static.nhtsa.dot.gov/reports/vehdb/v10000/v14900/v14989R001.pdf', match: {kind: 'exact', differences: [], year_gap: 0},
  fuel_tank: {litres: 54.09, gallons: 14.3, printed: '54.09 L'}, payload_vehicle_capacity_weight: {kg: 420, lb: 926},
  seating: {front: 2, rear: 3, third: 0, total: 5}, gvwr: {kg: 2205, lb: 4861}, gawr_front: {kg: 1260, lb: 2778}, gawr_rear: {kg: 1200, lb: 2646},
  curb_weight_as_delivered: {total: {kg: 1580, lb: 3483}, front: {kg: 931, lb: 2052}, rear: {kg: 649, lb: 1431}, front_percent: 58.9}, ...o});
const specs = (v, fuel = {}) => ({available: true, scope: 'nhtsa_test_vehicle', vin_specific: false, max_year_gap: 2, vehicles: v ? [v] : [], ...(v ? {match_kind: v.match.kind} : {reason: 'no_close_match'}),
  fuel_tank: v ? {shown: true, best_guess: v.match.kind !== 'exact', values: [{litres: 54.09, gallons: 14.3, printed: '54.09 L', test_no: 14989, model_year: v.model_year, match_kind: v.match.kind}], ...fuel} : {shown: false}});
const gas = () => ({...base(), engine: {fuel_type: 'Gasoline', cylinders: 4}, vehicle: {...base().vehicle, year: 2025, make: 'HYUNDAI', model: 'Tucson', trim: 'SEL'}});

test('capacities and weights of the NHTSA test vehicle: only the allowed fields, both units, labelled and linked', () => {
  const {sheet} = load();
  const html = sheet.html({...gas(), test_vehicle_specs: specs(specsVehicle())});
  const out = text(html.body);
  assert.match(out, /NHTSA test vehicle: 2023 Hyundai Tucson SEL AWD Same model year\. Values printed in NHTSA’s test report, not this VIN’s\. NHTSA test report 14989/);
  assert.match(out, /Fuel tank 14\.3 gal \(54\.09 L\) NHTSA test vehicle, same model year\./);
  assert.match(out, /Payload \(vehicle capacity weight\) 926 lb \(420 kg\)/);
  assert.match(out, /Seating capacity 5 \(2 front, 3 rear\)/);
  assert.match(out, /GVWR \(label\) 4,861 lb \(2,205 kg\)/);
  assert.match(out, /GAWR \(label\) Front 2,778 lb \(1,260 kg\); rear 2,646 lb \(1,200 kg\)/);
  assert.match(out, /Curb weight, as delivered 3,483 lb \(1,580 kg\) ?; front 2,052 lb, rear 1,431 lb \(59% front\)/);
  assert.match(html.body, /<a href="https:\/\/nrd-static\.nhtsa\.dot\.gov\/reports\/vehdb\/v10000\/v14900\/v14989R001\.pdf" target="_blank" rel="noopener">NHTSA test report 14989<\/a>/);
  assert.match(html.foot, /NHTSA test reports \(test-vehicle capacities and weights\)/);
  // Nothing else from the report (crash results, equipment, wheelbase) is shown.
  const block = text(html.body.slice(html.body.indexOf('<div class="tested-specs">'), html.body.indexOf('</section>', html.body.indexOf('<div class="tested-specs">'))));
  assert.match(block, /^ NHTSA test vehicle: .* \(59% front\) $/);
  assert.doesNotMatch(block, /\bHIC|injur|\bstars?\b|wheelbase|airbag|crush/i);
});

test('a fuel tank from another year or version is a best guess; hidden when electrification differs; none for an EV', () => {
  const {sheet} = load();
  const near = specsVehicle({model_year: 2023, match: nearMatch()});
  let out = text(sheet.html({...gas(), test_vehicle_specs: specs(near)}).body);
  assert.match(out, /Fuel tank \(best guess\) 14\.3 gal \(54\.09 L\) From NHTSA’s 2023 test vehicle \(yours is 2025\) ?; tank size can differ by year, trim and options ?\./);
  assert.match(out, /NHTSA tested the 2023 model \(yours is 2025\)\. Capacities and weights can change between years\./);
  const variant = specsVehicle({model_year: 2025, match: {kind: 'different_variant', tested_model_year: 2025, vin_model_year: 2025, year_gap: 0, differences: [{field: 'trim', tested: 'Limited', yours: 'SEL'}]}});
  out = text(sheet.html({...gas(), test_vehicle_specs: specs(variant)}).body);
  assert.match(out, /Fuel tank \(best guess\) 14\.3 gal \(54\.09 L\) From NHTSA’s 2025 test vehicle, a different version \(trim Limited \(yours: SEL\)\) ?; tank size can differ by year, trim and options ?\./);
  // Two tied test vehicles with different tanks: both values, never an average.
  out = text(sheet.html({...gas(), test_vehicle_specs: specs(specsVehicle(), {values: [{litres: 87.1, gallons: 23, model_year: 2023}, {litres: 124.9, gallons: 33, model_year: 2023}],
    optional_tank_listed: {litres: 124.9, gallons: 33}, model_tank_sizes: [{litres: 87.1, gallons: 23, model_years: [2023]}, {litres: 124.9, gallons: 33, model_years: [2023]}]})}).body);
  assert.match(out, /23\.0 gal \(87\.1 L\) or 33\.0 gal \(124\.9 L\)/); assert.match(out, /yours depends on options/);
  assert.match(out, /The report also lists an optional 33\.0 gal \(124\.9 L\) tank\./); assert.match(out, /list more than one tank: 23\.0 gal \(2023\); 33\.0 gal \(2023\)/);
  out = text(sheet.html({...gas(), test_vehicle_specs: specs(specsVehicle(), {shown: false, reason: 'different_electrification', note: 'NHTSA’s closest test vehicle is a hybrid; no tank size is shown.'})}).body);
  assert.match(out, /Fuel tank Not shown NHTSA’s closest test vehicle is a hybrid; no tank size is shown\./); assert.doesNotMatch(out, /14\.3 gal/);
  // A battery-electric VIN has no fuel tank row at all.
  const ev = sheet.html({...base(), test_vehicle_specs: specs(specsVehicle())}).body;
  assert.doesNotMatch(ev.slice(ev.indexOf('<div class="tested-specs">'), ev.indexOf('<details')), /Fuel tank/); assert.match(ev, /Payload/);
});

test('capacities: empty and unknown states are worded, never blank or zero', () => {
  const {sheet} = load();
  const out = sp => text(sheet.html({...gas(), test_vehicle_specs: sp}).body);
  assert.match(out(specs(null)), /NHTSA has no tested vehicle of this make and model within 2 model years in mcp\.vin’s index \(not tested, or not indexed yet\), so no tested fuel tank, payload or axle ratings are shown\. They are on the door-pillar label and in the owner’s manual\./);
  assert.match(out(undefined), /NHTSA’s test-vehicle index was not checked for this report/);
  assert.match(out({available: true, vehicles: [], reason: 'other_powertrain_only'}), /only with a different powertrain/);
  assert.match(out(specs(specsVehicle({fuel_tank: undefined, payload_vehicle_capacity_weight: undefined, seating: undefined, gvwr: undefined, gawr_front: undefined, curb_weight_as_delivered: undefined}), {shown: false, reason: 'not_printed_for_this_test_vehicle', values: []})),
    /Fuel tank Not shown The test report does not list the tank size\./);
  assert.doesNotMatch(out(specs(specsVehicle({gvwr: {kg: 0, lb: 0}}))), /GVWR \(label\)/);
  assert.doesNotMatch(out(specs(specsVehicle({report_url: 'https://example.com/r.pdf'}))), /NHTSA test vehicle:/);
  const evil = sheet.html({...gas(), test_vehicle_specs: specs(specsVehicle({tested_as: '<img src=x onerror=alert(1)>'}))}).body;
  assert.doesNotMatch(evil, /<img src=x/);
});

test('"Doesn’t match your door placard?" sends a correction for review; screen only', async () => {
  let listener = null, sent = null;
  const fakeDocument = {documentElement: {classList: {add() {}, remove() {}}}, querySelector: () => null, addEventListener: (type, fn) => { if (type === 'submit') listener = fn; }};
  class FormData { constructor(form) { this.form = form; } *[Symbol.iterator]() { yield* Object.entries(this.form.values); } }
  const fetch = async (url, opts) => { sent = {url, opts}; return {ok: true, status: 201, json: async () => ({ok: true, message: 'Thanks. We review corrections before using them.'})}; };
  const {sheet} = load({document: fakeDocument, FormData, fetch});
  const body = sheet.html({...gas(), tire_placard: placard([tested()])}).body;
  assert.match(body, /<details class="placard-fix sheet-screen-only"><summary>Doesn’t match your door placard\?<\/summary><form class="placard-fix-form" data-vin="1G1FW6S06H4188545" novalidate>/);
  for (const name of ['tire_front', 'tire_rear', 'psi_front', 'psi_rear', 'fuel_tank', 'note']) assert.match(body, new RegExp(`name="${name}"`), name);
  assert.match(body, /name="tire_front"[^>]*maxlength="40"/); assert.match(body, /name="note" maxlength="500"/);
  assert.match(body, /<select name="fuel_tank_unit" aria-label="Fuel tank unit"><option value="gal">gal<\/option><option value="L">L<\/option><\/select>/);
  assert.match(body, /We review corrections before using them; they are never shown to other readers\./); assert.match(body, /href="\/privacy\/#corrections"/);
  // Nothing shown: the control asks for the values instead.
  assert.match(sheet.html(gas()).body, /<summary>Tell us what your door placard says<\/summary>/);
  // The print stylesheet hides it.
  assert.match(readFileSync(new URL('../public/style.css', import.meta.url), 'utf8'), /\.placard-fix\{display:none!important\}/);
  // Submitting posts JSON and shows the thanks line.
  const status = {textContent: ''}, button = {disabled: false}, fields = [{disabled: false}, {disabled: false}];
  const form = {matches: s => s === 'form.placard-fix-form', dataset: {vin: '1G1FW6S06H4188545'}, values: {tire_front: '235/65R17 104H', psi_front: '35', fuel_tank: '', fuel_tank_unit: 'gal', note: ''},
    querySelector: s => (s === '.placard-fix-status' ? status : button), querySelectorAll: () => fields};
  let prevented = false;
  await listener({target: form, preventDefault: () => { prevented = true; }});
  assert.ok(prevented); assert.equal(sent.url, '/api/placard-corrections'); assert.equal(sent.opts.method, 'POST');
  assert.deepEqual(JSON.parse(sent.opts.body), {tire_front: '235/65R17 104H', psi_front: '35', fuel_tank: '', note: '', vin: '1G1FW6S06H4188545'});
  assert.equal(status.textContent, 'Thanks. We review corrections before using them.'); assert.ok(fields.every(f => f.disabled)); assert.equal(button.disabled, true);
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

test('VIN recall repairs: not checked by mcp.vin, links to the maker and NHTSA; model-year campaigns are not repair status', () => {
  const {sheet} = load();
  const out = text(sheet.html(base()).body);
  assert.match(out, /This VIN’s recall repairs Not checked by mcp\.vin\. Check this VIN on GM’s recall page \(enter the VIN there\) · Check on NHTSA mcp\.vin shows the model year’s campaigns; only the maker or NHTSA can say whether this car’s repairs are done\. Not checked by mcp\.vin\. Check at experience\.gm\.com\/ownercenter\/recalls or nhtsa\.gov\/recalls\./);
  assert.match(out, /Model-year recall campaigns 4 for the 2017 Chevrolet Bolt EV NHTSA campaigns for the make, model and year\. Not this car’s repair status\./);
  assert.ok(out.indexOf('Model-year recall campaigns') < out.indexOf('This VIN’s recall repairs'), 'campaigns first, then where to check this VIN');
  assert.match(out, /Owner complaints to NHTSA 47 for this model year Reports, not confirmed defects\./);
  assert.doesNotMatch(out, /\bopen\b|completed or closed|Reported by/);
  // Ford's page takes the VIN from the link: no "enter the VIN there".
  const ford = sheet.html({...base(), recall_status: {...base().recall_status, maker: 'Ford', manufacturer_lookup_url: 'https://www.ford.com/support/recalls-details/1G1FW6S06H4188545/', manufacturer_page_url: 'https://www.ford.com/support/recalls/', vin_prefilled: true}}).body;
  assert.match(ford, /<a href="https:\/\/www\.ford\.com\/support\/recalls-details\/1G1FW6S06H4188545\/" target="_blank" rel="noopener">Check this VIN on Ford’s recall page<\/a> · /);
  assert.match(text(ford), /Check at ford\.com\/support\/recalls or nhtsa\.gov\/recalls\./);
  // An old-style or missing block still says not checked and links NHTSA (never a status).
  for (const old of [{available: true, open_count: 2, completed_count: 1, source: {provider: 'Ford Owner Support VIN Recalls'}}, undefined])
    assert.match(text(sheet.html({...base(), recall_status: old}).body), /This VIN’s recall repairs Not checked by mcp\.vin\. Check on NHTSA .* Check at nhtsa\.gov\/recalls\./);
  const related = text(sheet.html({...base(), recalls: {available: true, count: 3, recalls: [], related_models: {available: true, count: 2}}}).body);
  assert.match(related, /3 for the 2017 Chevrolet Bolt EV \(plus 2 filed under related model names; they may not apply\)/);
});

test('values from upstream sources are escaped', () => {
  const {sheet} = load();
  const out = sheet.html({...base(), vehicle: {...base().vehicle, trim: '<img src=x onerror=alert(1)>'}, recall_status: {...base().recall_status, maker: '<script>x</script>', manufacturer_lookup_url: 'javascript:alert(1)'}});
  assert.doesNotMatch(out.body + out.foot, /<img src=x|<script>|javascript:/);
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
  assert.match(html, /Transport Canada model data ?, 2 records \(A; B\) ?\. Not specific to this VIN\./);
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

test('compliance test reports: linked by report number, seating total alone, a tank from another report has its own link', () => {
  const {sheet} = load();
  const ctr = n => `https://static.nhtsa.gov/odi/ctr/2020/TRTR-${n}-2020.pdf`;
  const v = specsVehicle({source: 'nhtsa_compliance_test', test_no: null, report_number: '646592', report_url: ctr(646592),
    other_reports: [{source: 'nhtsa_compliance_test', test_no: null, report_number: '646600', report_url: ctr(646600)}],
    seating: {total: 5}, fuel_tank: undefined, curb_weight_as_delivered: undefined});
  const tank = {values: [{litres: 54.09, gallons: 14.3, printed: '54.09 L', test_no: 14989, model_year: 2023, match_kind: 'exact', match: {kind: 'exact', differences: [], year_gap: 0},
    tested_as: '2023 Hyundai Tucson SEL AWD', report_url: 'https://nrd-static.nhtsa.dot.gov/reports/vehdb/v10000/v14900/v14989R001.pdf'}]};
  const html = sheet.html({...gas(), test_vehicle_specs: specs(v, tank)});
  const out = text(html.body);
  assert.match(out, /Seating capacity 5 /); assert.doesNotMatch(out, /Seating capacity 5 \(/);
  assert.match(out, /Values printed in NHTSA’s test reports, not this VIN’s\. NHTSA compliance test reports 646592 , 646600/);
  assert.match(html.body, /<a href="https:\/\/static\.nhtsa\.gov\/odi\/ctr\/2020\/TRTR-646600-2020\.pdf" target="_blank" rel="noopener">646600<\/a>/);
  assert.match(out, /Fuel tank 14\.3 gal \(54\.09 L\) NHTSA test vehicle, same model year\. 2023 Hyundai Tucson SEL AWD, NHTSA test report 14989 ?\./);
  // A placard from a compliance report links its report number.
  const p = text(sheet.html({...base(), tire_placard: placard([tested({source: 'nhtsa_compliance_test', test_no: null, report_number: '646592', report_url: ctr(646592)})])}).body);
  assert.match(p, /NHTSA compliance test report 646592/);
  // Another host is never linked.
  assert.doesNotMatch(sheet.html({...base(), tire_placard: placard([tested({report_url: 'https://example.com/r.pdf'})])}).body, /NHTSA test vehicle/);
});

test('full report: the FMVSS 135 brake test block, labelled, linked, and absent when not indexed', () => {
  const ctx = {console}; vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../public/test-vehicle.js', import.meta.url), 'utf8'), ctx);
  const tv = vm.runInContext('TestVehicle', ctx);
  const sd = {shown: true, vehicles: [{tested_as: '2016 BMW X1', report_url: 'https://static.nhtsa.gov/odi/ctr/2016/TRTR-644580-2016-001.pdf',
    report_label: 'NHTSA FMVSS 135 compliance test report 644580', match: {kind: 'nearest_model_year', tested_model_year: 2016, vin_model_year: 2017, differences: []},
    lightly_loaded: {m: 44.9, ft: 147}, fully_loaded_gvwr: {m: 48.6, ft: 159}}]};
  const out = text(tv.html({test_vehicle_specs: {stopping_distance: sd}}));
  assert.match(out, /Brake test of an NHTSA test vehicle \(FMVSS No\. 135\) 2016 BMW X1 : stop from 100 km\/h \(62 mph\) in 44\.9 m \(147 ft\) lightly loaded; 48\.6 m \(159 ft\) loaded to its GVWR\. NHTSA tested the 2016 model \(yours is 2017\)\. NHTSA FMVSS 135 compliance test report 644580/);
  assert.match(out, /Not a rating and not this VIN/);
  assert.equal(tv.html({test_vehicle_specs: {stopping_distance: {shown: false, reason: 'no_brake_test_in_reach'}}}), '');
  assert.equal(tv.html({}), '');
  assert.equal(tv.html({test_vehicle_specs: {stopping_distance: {...sd, vehicles: [{...sd.vehicles[0], report_url: 'https://example.com/x.pdf'}]}}}), '');
  assert.equal(tv.html({test_vehicle_specs: {stopping_distance: {...sd, vehicles: [{...sd.vehicles[0], lightly_loaded: {m: 0, ft: 0}, fully_loaded_gvwr: null}]}}}), '');
});

test('on paper: at most two tested vehicles and no tank-size list, so the sheet stays one page; all stay on screen', () => {
  const {sheet} = load();
  const vs = [tested(), tested({tires: {front: '225/55R18 98H', rear: '225/55R18 98H'}, test_no: 10001}), tested({cold_pressure_psi: {front: 35, rear: 35}, cold_pressure_kpa: {front: 240, rear: 240}, test_no: 10002})];
  const body = sheet.html({...base(), tire_placard: placard(vs)}).body;
  assert.equal((body.match(/<li class="placard-test"/g) || []).length, 2);
  assert.equal((body.match(/<li class="placard-test sheet-screen-only"/g) || []).length, 1);
  assert.match(body, /<p class="sheet-note sheet-print-only">1 more NHTSA test vehicle with other values: see the live report\.<\/p>/);
  assert.doesNotMatch(sheet.html({...base(), tire_placard: placard(vs.slice(0, 2))}).body, /<p class="sheet-note sheet-print-only">/);
  const out = sheet.html({...gas(), test_vehicle_specs: specs(specsVehicle(), {model_tank_sizes: [{litres: 54.09, gallons: 14.3, model_years: [2023]}, {litres: 62, gallons: 16.4, model_years: [2016]}]})}).body;
  assert.match(out, /<span class="sheet-screen-only"> NHTSA’s tested Tucson vehicles list more than one tank: 14\.3 gal \(2023\); 16\.4 gal \(2016\)\.<\/span>/);
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.sheet-print-only\{display:none\}/); assert.match(css, /\.car-sheet \.sheet-print-only\{display:block!important\}/);
});

test('accuracy wording, value sets when equally close tested vehicles differ, and withheld weights', () => {
  const {sheet} = load();
  const acc = {kind: 'exact', payload_right_pct: 87, seating_right_pct: 98, gvwr_right_pct: 93, basis: 'fixture'};
  // equally close vehicles differ on payload and GVWR: both values, never one picked; seating agrees -> one value
  const set = (kg, lb, as) => ({value: {kg, lb}, tested_as: as, model_year: 2023});
  let sp = {...specs(specsVehicle()), accuracy: acc,
    values_differ: {payload: [set(420, 926, '2023 Hyundai Tucson SEL AWD'), set(450, 992, '2023 Hyundai Tucson Limited AWD')],
      gvwr: [set(2205, 4861, '2023 Hyundai Tucson SEL AWD'), set(2250, 4960, '2023 Hyundai Tucson Limited AWD')]}};
  sp.fuel_tank.accuracy = {kind: 'exact', right_pct: 92};
  let out = text(sheet.html({...gas(), test_vehicle_specs: sp}).body);
  assert.match(out, /Payload \(vehicle capacity weight\) 926 lb \(420 kg\) or 992 lb \(450 kg\) NHTSA’s equally close test vehicles differ: 2023 Hyundai Tucson SEL AWD, 926 lb \(420 kg\); 2023 Hyundai Tucson Limited AWD, 992 lb \(450 kg\); yours depends on version and options\./);
  assert.match(out, /GVWR \(label\) 4,861 lb \(2,205 kg\) or 4,960 lb \(2,250 kg\)/);
  assert.match(out, /Seating capacity 5 \(2 front, 3 rear\)/);
  assert.match(out, /In mcp\.vin’s accuracy test, matches like this were right for payload 87%, seating 98%, GVWR 93%\./);
  assert.match(out, /In mcp\.vin’s accuracy test, matches like this were right for 92%\./);
  // another version: GVWR and GAWR withheld with the reason; the GVWR accuracy is not quoted
  const other = specsVehicle({match: {kind: 'different_variant', differences: [{field: 'trim', tested: 'Limited', yours: 'SEL'}], year_gap: 0},
    gvwr: undefined, gawr_front: undefined, gawr_rear: undefined,
    withheld: {fields: ['gvwr', 'gawr_front', 'gawr_rear'], reason: 'different_version', note: 'GVWR and axle ratings (one label) of a different version are not shown: in mcp.vin’s accuracy test a different version’s GVWR matched the vehicle’s own in only about 4 of 10 cases.'}});
  sp = {...specs(other), accuracy: {kind: 'different_variant', payload_right_pct: 68, seating_right_pct: 92}};
  out = text(sheet.html({...gas(), test_vehicle_specs: sp}).body);
  assert.doesNotMatch(out, /GVWR \(label\)|GAWR \(label\)/);
  assert.match(out, /GVWR and axle ratings \(one label\) of a different version are not shown/);
  assert.match(out, /matches like this were right for payload 68%, seating 92%\./);
  // tires: the accuracy of the match kind joins the governs note
  const tp = {...placard([{tested_as: '2023 Hyundai Tucson SEL AWD', tires: {front: '235/60R18 103H', rear: '235/60R18 103H'},
    cold_pressure_psi: {front: 36, rear: 36}, cold_pressure_kpa: {front: 250, rear: 250}, test_no: 14989,
    report_url: 'https://nrd-static.nhtsa.dot.gov/reports/vehdb/v10000/v14900/v14989R001.pdf', match: {kind: 'exact', differences: [], year_gap: 0}}]),
    accuracy: {kind: 'exact', tire_size_right_pct: 91, cold_pressure_right_pct: 96}};
  out = text(sheet.html({...gas(), tire_placard: tp}).body);
  assert.match(out, /In mcp\.vin’s accuracy test, matches like this were right for tire size 91%, pressures 96%\. ?Your own door placard governs/);
});

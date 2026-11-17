// One-page print rules of the car sheet for the rows the fuel-economy and EPA-test-vehicle work added: what prints is
// the leading part of the screen text; the explanation after it is screen only (class sheet-screen-only).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

function load() {
  const ctx = {console, URLSearchParams, setTimeout};
  vm.createContext(ctx);
  for (const file of ['qr.js', 'car-sheet.js', 'more-sources.js']) vm.runInContext(readFileSync(new URL('../public/' + file, import.meta.url), 'utf8'), ctx);
  return vm.runInContext('CarSheet', ctx);
}
const strip = html => html.replace(/<wbr>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
/** The text that reaches paper: screen-only spans, notes and rows removed (none of them nest another span or row). */
const paper = html => strip(html
  .replace(/<span class="sheet-screen-only">(?:[^<]|<a [^>]*>[^<]*<\/a>)*<\/span>/g, '')
  .replace(/<p class="sheet-note[^"]*sheet-screen-only">.*?<\/p>/g, '')
  .replace(/<div class="sheet-row sheet-screen-only">.*?<\/dd><\/div>/g, '')
  .replace(/<details class="placard-fix sheet-screen-only">.*?<\/details>/g, ''));

const base = {
  valid: true, vin: '1HGCM82633A004352', validation: {checksum: {valid: true}},
  vehicle: {year: 2016, make: 'SUBARU', model: 'Outback', trim: 'Limited', body_class: 'Sport Utility Vehicle (SUV)/Multipurpose Vehicle (MPV)', vehicle_type: 'MULTIPURPOSE PASSENGER VEHICLE (MPV)'},
  engine: {displacement_l: 2.5, cylinders: 4}, transmission: {}, raw_nhtsa: {}, dimensions: {},
  recalls: {available: true, count: 0, recalls: []}, provenance: {assembled_at: '2026-11-17T10:00:00Z'},
};
const epa = {available: true, match: 'exact', rated_hp: {min: 175, max: 175}, tested_model_years: [2016], match_basis: ['2.5 L engine']};

test('on paper: the EPA match kind prints, the configuration list and the explanation stay on screen', () => {
  const sheet = load();
  const exact = {available: true, match: 'exact', combined_mpg: 28, city_mpg: 25, highway_mpg: 32, fuel_type: 'Regular Gasoline', matched_variant: 'Outback AWD · Automatic (AV-S6), 4 cyl, 2.5 L'};
  let html = sheet.html({...base, fuel_economy: exact}).body;
  assert.match(strip(html), /EPA figures are for the matched test configuration: Outback AWD/);
  assert.doesNotMatch(paper(html), /matched test configuration/);
  assert.match(paper(html), /EPA fuel economy 28 mpg combined \(25 city, 32 hwy\)/);
  html = sheet.html({...base, fuel_economy: {...exact, match: 'closest'}}).body;
  assert.match(paper(html), /Closest EPA configuration, not an exact match\./);
  assert.doesNotMatch(paper(html), /AV-S6/);
  const several = {available: false, reason: 'ambiguous_variant', match: 'multiple_configurations', mpg_range: {unit: 'mpg', combined: {min: 26, max: 28}, city: {min: 22, max: 25}, highway: {min: 30, max: 32}},
    summary: '26-28 mpg combined across 2 EPA configurations of this model; the VIN does not say which: continuously variable (CVT) or 6-speed manual'};
  html = sheet.html({...base, fuel_economy: several}).body;
  assert.match(paper(html), /EPA range: 26-28 mpg combined across 2 EPA configurations of this model; the VIN does not say which\./);
  assert.doesNotMatch(paper(html), /6-speed manual/);
  assert.match(strip(html), /the VIN does not say which ?: continuously variable \(CVT\) or 6-speed manual/);
  const same = {available: true, match: 'same_rating', combined_mpg: 18, unit: 'mpg', summary: '18 mpg combined for both EPA configurations this VIN fits, so the figure holds whichever it is (they differ in with or without start-stop)'};
  html = sheet.html({...base, fuel_economy: same}).body;
  assert.match(paper(html), /18 mpg combined for both EPA configurations this VIN fits, so the figure holds whichever it is\./);
  assert.doesNotMatch(paper(html), /start-stop/);
});

test('on paper: rated power keeps its source and the hybrid caveat in short; vehicle type and the axle split stay on screen', () => {
  const sheet = load();
  let html = sheet.html({...base, fuel_economy: {available: false}, epa_test_vehicles: epa}).body;
  assert.match(paper(html), /Rated power 175 hp \(maker’s EPA test vehicles ?\)/);
  assert.match(strip(html), /Rated power 175 hp \(maker’s EPA test vehicles for this engine family ?\)/);
  html = sheet.html({...base, fuel_economy: {available: false}, epa_test_vehicles: {...epa, hp_note: 'hybrid'}}).body;
  assert.match(paper(html), /Rated power 175 hp \(engine rating ?; maker’s EPA test vehicles ?\)/);
  // the regulatory class repeats the body style: screen only when the body is known, printed when it is the only one
  assert.match(strip(html), /Vehicle type Multipurpose passenger vehicle/);
  assert.doesNotMatch(paper(html), /Vehicle type/);
  html = sheet.html({...base, vehicle: {...base.vehicle, body_class: null}, fuel_economy: {available: false}}).body;
  assert.match(paper(html), /Vehicle type Multipurpose passenger vehicle/);
});

test('a corrected misprint: paper says it was corrected; the screen also says what was printed and links the confirming report', () => {
  const sheet = load();
  const note = 'NHTSA’s report prints 16.3 under a litres heading; that is 16.3 US gallons, 61.7 L, which matches the other tested Malibu';
  const correction = {corrected: true, rule: 'gallons_under_litres_heading', note: note + '.', printed: {value: 16.3, unit: 'L'},
    confirmed_by: [{check: 'same_generation_version', detail: 'test 6997 prints 61.7 L', report: 'test 6997', report_url: 'https://nrd-static.nhtsa.dot.gov/reports/vehdb/v06000/v06900/v06997R001.pdf'}]};
  const tankVal = {litres: 61.7, gallons: 16.3, printed: '16.3 gal', test_no: 7000, model_year: 2011, match_kind: 'exact', correction};
  const specs = {available: true, match_kind: 'exact', vehicles: [{test_no: 7000, model_year: 2011, tested_as: '2011 Chevrolet Malibu LS', report_url: 'https://nrd-static.nhtsa.dot.gov/reports/vehdb/v07000/v07000R001.pdf',
    match: {kind: 'exact'}, fuel_tank: tankVal}], fuel_tank: {shown: true, best_guess: false, label: 'NHTSA test vehicle, same model year', values: [tankVal]}};
  const html = sheet.html({...base, fuel_economy: {available: false}, test_vehicle_specs: specs}).body;
  assert.match(paper(html), /Corrected from a misprint in NHTSA’s report ?\./);
  assert.doesNotMatch(paper(html), /litres heading/);
  assert.match(strip(html), /Corrected from a misprint in NHTSA’s report ?: NHTSA’s report prints 16\.3 under a litres heading; that is 16\.3 US gallons, 61\.7 L, which matches the other tested Malibu \(confirmed by test 6997 \)/);
  assert.match(html, /href="https:\/\/nrd-static\.nhtsa\.dot\.gov\/reports\/vehdb\/v06000\/v06900\/v06997R001\.pdf"/);
  // several tanks shown, the corrected one second: the note says which value was corrected
  const other = {litres: 71.9, gallons: 19, printed: '71.9 L', test_no: 6998, model_year: 2011, match_kind: 'exact'};
  const two = sheet.html({...base, fuel_economy: {available: false}, test_vehicle_specs: {...specs, fuel_tank: {...specs.fuel_tank, values: [other, tankVal]}}}).body;
  assert.match(paper(two), /19(\.0)? gal \(71\.9 L\) or 16\.3 gal \(61\.7 L\)/);
  assert.match(paper(two), /The 16\.3 gal \(61\.7 L\) value is corrected from a misprint in NHTSA’s report ?\./);
  // a correction of a second report names that report; the shown values are another report's
  const u = n => `https://nrd-static.nhtsa.dot.gov/reports/vehdb/v10000/v10500/v${n}R001.pdf`;
  const placard = {available: true, match_kind: 'exact', vehicles: [{tested_as: '2018 Nissan Titan S Crew Cab', report_url: u(10557), test_no: 10557, source: 'nhtsa_crash_test',
    match: {kind: 'exact'}, tires: {front: '265/70R18 114S', rear: '265/70R18 114S'}, cold_pressure_psi: {front: 36, rear: 36}, cold_pressure_kpa: {front: 250, rear: 250},
    other_reports: [{test_no: 10553, report_url: u(10553)}], corrections: [{corrected: true, rule: 'psi_under_kpa_heading', report: 'test 10553', report_url: u(10553),
      note: 'NHTSA’s report prints 36/36 under a kPa heading; those are psi (248/248 kPa), confirmed by test 10554 (2018 TITAN) prints 250/250 kPa.',
      confirmed_by: [{check: 'same_generation_version', detail: 'x', report: 'test 10554', report_url: u(10554)}]}]}]};
  const t = sheet.html({...base, fuel_economy: {available: false}, tire_placard: placard}).body;
  assert.match(strip(t), /Corrected from a misprint in NHTSA’s report test 10553 ?: it prints 36\/36 under a kPa heading; those are psi/);
  assert.match(paper(t), /Cold 36 psi front and rear \(250 kPa\) Corrected from a misprint in NHTSA’s report ?\./);
});

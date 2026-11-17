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
  .replace(/<span class="sheet-screen-only">[^<]*<\/span>/g, '')
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

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {market, marketQuery} from '../lib/market.mjs';
import {InputError} from '../lib/research.mjs';

const answer = {ok: true, as_of: '2026-11-18', year: 2021, make: 'Honda', model: 'CR-V', zip: '10520', notes: [], mode: 'used',
  comparables: 34, radius_miles: 150, national_comparables: 303, miles: 48000, per_10k_miles_pct: -2.9,
  dealer_asking: {low: 25000, mid: 26100, high: 27400}, private_party: 23800, trade_in: {low: 19600, mid: 21400, high: 22200},
  this_car: {vin: '2HKRW2H51MH680145', price: 23394, miles: 48100, year: 2021, trim: 'EX', condition: 'used', color: 'Silver', dealer: 'A Dealer', city: 'White Plains', state: 'NY', url: 'https://dealer.example/car', distance: 13},
  points: [[10000, 30000], [20000, 29000], [30000, 28000], [40000, 27000], [50000, 26000], [60000, 25000], [70000, 24000], [80000, 23000]],
  listings: [
    {vin: '2HKRW2H51MH680145', price: 23394, miles: 48100, year: 2021, trim: 'EX', condition: 'used', color: 'Silver', dealer: 'A Dealer', city: 'White Plains', state: 'NY', url: 'https://dealer.example/car', distance: 13},
    {vin: '2HKRW2H86MH684220', price: 21995, miles: 81465, year: 2021, trim: 'EX-L', condition: 'certified', color: 'Blue <b>', dealer: 'B Dealer', city: 'Paramus', state: 'NJ', url: 'https://b.example/x', distance: 6},
    {vin: null, price: 28000, miles: 20000, year: 2021, trim: 'Touring', condition: 'used', color: null, dealer: null, city: null, state: null, url: 'javascript:alert(1)', distance: 40},
  ]};

test('price request: required fields, optional ZIP and mileage, nothing silently dropped', () => {
  assert.deepEqual(marketQuery({year: 2021, make: ' Honda ', model: 'CR-V', trim: '', vin: '', zip: '', miles: ''}), {year: 2021, make: 'Honda', model: 'CR-V'});
  assert.deepEqual(marketQuery({year: '2021', make: 'Honda', model: 'CR-V', trim: 'EX', vin: '2hkrw2h51mh680145', zip: '10520', miles: '48000'}),
    {year: 2021, make: 'Honda', model: 'CR-V', trim: 'EX', vin: '2HKRW2H51MH680145', zip: '10520', miles: 48000});
  for (const bad of [{}, {year: 1970, make: 'a', model: 'b'}, {year: 2021, make: '', model: 'b'}, {year: 2021, make: 'a', model: 'b', zip: '1052'},
    {year: 2021, make: 'a', model: 'b', zip: '10520-1234'}, {year: 2021, make: 'a', model: 'b', miles: -1}, {year: 2021, make: 'a', model: 'b', miles: 'many'},
    {year: 2021, make: 'a', model: 'b', vin: 'SHORT'}]) assert.throws(() => marketQuery(bad), InputError);
});

test('price service: the answer is passed through; an outage is an explicit "unavailable", never an exception or a wait', async () => {
  let asked;
  const ok = await market({year: 2021, make: 'Honda', model: 'CR-V', zip: '10520', miles: 48000},
    {base: 'http://price.test', fetchImpl: async url => { asked = url; return {ok: true, json: async () => answer}; }});
  assert.equal(ok.dealer_asking.mid, 26100);
  assert.equal(asked, 'http://price.test/market?year=2021&make=Honda&model=CR-V&zip=10520&miles=48000');
  const down = {ok: false, reason: 'unavailable'};
  assert.deepEqual(await market({year: 2021, make: 'a', model: 'b'}, {base: 'http://price.test', fetchImpl: async () => { throw new Error('refused'); }}), down);
  assert.deepEqual(await market({year: 2021, make: 'a', model: 'b'}, {base: 'http://price.test', fetchImpl: async () => ({ok: false, status: 503})}), down);
  assert.deepEqual(await market({year: 2021, make: 'a', model: 'b'}, {base: 'off', fetchImpl: async () => { throw new Error('must not be called'); }}), down);
  const started = Date.now();
  const slow = await market({year: 2021, make: 'a', model: 'b'}, {base: 'http://price.test', timeoutMs: 40,
    fetchImpl: (url, {signal}) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))});
  assert.deepEqual(slow, down);
  assert.ok(Date.now() - started < 1000);
  await assert.rejects(market({year: 2021, make: '', model: 'b'}, {base: 'http://price.test', fetchImpl: async () => ({ok: true, json: async () => answer})}), InputError);
});

function page(file, name) {
  const ctx = vm.createContext({console, URL, URLSearchParams});
  vm.runInContext(readFileSync(new URL('../public/' + file, import.meta.url), 'utf8') + `\nthis.${name} = ${name};`, ctx);
  return ctx[name];
}

test('Price tab: figures, plain wording and safe links', () => {
  const M = page('market.js', 'Market');
  assert.equal(M.short(26100), '$26.1k');
  assert.equal(M.short(5000), '$5k');
  assert.equal(M.short(194100), '$194k');
  assert.equal(M.whereText(answer), 'within 150 miles of 10520');
  assert.equal(M.whereText({...answer, zip: null, radius_miles: null}), 'nationwide');
  assert.equal(M.basisText(answer), '34 cars for sale within 150 miles of 10520 · priced at 48,000 miles · Nov 18');
  assert.deepEqual([...M.noteTexts({...answer, comparables: 6, notes: ['thin', 'nearby_years', 'zip_unknown', 'something_new']})],
    ['Only 6 comparable cars: treat as a rough guide.', 'Few 2021s for sale: 2020–2022 included.', 'ZIP code not found: showing national prices.']);
  // this car against the estimate: only when both are for (nearly) the same mileage
  assert.equal(M.thisCarDelta(answer), '$2,700 below typical for its mileage');
  assert.equal(M.thisCarDelta({...answer, miles: 90000}), '');
  assert.equal(M.thisCarDelta({...answer, miles: null}), '');
  const tiles = M.tilesHtml(answer);
  assert.match(tiles, /Trade-in<\/span><b>\$21,400<\/b><small>\$19,600 – \$22,200/);
  assert.match(tiles, /Private sale<\/span><b>\$23,800/);
  assert.match(tiles, /Dealer price<\/span><b>\$26,100/);
  assert.doesNotMatch(M.tilesHtml({...answer, mode: 'new'}), /Trade-in|Private sale/);
  const st = {sort: 'price', all: true, miles: 48000, title: 'Honda CR-V', width: 360};
  const html = M.panelHtml(answer, st, '10520');
  assert.match(html, /This car is for sale/);
  assert.match(html, /href="https:\/\/dealer\.example\/car" target="_blank" rel="noopener nofollow"/);
  assert.match(html, /href="\/2HKRW2H86MH684220"/);            // each other car links to its own report
  assert.doesNotMatch(html, /javascript:/);                      // a listing without an http(s) address is not shown
  assert.doesNotMatch(html, /Blue <b>/);                         // listing text is escaped
  assert.match(html, /Blue &lt;b&gt;/);
  assert.match(html, /<svg /);
  assert.ok(html.indexOf('$21,995') < html.indexOf('$23,394</span>'), 'sorted by lowest price');
  assert.match(html, /rules of thumb/);                          // the method states what the derived figures are
  assert.equal(M.sorted(answer.listings, 'near').map(l => l.distance).join(), '6,13,40');
  assert.equal(M.sorted(answer.listings, 'miles').map(l => l.miles).join(), '20000,48100,81465');
});

test('Price tab: outage and empty answers say so plainly', () => {
  const M = page('market.js', 'Market');
  const st = {sort: 'price', all: false, miles: null, title: 'Saab 9-3'};
  assert.match(M.panelHtml({ok: false, reason: 'unavailable'}, st, ''), /Prices are unavailable right now[\s\S]*Try again/);
  const none = M.panelHtml({ok: false, reason: 'no_comparables'}, st, '');
  assert.match(none, /No comparable cars for sale/);
  assert.doesNotMatch(none, /Try again/);
  assert.match(M.panelHtml(null, {...st, loading: true}, ''), /aria-busy="true"/);
  assert.equal(M.chartSvg({...answer, points: answer.points.slice(0, 3)}), '');   // too few cars for a chart
});

test('report tabs: the tab lives in ?tab= and Overview is the default', () => {
  const T = page('report-tabs.js', 'ReportTabs');
  assert.deepEqual([...T.TABS], ['sheet', 'price', 'tires', 'safety', 'specs', 'all']);
  assert.equal(T.fromSearch('?tab=price'), 'price');
  assert.equal(T.fromSearch('?tab=nonsense'), 'sheet');
  assert.equal(T.fromSearch(''), 'sheet');
  assert.equal(T.toSearch('?transmission=manual', 'price'), '?transmission=manual&tab=price');
  assert.equal(T.toSearch('?tab=price', 'sheet'), '');
  assert.equal(T.safetyFigure({recall_status: {available: true, open_count: 2}}), '2 open');
  assert.equal(T.safetyFigure({recall_status: {available: true, open_count: 0}}), '');
  assert.equal(T.safetyFigure({recall_status: {available: false, open_count: 3}}), '');
  assert.equal(T.safetyFigure({recall_status: {available: true, open_count: 'Unknown'}}), '');
});

test('report page: tab bar, price panel and their scripts are in place; print still shows the whole report', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const tab of ['sheet', 'price', 'tires', 'safety', 'specs', 'all']) assert.ok(html.includes(`data-report-tab="${tab}"`), tab);
  assert.ok(html.includes('id="market-panel"'));
  assert.ok(html.indexOf('/report-tabs.js') < html.indexOf('/app.js') && html.indexOf('/market.js') < html.indexOf('/app.js'));
  const css = readFileSync(new URL('../public/market.css', import.meta.url), 'utf8');
  assert.match(css, /@media screen\{[\s\S]*#results:not\(\[data-tab=sheet\],\[data-tab=tires\]\) #car-sheet\{display:none\}/);   // hiding is screen-only
  assert.match(css, /@media print\{\.report-nav,#market-panel,#tires-quick\{display:none!important\}\}/);
  assert.ok(html.includes('id="tires-quick"') && html.indexOf('/tires-tab.js') < html.indexOf('/app.js'));
});

test('Tires tab: figures come from the closest NHTSA test vehicle, with the match stated and the placard governing', () => {
  const T = page('tires-tab.js', 'TiresTab');
  const v = {tested_as: '2019 Honda CR-V AWD LX 5-Door MPV', tires: {front: 'P235/65R17 104H', rear: 'P235/65R17 104H'},
    cold_pressure_psi: {front: 32, rear: 30}, cold_pressure_kpa: {front: 220, rear: 210}, match: {kind: 'nearest_model_year', tested_model_year: 2019, vin_model_year: 2021}};
  const html = T.quickHtml([v]);
  assert.match(html, /Tire size<\/span><b>P235\/65R17 104H<\/b><small>front and rear/);
  assert.match(html, /Front, cold<\/span><b>32 psi<\/b><small>220 kPa/);
  assert.match(html, /Rear, cold<\/span><b>30 psi<\/b><small>210 kPa/);
  assert.match(html, /tires-basis-near"><strong>From NHTSA’s 2019 test vehicle; yours is 2021\.<\/strong> Your door placard governs\./);   // a mismatch is stated and marked
  const exact = T.quickHtml([{...v, match: {kind: 'exact'}}]);
  assert.doesNotMatch(exact, /tires-basis-near/);
  assert.match(exact, /From the vehicle NHTSA tested for this model year\./);
  assert.match(T.quickHtml([{...v, match: {kind: 'different_variant'}}]), /tires-basis-near"><strong>From a different version NHTSA tested for this model year\./);
  const staggered = {...v, tested_as: 'Another version', tires: {front: '245/40R19 98Y', rear: '275/35R19 <100Y>'}, cold_pressure_psi: {front: 35, rear: 38}};
  const two = T.quickHtml([staggered, v]);
  assert.match(two, /245\/40R19 98Y<\/b><small>front<\/small>[\s\S]*275\/35R19 &lt;100Y&gt;<\/b><small>rear/);
  assert.match(two, /1 other tested version lists different values below\./);
  assert.equal(T.quickHtml([]), '');                              // nothing tested: no figures, never a guess
});

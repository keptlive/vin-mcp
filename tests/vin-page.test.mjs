import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {renderVinPage, renderUnknownVinPage, vinFacts} from '../lib/vin-page.mjs';
import {restReport} from '../lib/reports.mjs';

const template = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const complaint = i => ({odi_number: i, component: i % 2 ? 'AIR BAGS' : 'ENGINE', summary: 'x', date_complaint_filed: `01/${String(1 + i % 28).padStart(2, '0')}/${2000 + i % 20}`});
const report = {
  valid: true, vin: '1HGCM82633A004352',
  vehicle: {year: 2003, make: 'HONDA', model: 'Accord', trim: 'EX-V6', body_class: 'Coupe', doors: 2},
  engine: {cylinders: 6, displacement_l: 2.998832712, hp: 240, fuel_type: 'Gasoline'},
  transmission: {type: 'Automatic', speeds: 5}, plant: {city: 'MARYSVILLE', state: 'OHIO'},
  recalls: {available: true, count: 24, recalls: []},
  complaints: {available: true, count: 60, complaints: Array.from({length: 60}, (_, i) => complaint(i)), summary: {crashes: 1, fires: 0, injuries: 0, deaths: 0}},
  safety_ratings: {rated: true, overall: null},
  fuel_economy: {available: true, city_mpg: 19, highway_mpg: 27, combined_mpg: 22},
};

test('a VIN page carries the vehicle in its head, structured data and summary', () => {
  const html = renderVinPage(template, report);
  assert.match(html, /<title>2003 Honda Accord EX-V6 VIN 1HGCM82633A004352: specs, recalls and safety \| mcp\.vin<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/mcp\.vin\/1HGCM82633A004352">/);
  assert.match(html, /<meta name="description" content="2003 Honda Accord EX-V6 coupe, 3\.0 L 6-cylinder gasoline\. 24 recall campaigns and 60 NHTSA complaints for this model year\. 22 mpg combined\./);
  assert.match(html, /<meta property="og:url" content="https:\/\/mcp\.vin\/1HGCM82633A004352">/);
  assert.match(html, /"@type":"Car"[^<]*"vehicleIdentificationNumber":"1HGCM82633A004352"/);
  assert.match(html, /<div id="ssr-summary"[^>]*><h2>2003 Honda Accord EX-V6<\/h2>/);
  assert.match(html, /<dt>Assembly plant<\/dt><dd>Marysville, Ohio<\/dd>/);
  assert.equal(html.split('<title>').length, 2);
});

test('missing source values are left out rather than shown as zero', () => {
  const facts = Object.fromEntries(vinFacts({...report, recalls: {available: false, count: null}, complaints: null, fuel_economy: {available: false}}).facts);
  assert.equal('Recall campaigns for this model year' in facts, false);
  assert.equal('NHTSA complaints for this model year' in facts, false);
  assert.equal('EPA fuel economy' in facts, false);
  assert.equal('NHTSA overall safety rating' in facts, false);
});

test('an exact-name zero is not stated bare when related NHTSA names carry campaigns or the name is unused', () => {
  for (const recalls of [{available: true, count: 0, recalls: [], related_campaigns_found: true}, {available: true, count: 0, recalls: [], related_campaigns_found: false, related_models: {decoded_name_in_recall_data: false}}]) {
    const html = renderVinPage(template, {...report, recalls});
    assert.doesNotMatch(html, /0 recall campaigns/);assert.match(html, /60 NHTSA complaints for this model year\./);
    assert.match(Object.fromEntries(vinFacts({...report, recalls}).facts)['Recall campaigns for this model year'], recalls.related_campaigns_found ? /^0 under this exact model name; NHTSA lists campaigns under related/ : /^0 under this exact model name; NHTSA has never filed/);
  }
  const plain = renderVinPage(template, {...report, recalls: {available: true, count: 0, recalls: [], related_campaigns_found: false}});
  assert.match(plain, /0 recall campaigns and 60 NHTSA complaints for this model year\./);
});

test('values from upstream are escaped', () => {
  const html = renderVinPage(template, {...report, vehicle: {...report.vehicle, trim: '<script>alert(1)</script>"'}});
  assert.equal(html.includes('<script>alert(1)'), false);
  assert.match(html, /&lt;script&gt;alert\(1\)/);
});

test('an undecodable VIN gets the plain page, kept out of search indexes', () => {
  const html = renderUnknownVinPage(template);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.equal(html.includes('rel="canonical"'), false);
});

test('the REST report carries the 25 most recent complaints unless all are asked for', () => {
  const capped = restReport(report);
  assert.equal(capped.complaints.complaints.length, 25);
  assert.equal(capped.complaints.count, 60);
  assert.equal(capped.complaints.truncated, true);
  assert.equal(capped.complaints.returned, 25);
  assert.match(capped.complaints.note, /\?complaints=all/);
  assert.equal(capped.complaints.complaints[0].date_complaint_filed.endsWith('2019'), true);
  assert.equal(capped.complaints.summary.crashes, 1);
  assert.equal(restReport(report, {allComplaints: true}), report);
  const few = {...report, complaints: {...report.complaints, complaints: report.complaints.complaints.slice(0, 5)}};
  assert.equal(restReport(few), few);
  assert.equal(report.complaints.complaints.length, 60);
});

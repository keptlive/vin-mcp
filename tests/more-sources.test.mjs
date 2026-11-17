import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {lookupBuildDates, withBuildDates} from '../lib/recall-build-dates.mjs';

const temp = mkdtempSync(path.join(tmpdir(), 'vin-more-sources-'));
test.after(() => rmSync(temp, {recursive: true, force: true}));

// Minimal DOM, as in regression.test.mjs: run the real browser scripts (more-sources.js, then app.js).
function frontend() {
  const els = new Map();
  const element = () => ({style: {}, dataset: {}, handlers: {}, value: '', classList: {add() {}, remove() {}, toggle() {}}, addEventListener(k, fn) { this.handlers[k] = fn; }, dispatchEvent(e) { return this.handlers[e.type]?.(e); }, setAttribute() {}, focus() {}, setSelectionRange() {}, querySelector() { return element(); }, querySelectorAll() { return []; }, replaceChildren() { this.innerHTML = ''; }, innerHTML: '', textContent: '', hidden: false});
  const document = {createElement: () => ({set textContent(v) { this.innerHTML = String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }}), querySelector: s => { if (!els.has(s)) els.set(s, element()); return els.get(s); }, querySelectorAll: () => [], addEventListener() {}};
  const ctx = {document, window: {location: {pathname: '/'}}, navigator: {}, localStorage: {getItem() { return null; }}, console, fetch: async () => new Response('{}'), setTimeout() {}, addEventListener() {}};
  vm.createContext(ctx);
  for (const file of ['more-sources.js', 'app.js']) vm.runInContext(readFileSync(new URL('../public/' + file, import.meta.url), 'utf8'), ctx);
  ctx.window.MoreSources = vm.runInContext('MoreSources', ctx);
  return {els, run: script => vm.runInContext(script, ctx), sources: ctx.window.MoreSources};
}

function buildDb(file) {
  const db = new Database(file);
  db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE campaign_builds(campaign TEXT NOT NULL,make_compact TEXT NOT NULL,model_compact TEXT NOT NULL,year INTEGER NOT NULL,built_from TEXT,built_to TEXT,distinct_ranges INTEGER NOT NULL,PRIMARY KEY(campaign,make_compact,model_compact,year)) WITHOUT ROWID;
    CREATE TABLE campaign_units(campaign TEXT PRIMARY KEY,units_affected INTEGER NOT NULL) WITHOUT ROWID;`);
  db.prepare('INSERT INTO metadata VALUES(?,?)').run('source', JSON.stringify({latest_report_date: '2026-11-12'}));
  const ins = db.prepare('INSERT INTO campaign_builds VALUES(?,?,?,?,?,?,?)');
  ins.run('11V562000', 'SUBARU', 'OUTBACK', 2012, '2011-10-17', '2011-11-23', 1);
  ins.run('12V001000', 'FORD', 'F150', 2012, '2011-01-05', '2011-04-15', 2);
  ins.run('12V004000', 'FORD', 'F150', 2012, '2012-04-01', null, 1);
  ins.run('24V744000', 'HONDA', 'CRVHYBRID', 2024, '2023-01-02', '2023-06-30', 1);
  db.prepare('INSERT INTO campaign_units VALUES(?,?)').run('11V562000', 32685);
  db.close();
}

test('build-date lookup joins campaign + make + model + year, ignoring punctuation, and reports a missing index', () => {
  const file = path.join(temp, 'labels.db');
  buildDb(file);
  const found = lookupBuildDates([{campaign: '11V562000', make: 'SUBARU', model: 'Outback', year: 2012}, {campaign: '12V001000', make: 'Ford', model: 'F-150', year: 2012}, {campaign: '11V562000', make: 'SUBARU', model: 'Legacy', year: 2012}], file);
  assert.equal(found.available, true);
  assert.deepEqual([...found.ranges.values()].map(r => [r.built_from, r.built_to, r.units_affected]), [['2011-10-17', '2011-11-23', 32685], ['2011-01-05', '2011-04-15', null], [null, null, 32685]]);
  assert.deepEqual(lookupBuildDates([], path.join(temp, 'missing.db')), {available: false, reason: 'dataset_not_indexed'});
  const old = path.join(temp, 'old.db');
  new Database(old).exec("CREATE TABLE metadata(key TEXT, value TEXT)");
  assert.deepEqual(lookupBuildDates([{campaign: 'X', make: 'A', model: 'B', year: 2012}], old), {available: false, reason: 'dataset_not_indexed'});
});

test('reports attach build dates to exact, related and flat-file-only campaigns by their own label, never guessing', () => {
  const file = path.join(temp, 'labels2.db');
  buildDb(file);
  const lookup = keys => lookupBuildDates(keys, file);
  const recalls = {available: true, count: 2, recalls: [{campaign_number: '12V001000'}, {campaign_number: '12V009000'}],
    related_models: {available: true, count: 0, models: [], flat_file_only: {count: 1, campaigns: [{campaign_number: '12V004000', nhtsa_model: 'F150', match: 'spelling'}]}}};
  const out = withBuildDates(recalls, 'FORD', 'F-150', 2012, {lookup});
  assert.equal(out.recalls[0].manufactured_from, '2011-01-05');
  assert.match(out.recalls[0].manufactured_range_note, /2 different ranges/);
  assert.equal(out.recalls[1].manufactured_from, null);
  assert.equal(out.recalls[1].manufactured_to, null);
  assert.deepEqual([out.related_models.flat_file_only.campaigns[0].manufactured_from, out.related_models.flat_file_only.campaigns[0].manufactured_to], ['2012-04-01', null]);
  assert.equal(out.build_dates.campaigns, 3);
  assert.equal(out.build_dates.campaigns_with_dates, 2);
  assert.equal(out.build_dates.vin_specific, false);
  assert.equal(out.count, 2);
  // A related CR-V HYBRID campaign gets its range by the CR-V HYBRID label, not the decoded CR-V.
  const crv = withBuildDates({available: true, count: 0, recalls: [], related_models: {available: true, count: 1, models: [{nhtsa_model: 'CR-V HYBRID', match: 'longer_name', recalls: [{campaign_number: '24V744000'}]}]}}, 'HONDA', 'CR-V', 2024, {lookup});
  assert.equal(crv.related_models.models[0].recalls[0].manufactured_to, '2023-06-30');
  // Unavailable recall data and a missing index change nothing they cannot know.
  const down = {available: false, count: null, recalls: []};
  assert.equal(withBuildDates(down, 'FORD', 'F-150', 2012, {lookup}), down);
  const missing = withBuildDates(recalls, 'FORD', 'F-150', 2012, {lookup: () => ({available: false, reason: 'dataset_not_indexed'})});
  assert.deepEqual(missing.build_dates, {available: false, reason: 'dataset_not_indexed'});
  assert.equal('manufactured_from' in missing.recalls[0], false);
});

test('the recall list shows the manufacturer build range with the door-jamb pointer, and nothing when none was filed', () => {
  const {els, run, sources} = frontend();
  const rec = {available: true, count: 2, related_campaigns_found: false, related_models: {available: true, count: 0, models: []}, recalls: [
    {campaign_number: '11V562000', component: 'SERVICE BRAKES', summary: 'Pedal', manufactured_from: '2011-10-17', manufactured_to: '2011-11-23'},
    {campaign_number: '12V009000', component: 'AIR BAGS', summary: 'Inflator', manufactured_from: null, manufactured_to: null}]};
  run(`renderRecalls({recalls:${JSON.stringify(rec)}})`);
  const html = els.get('#recalls-body').innerHTML;
  assert.match(html, /Manufacturer says affected vehicles were built 2011-10-17 to 2011-11-23\. Your build month is on the door-jamb label\./);
  assert.equal(html.match(/Build dates:/g).length, 1);
  assert.match(sources.builtHtml({manufactured_from: '2012-04-01', manufactured_to: null}), /built from 2012-04-01 \(no end date filed\)/);
  assert.equal(sources.builtHtml({manufactured_from: '<b>', manufactured_to: null}).includes('<b>'), false);
  assert.equal(sources.builtHtml({}), '');
});

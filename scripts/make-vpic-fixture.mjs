#!/usr/bin/env node
/**
 * Cut a small test fixture out of data/vpic.db: every row the decode of the given VINs can read (their WMIs and
 * in-year schemas with all their patterns, the vehicle-spec schemas of their make/model/year, the lookups those rows
 * name, defaults, error codes, conversions, valid characters) plus the rule fixes in those schemas, and the expected
 * decode of each VIN on fixed and on pristine rules. The fixture is checked before it is written: each VIN must
 * decode from the cut-down tables exactly as from the full file.
 *
 * Usage: node scripts/make-vpic-fixture.mjs [--db data/vpic.db] [--out tests/fixtures/vpic-mini.json] VIN...
 * tests/vpic-local.test.mjs builds a temporary SQLite file from the fixture (buildFixtureDb below).
 */
import Database from 'better-sqlite3';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {decodeLocal, closeVpicLocal, vinWmi, vinDescriptor} from '../lib/vpic-local.mjs';

/** Write the fixture's tables to a new SQLite file. */
export function buildFixtureDb(fixture, file) {
  const db = new Database(file);
  for (const sql of fixture.schema) db.exec(sql);
  for (const [t, {columns, rows}] of Object.entries(fixture.tables)) {
    const ins = db.prepare(`INSERT INTO ${t} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
    db.transaction(() => { for (const r of rows) ins.run(r); })();
  }
  db.close();
  return file;
}

function cut(dbFile, vins) {
  const db = new Database(dbFile, {readonly: true, fileMustExist: true});
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const sel = {};
  const add = (t, rows) => { const s = sel[t] || (sel[t] = new Map()); for (const r of rows) s.set(JSON.stringify(r), r); };
  const years = new Map();
  for (const vin of vins) { const d = decodeLocal(vin, {file: dbFile}); years.set(vin, d.available ? Number(d.values.ModelYear) || null : null); }
  const lookups = new Set();
  const look = (tbl, id) => { if (tbl && id !== null && id !== undefined) lookups.add(`${tbl}\u0000${id}`); };
  const elements = all('SELECT * FROM element');
  const vt = new Map(elements.map(e => [e.id, e.value_table]));
  const schemaIds = new Set(), wmiIds = new Set(), modelIds = new Set(), makeIds = new Set();
  for (const vin of vins) {
    const w = db.prepare('SELECT * FROM wmi WHERE wmi = ?').get(vinWmi(vin));
    add('vin_descriptor', all('SELECT * FROM vin_descriptor WHERE descriptor = ?', vinDescriptor(vin)));
    add('vin_exception', all('SELECT * FROM vin_exception WHERE vin = ?', vin));
    if (!w) continue;
    add('wmi', [w]); wmiIds.add(w.id);
    look('manufacturer', String(w.manufacturer_id)); look('vehicletype', String(w.vehicle_type_id)); look('make', String(w.make_id));
    const y = years.get(vin);
    // every link: the model-year step counts the WMI's links for the year and for year +- 30
    for (const l of all('SELECT * FROM wmi_vinschema WHERE wmi_id = ?', w.id)) {
      add('wmi_vinschema', [l]);
      add('vinschema', all('SELECT * FROM vinschema WHERE id = ?', l.schema_id));
      if (y !== null && y >= l.year_from && y <= (l.year_to ?? 2999)) schemaIds.add(l.schema_id);
    }
    for (const r of all('SELECT * FROM wmi_make WHERE wmi_id = ?', w.id)) { add('wmi_make', [r]); makeIds.add(r.make_id); look('make', String(r.make_id)); }
    if (y !== null) add('wmi_year_chars', all('SELECT * FROM wmi_year_chars WHERE wmi = ? AND year IN (?, ?, ?)', vinWmi(vin), y, y - 30, y + 30));
  }
  const engineNames = new Set();
  for (const sid of schemaIds) {
    const rows = all('SELECT * FROM pattern WHERE schema_id = ?', sid);
    add('pattern', rows);
    for (const p of rows) {
      look(vt.get(p.element_id), p.attribute_id);
      if (p.element_id === 28) modelIds.add(Number(p.attribute_id));
      if (p.element_id === 18) engineNames.add(String(p.attribute_id ?? '').trim().toLowerCase());
    }
  }
  // rule fixes: the original rows of removed patterns come back in the pristine view, so their lookups are needed too
  const hasFix = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'rule_fix'").get();
  const fixIds = new Set();
  if (hasFix) for (const f of all('SELECT * FROM rule_fix')) if (f.tbl === 'pattern' && schemaIds.has(f.schema_id)) { fixIds.add(f.fix_id); look(vt.get(f.element_id), f.orig_attribute_id); }
  for (const id of modelIds) { look('model', String(id)); for (const r of all('SELECT * FROM make_model WHERE model_id = ?', id)) { add('make_model', [r]); makeIds.add(r.make_id); look('make', String(r.make_id)); } }
  const ems = all('SELECT * FROM engine_model').filter(m => engineNames.has(String(m.name ?? '').trim().toLowerCase()));
  add('engine_model', ems);
  for (const m of ems) { const rows = all('SELECT * FROM engine_model_pattern WHERE engine_model_id = ?', m.id); add('engine_model_pattern', rows); rows.forEach(p => look(vt.get(p.element_id), p.attribute_id)); }
  // vehicle-spec schemas of the makes, models and years
  const vinYears = new Set([...years.values()].filter(y => y !== null));
  for (const ss of all('SELECT * FROM spec_schema')) {
    if (!makeIds.has(ss.make_id)) continue;
    const models = all('SELECT * FROM spec_schema_model WHERE schema_id = ?', ss.id);
    if (!models.some(m => modelIds.has(m.model_id))) continue;
    const yrs = all('SELECT * FROM spec_schema_year WHERE schema_id = ?', ss.id);
    if (yrs.length && !yrs.some(r => vinYears.has(r.year))) continue;
    add('spec_schema', [ss]); add('spec_schema_model', models); add('spec_schema_year', yrs);
    const sps = all('SELECT * FROM spec_schema_pattern WHERE schema_id = ?', ss.id);
    add('spec_schema_pattern', sps);
    for (const sp of sps) {
      const rows = all('SELECT * FROM spec_pattern WHERE spec_schema_pattern_id = ?', sp.id);
      add('spec_pattern', rows); rows.forEach(r => look(vt.get(r.element_id), r.attribute_id));
      if (hasFix) for (const f of all("SELECT * FROM rule_fix WHERE tbl = 'spec_pattern' AND spec_schema_pattern_id = ?", sp.id)) { fixIds.add(f.fix_id); look(vt.get(f.element_id), f.orig_attribute_id); }
    }
  }
  const dvs = all('SELECT * FROM default_value');
  add('default_value', dvs); dvs.forEach(r => look(vt.get(r.element_id), r.default_value));
  add('element', elements); add('error_code', all('SELECT * FROM error_code')); add('conversion', all('SELECT * FROM conversion'));
  add('meta', all('SELECT * FROM meta'));
  if (hasFix && fixIds.size) {
    const ids = [...fixIds];
    add('rule_fix', all(`SELECT * FROM rule_fix WHERE fix_id IN (${ids.map(() => '?').join(',')})`, ...ids));
    add('rule_fix_entry', all(`SELECT * FROM rule_fix_entry WHERE fix_id IN (${ids.map(() => '?').join(',')})`, ...ids));
  }
  for (const k of lookups) { const [tbl, id] = k.split('\u0000'); add('lookup', all('SELECT * FROM lookup WHERE tbl = ? AND id = ?', tbl, id)); }
  const schema = all("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name")
    .map(r => r.sql).filter(s => /^CREATE TABLE/i.test(s) && !/stage_/.test(s)).concat(all("SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").map(r => r.sql));
  const tables = {};
  for (const [t, m] of Object.entries(sel)) {
    const rows = [...m.values()];
    if (!rows.length) continue;
    const columns = Object.keys(rows[0]);
    tables[t] = {columns, rows: rows.map(r => columns.map(c => r[c]))};
  }
  db.close();
  return {schema, tables};
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
  const dbFile = opt('--db', fileURLToPath(new URL('../data/vpic.db', import.meta.url)));
  const out = opt('--out', fileURLToPath(new URL('../tests/fixtures/vpic-mini.json', import.meta.url)));
  const vins = args.map(v => v.toUpperCase());
  if (!vins.length) { console.error('usage: make-vpic-fixture.mjs [--db file] [--out file] VIN...'); process.exit(2); }
  const now = new Date('2026-11-18T00:00:00Z');
  const fixture = {note: 'Cut from NHTSA vPIC release tables by scripts/make-vpic-fixture.mjs; regenerate, do not edit.', now: now.toISOString(), vins, ...cut(dbFile, vins), expected: {}};
  const dir = mkdtempSync(join(tmpdir(), 'vpic-fixture-'));
  try {
    const small = buildFixtureDb(fixture, join(dir, 'vpic.db'));
    for (const vin of vins) {
      const exp = {};
      for (const rules of ['fixed', 'pristine']) {
        const full = decodeLocal(vin, {file: dbFile, rules, now}), mini = decodeLocal(vin, {file: small, rules, now});
        if (JSON.stringify(full.values) !== JSON.stringify(mini.values) || JSON.stringify(full.rule_fixes) !== JSON.stringify(mini.rule_fixes)) {
          const diff = Object.keys(full.values || {}).filter(k => full.values[k] !== mini.values?.[k]).map(k => `${k}: ${full.values[k]} / ${mini.values?.[k]}`);
          throw new Error(`${vin} (${rules}) decodes differently from the fixture: ${diff.join('; ') || mini.reason || 'rule_fixes differ'}`);
        }
        exp[rules] = {values: full.values, rule_fixes: full.rule_fixes};
      }
      fixture.expected[vin] = exp;
    }
  } finally {
    closeVpicLocal();
    rmSync(dir, {recursive: true, force: true});
  }
  const text = JSON.stringify(fixture);
  writeFileSync(out, text + '\n');
  console.log(JSON.stringify({out, bytes: text.length, vins: vins.length, rows: Object.fromEntries(Object.entries(fixture.tables).map(([t, v]) => [t, v.rows.length]))}));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();

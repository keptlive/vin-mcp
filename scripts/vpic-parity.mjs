#!/usr/bin/env node
/**
 * Parity of lib/vpic-local.mjs with NHTSA's own decoder (vpic.spvindecode in the PostgreSQL edition of the release),
 * on NHTSA's pristine rules (the fixed file read with rules 'pristine'). Used by scripts/vpic-refresh.sh.
 *
 *   node scripts/vpic-parity.mjs sample --db vpic.db --out vins.txt [--n 20000] [--seed 1] [--evidence data/decode-evidence.db]
 *       VINs synthesised from the release's own patterns (WMI + model keys + year + valid characters; 95% with a
 *       correct check digit), single-character mutations of those, and the NHTSA test-vehicle VINs when --evidence
 *       is given. No VIN anyone looked up on the site.
 *   node scripts/vpic-parity.mjs compare --db vpic.db --pg DIR --out result.json
 *       DIR holds CSV rows (vin, element id, value, source, pattern id, keys, schema id) from spvindecode, as
 *       scripts/vpic-refresh.sh writes them. Every element of every VIN is compared; prints a summary, exit 1 on any
 *       disagreement.
 */
import Database from 'better-sqlite3';
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {decodeLocal, vinCheckDigit} from '../lib/vpic-local.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };

function sample() {
  const dbFile = opt('--db'), outFile = opt('--out'), N = Number(opt('--n', 20000)), evidence = opt('--evidence', null);
  let seed = Number(opt('--seed', 1));
  const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  const VALID = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
  const YEAR = y => 'ABCDEFGHJKLMNPRSTVWXY123456789'[(y - 1980) % 30];
  const db = new Database(dbFile, {readonly: true});
  const links = db.prepare('SELECT w.wmi, w.vehicle_type_id vt, w.truck_type_id tt, ws.schema_id, ws.year_from, ws.year_to FROM wmi_vinschema ws JOIN wmi w ON w.id = ws.wmi_id').all();
  const pats = db.prepare('SELECT keys FROM pattern WHERE schema_id = ? AND element_id = 28');
  const anyPats = db.prepare('SELECT keys FROM pattern WHERE schema_id = ? LIMIT 200');
  const chars = db.prepare('SELECT chars FROM wmi_year_chars WHERE wmi = ? AND year = ?');
  const maxYear = new Date().getUTCFullYear() + 1;
  const fillKey = keys => {
    const out = [];
    for (let i = 0; i < keys.length; i++) {
      const c = keys[i];
      if (c === '[') {
        const j = keys.indexOf(']', i);
        let rx; try { rx = new RegExp(`^${keys.slice(i, j + 1)}$`); } catch { rx = null; }
        const ok = rx ? [...VALID].filter(x => rx.test(x)) : [];
        out.push(ok.length ? pick(ok) : pick([...VALID]));
        i = j;
      } else if (c === '*' || c === '_') out.push(null);
      else if (c === '#') out.push(pick([...'0123456789']));
      else out.push(c);
    }
    return out;
  };
  const synth = link => {
    const yTo = Math.min(link.year_to ?? maxYear, maxYear), yFrom = Math.max(link.year_from, 1981);
    if (yTo < yFrom) return null;
    const y = yFrom + Math.floor(rnd() * (yTo - yFrom + 1));
    let ps = pats.all(link.schema_id);
    if (!ps.length) ps = anyPats.all(link.schema_id);
    const filled = fillKey(ps.length ? pick(ps).keys : '*****');
    const enc = chars.get(link.wmi, y)?.chars?.split(',') || [];
    const allowedAt = p => (enc[p - 4] ? [...enc[p - 4]].filter(c => VALID.includes(c)) : []);
    const v = new Array(17).fill(null);
    for (let i = 0; i < 3; i++) v[i] = link.wmi[i];
    let p = 4;
    for (const c of filled) {
      if (p === 9) { p = 10; if (c === '|' || c === null) continue; }
      if (c === '|') { p = 10; continue; }
      if (p > 17) break;
      v[p - 1] = c; p++;
    }
    v[9] = YEAR(y);
    const carLt = [2, 7].includes(link.vt) || (link.vt === 3 && link.tt === 1);
    if (carLt && v[6] === null) v[6] = y >= 2010 ? pick([...'ABCDEFGHJKLMNPRSTUVWXYZ']) : pick([...'0123456789']);
    if (link.wmi.length === 6) { v[11] = link.wmi[3]; v[12] = link.wmi[4]; v[13] = link.wmi[5]; }
    for (let i = 3; i < 17; i++) {
      if (v[i] !== null || i === 8) continue;
      const al = allowedAt(i + 1);
      v[i] = i >= 11 ? pick([...'0123456789']) : al.length && rnd() < 0.9 ? pick(al) : pick([...VALID]);
    }
    v[8] = '0';
    const vin = v.join('');
    const cd = vinCheckDigit(vin, {variant: 2, carMpvLt: carLt});
    return vin.slice(0, 8) + (rnd() < 0.95 && cd.length === 1 && cd !== '?' ? cd : pick([...'0123456789X'])) + vin.slice(9);
  };
  const out = new Set();
  if (evidence) for (const r of new Database(evidence, {readonly: true}).prepare('SELECT vin FROM vehicles').all()) if (/^[A-Z0-9]{17}$/.test(r.vin)) out.add(r.vin);
  const base = out.size;
  let tries = 0;
  while (out.size < base + N && tries < N * 5) { tries++; const vin = synth(pick(links)); if (vin && vin.length === 17) out.add(vin); }
  const list = [...out];
  for (let i = 0; i < Math.round(N / 20); i++) { const v = pick(list).split(''); v[pick([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])] = pick([...VALID, 'I', 'O', 'Q']); out.add(v.join('')); }
  writeFileSync(outFile, [...out].join('\n') + '\n');
  console.log(JSON.stringify({out: outFile, vins: out.size, test_vehicles: base}));
}

function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

function compare() {
  const dbFile = opt('--db'), dir = opt('--pg'), outFile = opt('--out');
  const pg = new Map();
  for (const fn of readdirSync(dir).filter(f => f.endsWith('.csv')).sort()) {
    for (const [vin, el, value, source] of parseCsv(readFileSync(`${dir}/${fn}`, 'utf8'))) {
      if (!pg.has(vin)) pg.set(vin, []);
      pg.get(vin).push({el: Number(el), value, source});
    }
  }
  const perEl = {}, examples = {};
  let n = 0, agree = 0, pgErrors = 0, localFail = 0, ms = 0;
  for (const [vin, rows] of pg) {
    if (rows.some(r => r.el === -1)) { pgErrors++; continue; }
    const t = process.hrtime.bigint();
    const d = decodeLocal(vin, {file: dbFile, semantics: 'pg', rules: 'pristine'});
    ms += Number(process.hrtime.bigint() - t) / 1e6;
    n++;
    if (!d.available) { localFail++; continue; }
    const A = new Map(), B = new Map();
    for (const r of rows) { if (!A.has(r.el)) A.set(r.el, []); A.get(r.el).push(r.value ?? ''); }
    for (const e of d.elements) { if (!B.has(e.element_id)) B.set(e.element_id, []); B.get(e.element_id).push(e.value ?? ''); }
    let ok = true;
    for (const el of new Set([...A.keys(), ...B.keys()])) {
      const a = (A.get(el) || []).slice().sort().join(' | '), b = (B.get(el) || []).slice().sort().join(' | ');
      const s = perEl[el] || (perEl[el] = {n: 0, agree: 0});
      s.n++;
      if (a === b) { s.agree++; continue; }
      ok = false;
      const ex = examples[el] || (examples[el] = []);
      if (ex.length < 10) ex.push({vin, nhtsa: a.slice(0, 160), local: b.slice(0, 160)});
    }
    if (ok) agree++;
  }
  const out = {db: dbFile, rules: 'pristine', semantics: 'pg', vins: n, all_elements_agree: agree, nhtsa_errors: pgErrors, local_failed: localFail,
    ms_per_vin: +(ms / Math.max(n, 1)).toFixed(2), disagreeing_elements: Object.fromEntries(Object.entries(perEl).filter(([, s]) => s.agree !== s.n).map(([k, s]) => [k, s.n - s.agree])), examples};
  if (outFile) writeFileSync(outFile, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({vins: n, all_elements_agree: agree, nhtsa_errors: pgErrors, local_failed: localFail, ms_per_vin: out.ms_per_vin, disagreeing_elements: out.disagreeing_elements}));
  process.exit(agree === n && localFail === 0 && n > 0 ? 0 : 1);
}

if (cmd === 'sample') sample();
else if (cmd === 'compare') compare();
else { console.error('usage: vpic-parity.mjs sample|compare ... (see the header)'); process.exit(2); }

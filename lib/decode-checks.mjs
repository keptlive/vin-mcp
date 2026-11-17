/**
 * Checks on the VIN decode, field by field. The official decode (NHTSA vPIC) is never overwritten: each checked
 * field says whether an independent record confirms it, corrects it, doubts it or fills a blank, keeps vPIC's
 * value visible, and says why. The report's matchers (fuel economy, EPA test cars, NHTSA test-vehicle tires and
 * capacities) use the checked values: a corrected or filled value, and nothing for a doubtful one (they widen to
 * the range of configurations).
 *
 * Why: the decode audit of 2026-11-17 compared vPIC's decode of 2,454 NHTSA test vehicles with NHTSA's own lab
 * record of each vehicle. vPIC decodes a VIN pattern (positions 1-8, model year, plant), and some patterns are
 * decoded wrong for every VIN that shares them (a front-drive 2014 RDX decoded AWD, a 2012 Regal eAssist with no
 * mild-hybrid flag, a 2019 C300 with the 7-speed of earlier years).
 *
 * Sources, in order of precedence (PRECEDENCE; a higher tier decides, the others stay in `candidates`):
 *   owner                       what the reader states about their own vehicle (passed in by the caller)
 *   manufacturer_vin_record     the manufacturer's own description of this exact VIN, from the recall-lookup reply
 *                               the site already fetches (lib/manufacturer-description.mjs)
 *   nhtsa_test_vehicle_pattern  NHTSA's lab records of tested vehicles with the same VIN pattern
 *                               (data/decode-evidence.db, scripts/import-decode-evidence.py)
 *   vpic_decode                 the official decode
 *   assumption                  EPA lists only one value for this model and year
 * EPA's list of configurations for the model and year (lib/decode-epa.mjs) is a cross-check, not a source: a
 * decoded value EPA lists for no configuration is doubtful.
 *
 * Statuses: confirmed (an independent record agrees), corrected (a strong rule replaced the value; the original
 * is kept), doubtful (show both; matchers widen), filled (vPIC was blank), unverified (no record to check
 * against), unknown (no value anywhere).
 * Correction rules: the manufacturer's VIN record; two or more NHTSA test vehicles of the pattern that agree (and
 * none that differ); or one test vehicle plus EPA listing the tested value and not vPIC's (alone or in vPIC's
 * combination). Anything weaker is doubtful.
 */
import Database from 'better-sqlite3';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {epaOffers} from './decode-epa.mjs';
import {vinDrive, vinTransmission, vinPowertrain} from './fueleconomy-match.mjs';

export const DECODE_EVIDENCE_FILE = fileURLToPath(new URL('../data/decode-evidence.db', import.meta.url));
export const PRECEDENCE = ['owner', 'manufacturer_vin_record', 'nhtsa_test_vehicle_pattern', 'vpic_decode', 'assumption'];
export const STATUSES = ['confirmed', 'corrected', 'doubtful', 'filled', 'unverified', 'unknown'];

export const FIELDS = [
  {key: 'drive', label: 'Drive type', decoded: 'transmission.drive_type', epa: true, matcher: true},
  {key: 'engine_size', label: 'Engine size', decoded: 'engine.displacement_l', epa: true, matcher: true},
  {key: 'cylinders', label: 'Cylinders', decoded: 'engine.cylinders', epa: true, matcher: true},
  {key: 'powertrain', label: 'Fuel and electrification', decoded: 'engine.fuel_type, engine.ev_type', epa: true, matcher: true},
  {key: 'transmission', label: 'Transmission', decoded: 'transmission.type', epa: true, matcher: true},
  {key: 'speeds', label: 'Transmission speeds', decoded: 'transmission.speeds', epa: true, matcher: true},
  {key: 'seats', label: 'Seats', decoded: 'raw_nhtsa.Seats', epa: false, matcher: false},
  // GVWR varies with options inside one VIN pattern: one test vehicle with another class is a note, not a doubt.
  {key: 'gvwr_class', label: 'GVWR class', decoded: 'dimensions.gvwr', epa: false, matcher: false, minDoubt: 2, noCorrect: true},
];
const FIELD = Object.fromEntries(FIELDS.map(f => [f.key, f]));

const DRIVE_LABEL = {all: 'all-wheel or four-wheel drive', front: 'front-wheel drive', rear: 'rear-wheel drive', two: 'two-wheel drive'};
const TRANS_LABEL = {auto: 'automatic', manual: 'manual', cvt: 'CVT (continuously variable)', am: 'dual-clutch or automated manual', single: 'single-speed'};
const POWER_LABEL = {ev: 'battery-electric', phev: 'plug-in hybrid', hev: 'hybrid', mhev: 'mild hybrid', hybrid: 'hybrid (full, mild or plug-in not stated)', diesel: 'diesel', gas: 'gasoline', ffv: 'flex-fuel', cng: 'natural gas'};
const TIER_LABEL = {owner: 'you', manufacturer_vin_record: 'the manufacturer\'s record of this VIN', nhtsa_test_vehicle_pattern: 'NHTSA test vehicles with the same VIN pattern',
  vpic_decode: 'the official decode (NHTSA vPIC)', assumption: 'EPA\'s list for this model and year'};
const CLASS_ORDER = ['1A', '1B', '1C', '1D', '2E', '2F', '2G', '2H', '3', '4', '5', '6', '7', '8'];
const CLASS_MAX_LB = {'1A': 3000, '1B': 4000, '1C': 5000, '1D': 6000, '2E': 7000, '2F': 8000, '2G': 9000, '2H': 10000, 3: 14000, 4: 16000, 5: 19500, 6: 26000, 7: 33000, 8: Infinity};
const KG_PER_LB = 0.45359237;

/** VIN pattern: positions 1-8, 10 (model year) and 11 (plant), the check digit as '*'. */
export function patternKey(vin) {
  const v = String(vin || '').trim().toUpperCase();
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(v) ? `${v.slice(0, 8)}*${v.slice(9, 11)}` : null;
}

export function label(field, code) {
  if (code === null || code === undefined) return null;
  if (field === 'drive') return DRIVE_LABEL[code] || String(code);
  if (field === 'transmission') return TRANS_LABEL[code] || String(code);
  if (field === 'powertrain') return POWER_LABEL[code] || String(code);
  if (field === 'engine_size') return code === 0 ? 'no engine (electric)' : `${Number(code).toFixed(1)} L`;
  if (field === 'speeds') return `${code}-speed`;
  if (field === 'gvwr_class') return Array.isArray(code) ? `Class ${code[0]} to ${code[code.length - 1]}` : `Class ${code}`;
  return String(code);
}

const num = v => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** vPIC GVWR class(es): "Class 1C: 4,001 - 5,000 lb" -> ['1C']; a "Class 1" or a GVWR_to range spans several. */
export function vpicGvwrClasses(decoded) {
  const out = [];
  for (const t of [decoded?.dimensions?.gvwr, decoded?.dimensions?.gvwr_to]) {
    const m = String(t || '').match(/^Class (\d[A-H]?)\b/);
    if (m) out.push(...({1: ['1A', '1B', '1C', '1D'], 2: ['2E', '2F', '2G', '2H']}[m[1]] || [m[1]]));
  }
  const idx = out.map(c => CLASS_ORDER.indexOf(c)).filter(i => i >= 0);
  return idx.length ? CLASS_ORDER.slice(Math.min(...idx), Math.max(...idx) + 1) : null;
}

/** vPIC's value of each checked field, normalized, plus vPIC's own text. */
export function vpicValues(decoded) {
  const e = decoded?.engine || {}, t = decoded?.transmission || {}, raw = decoded?.raw || {};
  const driveText = t.drive_type || null;
  const either = /2WD\s*\/\s*4WD|4WD\s*\/\s*2WD|4x2\s*\/\s*4x4|4x4\s*\/\s*4x2/i.test(String(driveText || ''));
  const tr = vinTransmission(decoded);
  const size = num(e.displacement_l), cyl = num(e.cylinders), seats = num(raw.Seats);
  const classes = vpicGvwrClasses(decoded);
  const power = vinPowertrain(decoded);
  return {
    drive: {code: either ? null : vinDrive(decoded), text: driveText, either},
    engine_size: {code: size && size > 0 ? Math.round(size * 10) / 10 : null, text: e.displacement_l ?? null},
    cylinders: {code: cyl && cyl > 0 ? Math.round(cyl) : null, text: e.cylinders ?? null},
    powertrain: {code: power, text: [e.fuel_type, raw.FuelTypeSecondary, e.ev_type].filter(Boolean).join(', ') || null},
    transmission: {code: tr.kind, text: t.type || null},
    speeds: {code: tr.kind && tr.kind !== 'cvt' && num(t.speeds) ? num(t.speeds) : null, text: t.speeds ?? null},
    seats: {code: seats && seats > 0 ? seats : null, text: raw.Seats ?? null},
    gvwr_class: {code: classes ? (classes.length === 1 ? classes[0] : classes) : null, text: decoded?.dimensions?.gvwr ?? null},
  };
}

/** Do two normalized values of a field describe the same vehicle? (a more general value agrees with a specific one) */
export function same(field, a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (field === 'gvwr_class') { const A = [].concat(a), B = [].concat(b); return A.some(x => B.includes(x)); }
  if (a === b) return true;
  if (field === 'engine_size') return Math.abs(a - b) <= 0.1 + 1e-9;
  if (field === 'drive') return (a === 'two' && ['front', 'rear'].includes(b)) || (b === 'two' && ['front', 'rear'].includes(a));
  if (field === 'transmission') {
    const g = new Set([a, b]);
    return (g.has('auto') && (g.has('cvt') || g.has('am') || g.has('single'))) || (g.has('single') && g.has('cvt'));
  }
  if (field === 'powertrain') {
    // "hybrid" (a test title that names a hybrid without saying which kind) agrees with any hybrid.
    if ((a === 'hybrid' && ['hev', 'mhev', 'phev'].includes(b)) || (b === 'hybrid' && ['hev', 'mhev', 'phev'].includes(a))) return true;
    const g = [a, b].sort().join('|'); return ['ffv|gas', 'cng|gas', 'hev|mhev'].includes(g);
  }
  return false;
}
const specificity = (field, v) => (field === 'drive' && v === 'two') || (field === 'transmission' && v === 'auto') || (field === 'powertrain' && v === 'hybrid') || (field === 'gvwr_class' && Array.isArray(v) && v.length > 1) ? 0 : 1;

// ---- EPA cross-check (lib/decode-epa.mjs gives the configurations of the model and year) ----

/** Does EPA list this value of the field for the model and year? true, false, or null (cannot tell). */
export function epaLists(field, code, epa) {
  if (!epa?.available || code === null || code === undefined) return null;
  const b = epa.broad;
  if (field === 'drive') {
    if (!b.drives.length) return null;
    const hit = b.drives.includes(code) || (code === 'two' && b.drives.some(d => ['front', 'rear', 'two'].includes(d))) || (b.drives.includes('two') && ['front', 'rear'].includes(code));
    return hit ? true : b.unknown.drive ? null : false;
  }
  if (field === 'engine_size') {
    if (code === 0) return b.powertrains.includes('ev') ? true : null;
    if (!b.sizes.length) return null;
    return b.sizes.some(s => Math.abs(s - code) <= 0.1 + 1e-9) ? true : b.unknown.size ? null : false;
  }
  if (field === 'cylinders') {
    if (!b.cylinders.length || !code) return null;
    return b.cylinders.includes(code) ? true : b.unknown.cylinders ? null : false;
  }
  if (field === 'powertrain') {
    const p = new Set(b.powertrains);
    if (!p.size) return null;
    if (code === 'gas') return p.has('gas') || p.has('ffv');
    if (code === 'ffv') return p.has('ffv') || p.has('gas');
    if (code === 'hev' || code === 'mhev') return p.has('hev') || p.has('mhev');
    if (code === 'hybrid') return p.has('hev') || p.has('mhev') || p.has('phev');
    return p.has(code);
  }
  if (field === 'transmission') {
    const kinds = new Set(b.transmissions.map(t => t.kind).filter(Boolean));
    if (!kinds.size) return null;
    if (code === 'auto' || code === 'single') return kinds.has('auto') || kinds.has('am') || kinds.has('cvt');
    if (code === 'am') return kinds.has('am') || kinds.has('auto');
    return kinds.has(code);
  }
  if (field === 'speeds') {
    const sp = new Set(b.transmissions.filter(t => t.kind !== 'cvt' && t.speeds).map(t => t.speeds));
    if (!sp.size || !code) return null;
    return sp.has(code);
  }
  return null;
}

const TUPLE = {drive: 'drive', engine_size: 'size', cylinders: 'cylinders', powertrain: 'powertrain', transmission: 'transmission', speeds: 'speeds'};
function fits(cfg, want) {
  for (const [k, v] of Object.entries(want)) {
    if (v === null || v === undefined) continue;
    const c = cfg[k];
    if (c === null || c === undefined) continue;
    if (k === 'drive') { if (!(v === c || (v === 'two' && ['front', 'rear'].includes(c)) || (c === 'two' && ['front', 'rear'].includes(v)))) return false; }
    else if (k === 'size') { if (Math.abs(c - v) > 0.1 + 1e-9) return false; }
    else if (k === 'powertrain') { if (!(v === c || (v === 'gas' && c === 'ffv') || (v === 'ffv' && c === 'gas') || (['hev', 'mhev', 'hybrid'].includes(v) && ['hev', 'mhev', 'phev'].includes(c)))) return false; }
    else if (k === 'transmission') { if (!(v === c || (['auto', 'single'].includes(v) && ['am', 'cvt', 'auto'].includes(c)) || (v === 'am' && c === 'auto'))) return false; }
    else if (v !== c) return false;
  }
  return true;
}
/** Is a combination of values (field -> code) listed by EPA as one configuration? true / false / null. */
export function epaListsCombination(values, epa) {
  if (!epa?.available || !epa.configs?.length) return null;
  const want = {};
  for (const [f, v] of Object.entries(values)) if (TUPLE[f] && v !== null && v !== undefined) want[TUPLE[f]] = f === 'engine_size' && v === 0 ? null : v;
  if (Object.keys(want).length < 2) return null;
  return epa.configs.some(c => fits(c, want));
}

// ---- NHTSA test-vehicle evidence ----

let evidenceDb = null, evidenceDbFile = null;
function openEvidence(file) {
  if (evidenceDb && evidenceDbFile === file) return evidenceDb;
  if (!existsSync(file)) return null;
  evidenceDb = new Database(file, {readonly: true, fileMustExist: true});
  evidenceDbFile = file;
  return evidenceDb;
}
const parse = (v, d = null) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const rowOut = r => ({vin: r.vin, model_year: r.model_year, make: r.make, model: r.model, title: r.title, tests: parse(r.tests, []), values: parse(r.vals, {}),
  withheld: parse(r.withheld, null), own_decode_errors: parse(r.own_decode_errors, null)});

/** The test vehicles sharing this VIN's pattern (never the VIN itself), or {available:false}. */
export function patternEvidence(vin, {file = DECODE_EVIDENCE_FILE} = {}) {
  const pattern = patternKey(vin);
  if (!pattern) return {available: false, reason: 'invalid_vin', vehicles: []};
  let db;
  try { db = openEvidence(file); } catch (err) { console.error('[decode-checks] evidence index unreadable:', err.message); return {available: false, reason: 'index_unreadable', pattern, vehicles: []}; }
  if (!db) return {available: false, reason: 'dataset_not_indexed', pattern, vehicles: []};
  try {
    const rows = db.prepare('SELECT * FROM vehicles WHERE pattern = ? AND vin <> ? ORDER BY model_year, id').all(pattern, String(vin).toUpperCase());
    return {available: true, pattern, vehicles: rows.map(rowOut)};
  } catch (err) {
    console.error('[decode-checks] evidence lookup failed:', err.message);
    return {available: false, reason: 'index_unreadable', pattern, vehicles: []};
  }
}

let ownErrors = null;
/** Corrections to an NHTSA test vehicle's own vPIC decode, by crash test number (for the tire-placard matcher). */
export function testVehicleDecodeErrors(testNo, {file = DECODE_EVIDENCE_FILE} = {}) {
  if (!Number.isInteger(Number(testNo))) return null;
  if (!ownErrors) {
    ownErrors = new Map();
    try {
      const db = openEvidence(file);
      if (db) for (const r of db.prepare('SELECT t.test_no, v.own_decode_errors FROM test_numbers t JOIN vehicles v ON v.id = t.vehicle_id WHERE v.own_decode_errors IS NOT NULL').all())
        ownErrors.set(r.test_no, parse(r.own_decode_errors, null));
    } catch (err) { console.error('[decode-checks] evidence index unreadable:', err.message); }
  }
  return ownErrors.get(Number(testNo)) || null;
}
const VPIC_DRIVE_TEXT = {front: 'FWD/Front-Wheel Drive', rear: 'RWD/Rear-Wheel Drive', all: 'AWD/All-Wheel Drive', two: '4x2'};
/** A tire-placard/test-vehicle row with its drive and electrification as NHTSA's lab recorded them, where vPIC's
 * decode of that test vehicle was found wrong. Pure apart from the cached index read. */
export function fixTestVehicleRow(row) {
  const errs = row && Number.isInteger(row.test_no) ? testVehicleDecodeErrors(row.test_no) : null;
  if (!errs) return row;
  const out = {...row};
  if (errs.drive && VPIC_DRIVE_TEXT[errs.drive.right]) out.drive_type = VPIC_DRIVE_TEXT[errs.drive.right];
  if (errs.powertrain) {
    Object.assign(out, powertrainFields(errs.powertrain.right, row.fuel_type));
    if ('powertrain' in row) out.powertrain = errs.powertrain.right === 'ev' ? 'battery_electric' : 'not_battery_electric';
  }
  return out;
}

function powertrainFields(code, fuel) {
  if (code === 'ev') return {fuel_type: 'Electric', ev_type: 'BEV (Battery Electric Vehicle)'};
  if (code === 'phev') return {fuel_type: fuel || 'Gasoline', ev_type: 'PHEV (Plug-in Hybrid Electric Vehicle)'};
  if (code === 'hev' || code === 'hybrid') return {fuel_type: fuel || 'Gasoline', ev_type: 'HEV (Hybrid Electric Vehicle)'};
  if (code === 'mhev') return {fuel_type: fuel || 'Gasoline', ev_type: 'Mild Hybrid (MHEV)'};
  if (code === 'diesel') return {fuel_type: 'Diesel', ev_type: null};
  if (code === 'gas') return {fuel_type: 'Gasoline', ev_type: null};
  if (code === 'ffv') return {fuel_type: 'Gasoline', ev_type: null};
  return {fuel_type: null, ev_type: null};
}

// ---- the checks ----

const OWNER_CODES = {transmission: {automatic: 'auto', auto: 'auto', manual: 'manual', cvt: 'cvt', dct: 'am', am: 'am'},
  drive: {awd: 'all', '4wd': 'all', all: 'all', fwd: 'front', front: 'front', rwd: 'rear', rear: 'rear'}};
/** Owner-stated values, normalized; unknown keys and values are dropped. */
export function ownerValues(owner) {
  const out = {};
  if (!owner || typeof owner !== 'object') return out;
  for (const [k, v] of Object.entries(owner)) {
    const map = OWNER_CODES[k];
    const code = map ? map[String(v).toLowerCase()] : null;
    if (code) out[k] = code;
  }
  return out;
}

const MANUFACTURER_FIELDS = {drive: 'drive', engine_size: 'engine_size_l', cylinders: 'cylinders', powertrain: 'powertrain', transmission: 'transmission', speeds: 'speeds'};

/**
 * Check a decode. Pure: pass the evidence (patternEvidence), EPA configurations (epaOffers) and, when known, the
 * manufacturer description (lib/manufacturer-description.mjs) and owner-stated values.
 * `manufacturer`: the recall-status `manufacturer_description` block, or {available:false, reason}, or null when
 * the manufacturer was not checked (the VIN page builds before the manufacturer replies).
 */
export function checkDecode(decoded, {vin = null, evidence = null, epa = null, manufacturer = null, owner = null} = {}) {
  const vp = vpicValues(decoded);
  const ownerV = ownerValues(owner);
  const mfrParsed = manufacturer?.available ? manufacturer.parsed || {} : {};
  const vehicles = evidence?.available ? evidence.vehicles : [];
  const vpicDriveText = String(vp.drive.text || '');
  const fields = [];
  const vpicTuple = Object.fromEntries(Object.keys(TUPLE).map(f => [f, vp[f].code]));
  const comboListed = epaListsCombination(vpicTuple, epa);

  for (const f of FIELDS) {
    const k = f.key, v = vp[k];
    const out = {field: k, label: f.label, decoded_field: f.decoded, original: v.text ?? null, original_value: v.code, shown: null, shown_value: null,
      status: null, basis: null, rule: null, note: null, evidence: {}, candidates: []};
    // Tier values
    const ownerCode = ownerV[k] ?? null;
    const mfrCode = MANUFACTURER_FIELDS[k] ? mfrParsed[MANUFACTURER_FIELDS[k]] ?? null : null;
    // Pattern evidence, grouped by agreement
    const ev = [];
    for (const veh of vehicles) {
      const x = veh.values?.[k];
      if (!x || x.value === null || x.value === undefined) continue;
      let value = x.value;
      if (k === 'engine_size' && value === 0 && v.code === null) continue; // electric, and vPIC gives no engine: nothing to compare
      // Older NHTSA data sheets write the driven axle ("Rear") for part-time 4WD trucks: not a contradiction.
      if (k === 'drive' && value === 'rear' && v.code === 'all' && /4WD|4x4/i.test(vpicDriveText) && !/AWD|All-Wheel/i.test(vpicDriveText)) continue;
      if (k === 'transmission' && value === 'single') value = 'auto';
      const t = veh.tests?.[0] || {};
      ev.push({value, disputed: !!x.disputed, test_no: t.test_no ?? null, report_url: t.report_url ?? null, model_year: veh.model_year, title: veh.title, source: x.sources?.[0] ?? null});
    }
    const groups = [];
    for (const e of ev) {
      const g = groups.find(g => same(k, g.value, e.value));
      if (g) { g.items.push(e); if (specificity(k, e.value) > specificity(k, g.value)) g.value = e.value; }
      else groups.push({value: e.value, items: [e]});
    }
    const patternCode = groups.length === 1 ? groups[0].value : null;
    const nStrong = groups.length === 1 ? groups[0].items.filter(e => !e.disputed).length : 0;
    if (ev.length) out.evidence.test_vehicles = ev.slice(0, 6).map(({disputed, ...e}) => ({...e, value_label: label(k, e.value), ...(disputed ? {disputed: true} : {})}));
    // EPA
    const epaV = f.epa ? epaLists(k, v.code, epa) : null;
    const epaP = f.epa && patternCode !== null ? epaLists(k, patternCode, epa) : null;
    let comboP = null;
    if (f.epa && patternCode !== null && v.code !== null) {
      const alt = {...vpicTuple, [k]: patternCode};
      if (k === 'transmission' && patternCode === 'manual') alt.speeds = null;
      comboP = epaListsCombination(alt, epa);
    }
    if (f.epa && epa?.available) out.evidence.epa = {lists_decoded_value: epaV, ...(patternCode !== null ? {lists_test_vehicle_value: epaP} : {}), model_names: epa.models?.slice(0, 4) ?? []};
    // Candidates in precedence order
    if (ownerCode !== null) out.candidates.push({tier: 'owner', value: ownerCode, value_label: label(k, ownerCode)});
    if (mfrCode !== null) out.candidates.push({tier: 'manufacturer_vin_record', value: mfrCode, value_label: label(k, mfrCode), words: manufacturer.parsed_from?.[MANUFACTURER_FIELDS[k]] ?? null});
    for (const g of groups) out.candidates.push({tier: 'nhtsa_test_vehicle_pattern', value: g.value, value_label: label(k, g.value), vehicles: g.items.length});
    if (v.code !== null) out.candidates.push({tier: 'vpic_decode', value: v.code, value_label: label(k, v.code)});

    const decide = (status, shownCode, basis, rule, note) => Object.assign(out, {status, shown_value: shownCode, shown: shownCode === null ? null : label(k, shownCode), basis, rule, note});
    const fromTier = (tier, code, what) => {
      if (v.code === null) return decide('filled', code, tier, tier, `${cap(what)} gives ${label(k, code)}; the official decode leaves this blank${v.either ? ' ("2WD/4WD": either)' : ''}.`);
      if (same(k, code, v.code)) return decide('confirmed', specificity(k, code) > specificity(k, v.code) ? code : v.code, tier, tier, `${cap(what)} agrees with the official decode.`);
      return decide('corrected', code, tier, tier, `${cap(what)} gives ${label(k, code)}; the official decode says ${label(k, v.code)}.`);
    };

    if (ownerCode !== null) fromTier('owner', ownerCode, 'you');
    else if (mfrCode !== null) fromTier('manufacturer_vin_record', mfrCode, 'the manufacturer\'s record of this VIN');
    else if (groups.length > 1 && f.minDoubt) {
      decide(v.code === null ? 'unknown' : 'unverified', v.code, v.code === null ? null : 'vpic_decode', 'pattern_varies_note', `NHTSA tested vehicles with this VIN pattern that differ: ${groups.map(g => `${label(k, g.value)} (${g.items.length})`).join(', ')}.`);
    } else if (groups.length > 1) {
      const list = groups.map(g => `${label(k, g.value)} (${g.items.length})`).join(', ');
      decide('doubtful', v.code, 'nhtsa_test_vehicle_pattern', 'pattern_varies', `NHTSA tested vehicles with this VIN pattern that differ: ${list}. The pattern covers more than one version, so this VIN's ${f.label.toLowerCase()} is not settled by the decode.`);
    } else if (groups.length === 1) {
      const p = patternCode, n = groups[0].items.length;
      const tv = n === 1 ? 'NHTSA\'s test vehicle with the same VIN pattern' : `${n} NHTSA test vehicles with the same VIN pattern`;
      if (v.code === null) {
        if (nStrong >= 1 && epaP !== false) decide('filled', p, 'nhtsa_test_vehicle_pattern', 'test_vehicle_fill', `From ${tv}: ${label(k, p)}. The official decode leaves this blank${v.either ? ' ("2WD/4WD": either)' : ''}.`);
        else decide(v.either ? 'doubtful' : 'unknown', null, null, null, v.either ? 'The official decode says "2WD/4WD" (either).' : null);
      } else if (same(k, p, v.code)) {
        // The test vehicles may state it more precisely (front for vPIC's 4x2): used when two agree or EPA lists it.
        const refine = specificity(k, p) > specificity(k, v.code) && (nStrong >= 2 || !f.epa || epaP === true);
        decide('confirmed', refine ? p : v.code, 'nhtsa_test_vehicle_pattern', 'test_vehicle_agrees', `${cap(tv)} recorded ${label(k, p)}.`);
      } else if (f.minDoubt && nStrong < f.minDoubt) {
        decide('unverified', v.code, 'vpic_decode', 'test_vehicle_differs_note', `${cap(tv)} had ${label(k, p)}; this varies with options within one VIN pattern, so the official decode stands.`);
      } else if (f.noCorrect) {
        decide('doubtful', v.code, 'nhtsa_test_vehicle_pattern', 'test_vehicle_differs', `${cap(tv)} recorded ${label(k, p)}; the official decode says ${label(k, v.code)}. Both are shown.`);
      } else if (nStrong >= 2 && nStrong === n) {
        decide('corrected', p, 'nhtsa_test_vehicle_pattern', 'two_test_vehicles', `${cap(tv)} recorded ${label(k, p)}; the official decode says ${label(k, v.code)}.`);
      } else if (nStrong >= 1 && f.epa && ((epaV === false && epaP === true) || (comboListed === false && comboP === true))) {
        const why = epaV === false && epaP === true ? `EPA lists ${label(k, p)} and no ${label(k, v.code)} for this model and year` : 'EPA lists the tested value, and no configuration with the official decode\'s combination, for this model and year';
        decide('corrected', p, 'nhtsa_test_vehicle_pattern', 'test_vehicle_and_epa', `${cap(tv)} recorded ${label(k, p)}, and ${why}; the official decode says ${label(k, v.code)}.`);
      } else {
        decide('doubtful', v.code, 'nhtsa_test_vehicle_pattern', 'test_vehicle_differs', `${cap(tv)} recorded ${label(k, p)}; the official decode says ${label(k, v.code)}. Both are shown.`);
      }
    } else if (v.either) {
      decide('doubtful', null, 'vpic_decode', 'vpic_either', 'The official decode says "2WD/4WD": either.');
    } else if (v.code === null) {
      const only = f.epa && epa?.available ? epaOnly(k, epa) : null;
      if (only !== null) decide('filled', only, 'assumption', 'epa_only_value', `EPA lists only ${label(k, only)} for this model and year; the official decode leaves this blank.`);
      else decide('unknown', null, null, null, null);
    } else if (f.epa && epaV === false) {
      const mild = k === 'powertrain' && ['gas', 'ffv'].includes(v.code) && epa.broad.powertrains.every(x => ['mhev', 'hev'].includes(x));
      decide('doubtful', v.code, 'vpic_decode', mild ? 'epa_hybrid_only' : 'epa_not_listed', mild
        ? `EPA lists this model and year only as a ${epa.broad.powertrains.includes('hev') ? 'hybrid' : 'mild hybrid'}; the official decode gives gasoline with no electrification.`
        : `EPA lists no ${label(k, v.code)} for this model and year (it lists ${epaValuesText(k, epa)}).`);
    } else {
      decide('unverified', v.code, 'vpic_decode', null, null);
    }
    if (out.candidates.length && out.status !== 'unknown') out.candidates.sort((a, b) => PRECEDENCE.indexOf(a.tier) - PRECEDENCE.indexOf(b.tier));
    fields.push(out);
  }
  const byKey = Object.fromEntries(fields.map(x => [x.field, x]));
  // EPA lists no configuration with vPIC's own combination: when relaxing exactly one unchecked field makes it
  // listed, that field is doubtful.
  if (comboListed === false) {
    const relax = Object.keys(TUPLE).filter(k => vpicTuple[k] !== null && epaListsCombination({...vpicTuple, [k]: null}, epa) === true);
    if (relax.length === 1 && byKey[relax[0]].status === 'unverified') {
      Object.assign(byKey[relax[0]], {status: 'doubtful', basis: 'vpic_decode', rule: 'epa_combination', note: `EPA lists no configuration of this model and year with the decoded ${describeTuple(vpicTuple)}; it does with any ${FIELD[relax[0]].label.toLowerCase()}.`});
    }
  }
  impossible(byKey, vp, vehicles, decoded);
  for (const x of fields) x.matching = matchingUse(x);
  return finish(fields, {vin, evidence, epa, manufacturer, owner: ownerV});
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * How the matchers (fuel economy, EPA test cars, test-vehicle tires) use a checked field:
 *   checked_value   the corrected, filled or more precise value
 *   widened         nothing: the matcher takes the range of configurations (doubtful)
 *   official_value  vPIC's value (or its blank)
 * Measured on held-out NHTSA test vehicles (decode audit 2026-11-17): a drive or transmission filled from a test
 * vehicle when vPIC is blank is a sample, not a decode (the VIN often does not encode it: a 2015 Genesis or 2020
 * Stinger pattern covers rear and all-wheel drive, a 2012 Juke pattern manual and CVT), so it is shown but not used
 * to narrow; and an engine EPA does not list is usually a version EPA names on its own (2017 CTS-V), so the
 * matcher keeps vPIC's engine and reports what it finds.
 */
function matchingUse(x) {
  if (!FIELD[x.field].matcher) return null;
  if (x.status === 'corrected') return 'checked_value';
  if (x.status === 'filled') return x.basis === 'nhtsa_test_vehicle_pattern' && ['drive', 'transmission'].includes(x.field) ? 'official_value' : 'checked_value';
  if (x.status === 'confirmed') return x.shown_value !== x.original_value ? 'checked_value' : 'official_value';
  if (x.status === 'doubtful') return ['engine_size', 'cylinders'].includes(x.field) && x.rule === 'epa_not_listed' ? 'official_value' : 'widened';
  return 'official_value';
}
function epaOnly(k, epa) {
  const s = epa.strict;
  if (!s?.count) return null;
  if (k === 'drive' && s.drives.length === 1 && !s.unknown.drive && s.drives[0] !== 'two') return s.drives[0];
  return null;
}
function epaValuesText(k, epa) {
  const b = epa.broad;
  const vals = k === 'drive' ? b.drives : k === 'engine_size' ? b.sizes : k === 'cylinders' ? b.cylinders : k === 'powertrain' ? b.powertrains
    : k === 'transmission' ? [...new Set(b.transmissions.map(t => t.kind))] : k === 'speeds' ? [...new Set(b.transmissions.filter(t => t.speeds && t.kind !== 'cvt').map(t => t.speeds))] : [];
  return vals.map(x => label(k, x)).join(', ') || 'other values';
}
function describeTuple(t) {
  return Object.entries(t).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => label(k, v)).join(', ');
}

/** Combinations no vehicle has: an electric car with cylinders, a 6.2 L four-cylinder, a measured weight over the GVWR. */
function impossible(byKey, vp, vehicles, decoded) {
  const doubt = (k, rule, note) => {
    const x = byKey[k];
    if (!x || x.status !== 'unverified') return; // never over a value a record confirmed, corrected or filled
    Object.assign(x, {status: 'doubtful', basis: 'vpic_decode', rule, note});
  };
  const power = byKey.powertrain.shown_value ?? vp.powertrain.code;
  if (power === 'ev') {
    if (vp.cylinders.code) doubt('cylinders', 'electric_with_engine', 'An electric vehicle has no engine, yet the official decode gives cylinders.');
    if (vp.engine_size.code) doubt('engine_size', 'electric_with_engine', 'An electric vehicle has no engine, yet the official decode gives an engine size.');
    if (vp.transmission.code === 'manual') doubt('transmission', 'electric_manual', 'An electric vehicle with a manual gearbox is not plausible.');
  }
  const size = byKey.engine_size.shown_value ?? vp.engine_size.code, cyl = byKey.cylinders.shown_value ?? vp.cylinders.code;
  if (size && cyl && (size / cyl < 0.2 || size / cyl > 1.3)) {
    const note = `${label('engine_size', size)} over ${cyl} cylinders (${(size / cyl).toFixed(2)} L each) is not a plausible engine.`;
    doubt('engine_size', 'size_cylinders', note); doubt('cylinders', 'size_cylinders', note);
  }
  const classes = [].concat(vp.gvwr_class.code || []);
  const weights = vehicles.map(v => v.values?.curb_weight_kg?.value).filter(Boolean);
  if (classes.length && weights.length) {
    const maxLb = Math.max(...classes.map(c => CLASS_MAX_LB[c] ?? Infinity));
    const lightest = Math.min(...weights) / KG_PER_LB;
    if (lightest > maxLb) doubt('gvwr_class', 'gvwr_below_weight', `NHTSA weighed a test vehicle with this VIN pattern at ${Math.round(lightest)} lb, above the decoded GVWR class's ${maxLb} lb limit.`);
  }
}

function finish(fields, {vin, evidence, epa, manufacturer, owner}) {
  const counts = Object.fromEntries(STATUSES.map(s => [s, fields.filter(f => f.status === s).length]));
  const mfr = manufacturer === null ? {status: 'not_checked', note: 'The manufacturer\'s record of this VIN is read from its recall lookup, which the full report adds; this view was built without it.'}
    : manufacturer.available ? {status: 'used', text: manufacturer.text, source: manufacturer.source?.provider ?? null, retrieved_at: manufacturer.source?.retrieved_at ?? null}
      : {status: manufacturer.reason === 'manufacturer_not_supported' ? 'not_supported' : 'not_available', reason: manufacturer.reason ?? null};
  const tv = evidence?.available ? {status: evidence.vehicles.length ? 'used' : 'none_for_pattern', pattern: evidence.pattern, vehicles: evidence.vehicles.length}
    : {status: 'not_available', reason: evidence?.reason ?? 'not_checked', pattern: patternKey(vin)};
  const issues = fields.filter(f => ['corrected', 'doubtful', 'filled'].includes(f.status));
  return {
    pattern: patternKey(vin), fields, counts,
    summary: issues.length ? issues.map(f => `${f.label}: ${f.status}${f.shown ? ` (${f.shown})` : ''}`).join('; ') : 'No field of the decode is corrected, doubtful or filled.',
    sources: {owner: Object.keys(owner || {}).length ? {status: 'used', fields: Object.keys(owner)} : {status: 'not_given'}, manufacturer_record: mfr, test_vehicle_pattern: tv,
      epa: epa?.available ? {status: 'used', model_names: epa.models?.slice(0, 4) ?? []} : {status: 'not_available', reason: epa?.reason ?? null}},
    precedence: PRECEDENCE,
    precedence_labels: Object.fromEntries(PRECEDENCE.map(t => [t, TIER_LABEL[t]])),
    note: 'Checks on the official VIN decode (NHTSA vPIC), which describes a VIN pattern rather than this vehicle. The original value is always kept. Corrected: the manufacturer\'s record of this VIN, two or more NHTSA test vehicles with the same VIN pattern, or one test vehicle plus EPA\'s list of configurations, gives another value. Doubtful: a source disagrees without settling it, or EPA lists no such configuration; the matchers then use the range. Filled: the decode was blank. Fuel economy, EPA test cars and NHTSA test-vehicle tires use the checked values.',
  };
}

/**
 * The decode the matchers use: corrected and filled values substituted, doubtful values removed (so a matcher
 * widens to the range). Returns a new object; the original decode is untouched.
 */
export function checkedDecode(decoded, checks) {
  if (!decoded || !checks?.fields) return decoded;
  const d = {...decoded, vehicle: {...decoded.vehicle}, engine: {...decoded.engine}, transmission: {...decoded.transmission},
    dimensions: {...decoded.dimensions}, raw: {...decoded.raw}};
  const by = Object.fromEntries(checks.fields.map(f => [f.field, f]));
  const use = k => {
    const f = by[k];
    if (!f || !FIELD[k].matcher) return undefined;
    const how = f.matching ?? matchingUse(f);
    if (how === 'checked_value') return f.shown_value;
    if (how === 'widened') return null;
    return undefined; // keep vPIC's
  };
  const drive = use('drive');
  if (drive !== undefined) { d.transmission.drive_type = drive === null ? null : VPIC_DRIVE_TEXT[drive]; d.raw.DriveType = d.transmission.drive_type ?? ''; }
  const size = use('engine_size');
  if (size !== undefined) { d.engine.displacement_l = size || null; d.raw.DisplacementL = size ? String(size) : ''; }
  const cyl = use('cylinders');
  if (cyl !== undefined) { d.engine.cylinders = cyl || null; d.raw.EngineCylinders = cyl ? String(cyl) : ''; }
  const power = use('powertrain');
  if (power !== undefined) {
    const p = powertrainFields(power, decoded.engine?.fuel_type);
    d.engine.fuel_type = p.fuel_type; d.engine.ev_type = p.ev_type;
    d.raw.FuelTypePrimary = p.fuel_type ?? ''; d.raw.ElectrificationLevel = p.ev_type ?? '';
    if (power !== null && power !== 'ffv') d.raw.FuelTypeSecondary = '';
  }
  const tr = use('transmission');
  const TR = {auto: 'Automatic', manual: 'Manual/Standard', cvt: 'Continuously Variable Transmission (CVT)', am: 'Dual-Clutch Transmission (DCT)', single: 'Automatic'};
  if (tr !== undefined) {
    d.transmission.type = tr === null ? null : TR[tr]; d.raw.TransmissionStyle = d.transmission.type ?? '';
    // vPIC's speed count belongs to vPIC's gearbox: drop it unless the speeds were checked on their own.
    if (tr === null || !same('transmission', tr, by.transmission?.original_value)) {
      if (!['corrected', 'filled', 'confirmed'].includes(by.speeds?.status) || by.speeds?.basis === 'vpic_decode') { d.transmission.speeds = null; d.raw.TransmissionSpeeds = ''; }
    }
  }
  const sp = use('speeds');
  if (sp !== undefined) { d.transmission.speeds = sp; d.raw.TransmissionSpeeds = sp ? String(sp) : ''; }
  return d;
}

/** The fields a matcher reads, for telling whether a re-check changed anything the matchers use. */
export function matcherSignature(decoded) {
  const e = decoded?.engine || {}, t = decoded?.transmission || {};
  return JSON.stringify([t.drive_type ?? null, e.displacement_l ?? null, e.cylinders ?? null, e.fuel_type ?? null, e.ev_type ?? null, t.type ?? null, t.speeds ?? null]);
}

/** Convenience for the report: reads the evidence index and the local EPA index. */
export function decodeChecksFor(vin, decoded, {manufacturer = null, owner = null, evidenceFile, epaFile} = {}) {
  try {
    const evidence = patternEvidence(vin, evidenceFile ? {file: evidenceFile} : {});
    let epa;
    try { epa = epaOffers(decoded, epaFile ? {file: epaFile} : {}); } catch (err) { epa = {available: false, reason: 'index_unreadable'}; }
    return checkDecode(decoded, {vin, evidence, epa, manufacturer, owner});
  } catch (err) {
    console.error('[decode-checks] failed:', err.message);
    return null;
  }
}

/**
 * mcp.vin's own VIN decoder: NHTSA's vPIC decode algorithm (spvindecode / spvindecode_core / spvindecode_errorcode
 * from the standalone vPIC database, release in data/vpic.db) reproduced in JavaScript over the compact SQLite copy
 * that scripts/import-vpic.py builds from NHTSA's monthly dump. No network.
 *
 * decodeLocal(vin) returns the same flat key/value shape as the live API's DecodeVinValues (`values`), plus the
 * per-element items (source, pattern id, schema, keys) for provenance, the pass that won and the release.
 *
 * Rule tables (`rules`):
 *   'fixed' (default)  NHTSA's tables with mcp.vin's reviewed rule fixes applied at build time
 *                      (data-src/vpic-rule-fixes.jsonl; scripts/import-vpic.py records each edited row in rule_fix).
 *                      When a fix changed something for this VIN, `rule_fixes` lists every field whose value differs
 *                      from the decode on NHTSA's own rules, with the official value, the fix, reason and evidence.
 *   'pristine'         NHTSA's own rules exactly (the rule_fix records undone in memory), for parity with
 *                      spvindecode and for the official values. The interpreter is the same either way: a fix is data.
 *
 * `semantics`:
 *   'mssql' (default)  behave like the live API (SQL Server): NULLs sort last in DESC orderings, decimal arithmetic
 *                      truncates like SQL Server's decimal type, and the VIN-descriptor model-year table is used.
 *   'pg'               behave exactly like the PostgreSQL port in the dump (vpic.spvindecode), for parity tests:
 *                      NULLs first in DESC, PostgreSQL numeric arithmetic, and the descriptor table is never read
 *                      (the port computes the descriptor before it has the VIN).
 * Missing dataset: {available:false, reason:'dataset_not_indexed'}; any unexpected shape fails closed with
 * {available:false, reason:'decode_failed'}.
 */
import Database from 'better-sqlite3';
import {existsSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const VPIC_DB_FILE = fileURLToPath(new URL('../data/vpic.db', import.meta.url));
/** The keys (and order) of the live API's DecodeVinValues answer, 2026-11: element codes plus VIN and three ids. */
export const LIVE_VALUE_KEYS = Object.freeze([
  'ABS', 'ActiveSafetySysNote', 'AdaptiveCruiseControl', 'AdaptiveDrivingBeam', 'AdaptiveHeadlights',
  'AdditionalErrorText', 'AirBagLocCurtain', 'AirBagLocFront', 'AirBagLocKnee', 'AirBagLocSeatCushion',
  'AirBagLocSide', 'AutoReverseSystem', 'AutomaticPedestrianAlertingSound', 'AxleConfiguration', 'Axles', 'BasePrice',
  'BatteryA', 'BatteryA_to', 'BatteryCells', 'BatteryInfo', 'BatteryKWh', 'BatteryKWh_to', 'BatteryModules',
  'BatteryPacks', 'BatteryType', 'BatteryV', 'BatteryV_to', 'BedLengthIN', 'BedType', 'BlindSpotIntervention',
  'BlindSpotMon', 'BodyCabType', 'BodyClass', 'BrakeSystemDesc', 'BrakeSystemType', 'BusFloorConfigType', 'BusLength',
  'BusType', 'CAN_AACN', 'CIB', 'CashForClunkers', 'ChargerLevel', 'ChargerPowerKW', 'CombinedBrakingSystem',
  'CoolingType', 'CurbWeightLB', 'CustomMotorcycleType', 'DaytimeRunningLight', 'DestinationMarket', 'DisplacementCC',
  'DisplacementCI', 'DisplacementL', 'Doors', 'DriveType', 'DriverAssist', 'DynamicBrakeSupport', 'EDR', 'ESC',
  'EVDriveUnit', 'ElectrificationLevel', 'EngineConfiguration', 'EngineCycles', 'EngineCylinders', 'EngineHP',
  'EngineHP_to', 'EngineKW', 'EngineManufacturer', 'EngineModel', 'EntertainmentSystem', 'ErrorCode', 'ErrorText',
  'ForwardCollisionWarning', 'FuelInjectionType', 'FuelTankMaterial', 'FuelTankType', 'FuelTypePrimary',
  'FuelTypeSecondary', 'GCWR', 'GCWR_to', 'GVWR', 'GVWR_to', 'KeylessIgnition', 'LaneCenteringAssistance',
  'LaneDepartureWarning', 'LaneKeepSystem', 'LowerBeamHeadlampLightSource', 'Make', 'MakeID', 'Manufacturer',
  'ManufacturerId', 'Model', 'ModelID', 'ModelYear', 'MotorcycleChassisType', 'MotorcycleSuspensionType',
  'NCSABodyType', 'NCSAMake', 'NCSAMapExcApprovedBy', 'NCSAMapExcApprovedOn', 'NCSAMappingException', 'NCSAModel',
  'NCSANote', 'NonLandUse', 'Note', 'OtherBusInfo', 'OtherEngineInfo', 'OtherMotorcycleInfo',
  'OtherRestraintSystemInfo', 'OtherTrailerInfo', 'ParkAssist', 'PedestrianAutomaticEmergencyBraking', 'PlantCity',
  'PlantCompanyName', 'PlantCountry', 'PlantState', 'PossibleValues', 'Pretensioner', 'RearAutomaticEmergencyBraking',
  'RearCrossTrafficAlert', 'RearVisibilitySystem', 'SAEAutomationLevel', 'SAEAutomationLevel_to', 'SeatBeltsAll',
  'SeatRows', 'Seats', 'SemiautomaticHeadlampBeamSwitching', 'Series', 'Series2', 'SteeringLocation', 'SuggestedVIN',
  'TPMS', 'TopSpeedMPH', 'TrackWidth', 'TractionControl', 'TrailerBodyType', 'TrailerLength', 'TrailerType',
  'TransmissionSpeeds', 'TransmissionStyle', 'Trim', 'Trim2', 'Turbo', 'VIN', 'ValveTrainDesign', 'VehicleDescriptor',
  'VehicleType', 'WheelBaseLong', 'WheelBaseShort', 'WheelBaseType', 'WheelSizeFront', 'WheelSizeRear',
  'WheelieMitigation', 'Wheels', 'Windows',
]);
const MULTI_VALUE = new Set([121, 129, 150, 154, 155, 114, 169, 186]); // never ranked: every value kept
const SPEC_REPEATABLE = new Set([1, 114, 121, 129, 150, 154, 155, 169, 186]);
const NOT_PATTERN_ELEMENTS = new Set([26, 27, 29, 39]);
const OFFROAD_BODY = new Set(['69', '84', '86', '88', '97', '105', '113', '124', '126', '127']);
const INCOMPLETE_BODY = new Set(['65', '107', '70', '74', '63', '72', '112', '62', '64', '76', '78', '71', '77', '67', '116', '75']);
const PATTERN_SOURCES = new Set(['Pattern', 'EngineModelPattern', 'Formula Pattern']);
const VALID_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
const TRANSLIT = {A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

// ---------------------------------------------------------------- dataset

const handles = new Map();
const RECHECK_MS = 60_000;
function fileId(file) { try { const st = statSync(file); return `${st.ino}:${st.size}:${st.mtimeMs}`; } catch { return null; } }
function open(file) {
  let h = handles.get(file);
  if (h) {
    // A monthly refresh replaces the file (scripts/import-vpic.py writes a new file and renames it): reopen then.
    if (Date.now() - h.checkedAt < RECHECK_MS) return h;
    h.checkedAt = Date.now();
    const id = fileId(file);
    if (id === h.fileId) return h;
    try { h.db.close(); } catch { /* already closed */ }
    handles.delete(file);
    h = null;
  }
  if (!existsSync(file)) return null;
  const db = new Database(file, {readonly: true, fileMustExist: true});
  db.pragma('mmap_size = 268435456'); // reads through the page cache, not one syscall per page
  db.pragma('cache_size = -16000');
  const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map(r => [r.key, r.value]));
  if (meta.schema_version !== '1') { db.close(); throw new Error(`vpic.db schema ${meta.schema_version} not supported`); }
  const elements = new Map(db.prepare('SELECT * FROM element').all().map(e => [e.id, e]));
  const errorCodes = db.prepare('SELECT * FROM error_code ORDER BY id').all();
  const conversions = db.prepare('SELECT * FROM conversion').all();
  const engineModels = db.prepare('SELECT id, name FROM engine_model ORDER BY id').all();
  const lookupAll = db.prepare('SELECT id, name FROM lookup WHERE tbl = ?');
  const lookups = new Map();
  const fixes = loadRuleFixes(db);
  h = {
    db, meta, elements, errorCodes, conversions, engineModels, fileId: fileId(file), checkedAt: Date.now(), ...fixes,
    errorWeight: new Map(errorCodes.map(e => [e.id, e.weight])),
    /** One lookup list (make, model, drivetype, ...) held in memory after first use: id -> name. */
    lookup(tbl, id) {
      let m = lookups.get(tbl);
      if (!m) { m = new Map(lookupAll.all(tbl).map(r => [r.id, r.name])); lookups.set(tbl, m); }
      return m.has(id) ? {name: m.get(id)} : undefined;
    },
    q: {
      wmi: db.prepare('SELECT * FROM wmi WHERE wmi = ?'),
      wvs: db.prepare('SELECT ws.schema_id, ws.year_from, ws.year_to, ws.wmi_id, s.to_be_qced, s.valid_chars FROM wmi_vinschema ws JOIN vinschema s ON s.id = ws.schema_id WHERE ws.wmi_id = ?'),
      patterns: db.prepare('SELECT id, keys, element_id, attribute_id, changed_us FROM pattern WHERE schema_id = ? ORDER BY id'),
      makeModel: db.prepare('SELECT make_id FROM make_model WHERE model_id = ?'),
      wmiMake: db.prepare('SELECT make_id FROM wmi_make WHERE wmi_id = ?'),
      emp: db.prepare('SELECT * FROM engine_model_pattern WHERE engine_model_id = ? ORDER BY id'),
      specPatterns: db.prepare(`SELECT DISTINCT sp.id AS id, s.to_be_qced AS tbq
        FROM spec_schema s JOIN spec_schema_pattern sp ON s.id = sp.schema_id
        JOIN spec_pattern p ON sp.id = p.spec_schema_pattern_id
        JOIN spec_schema_model m ON m.schema_id = s.id
        LEFT JOIN spec_schema_year y ON y.schema_id = s.id
        JOIN wmi_make wm ON wm.make_id = s.make_id JOIN wmi w ON w.id = wm.wmi_id
        WHERE w.wmi = ? AND s.vehicle_type_id = ? AND m.model_id = ? AND (y.year = ? OR y.id IS NULL) AND p.is_key = 1
          AND coalesce(s.to_be_qced, 0) = 0`),
      specRows: db.prepare('SELECT p.*, sp.schema_id FROM spec_pattern p JOIN spec_schema_pattern sp ON sp.id = p.spec_schema_pattern_id WHERE p.spec_schema_pattern_id = ? ORDER BY p.id'),
      defaults: db.prepare('SELECT * FROM default_value WHERE vehicle_type_id = ? AND default_value IS NOT NULL ORDER BY id'),
      exception: db.prepare('SELECT 1 FROM vin_exception WHERE vin = ?'),
      descriptor: db.prepare('SELECT model_year FROM vin_descriptor WHERE descriptor = ?'),
      yearChars: db.prepare('SELECT chars FROM wmi_year_chars WHERE wmi = ? AND year = ?'),
    },
    patternCache: new Map(),
    pristineCache: new Map(),
  };
  handles.set(file, h);
  return h;
}

/** The applied rule fixes recorded by the build (none in a file built without them, or before they existed). */
function loadRuleFixes(db) {
  const out = {fixBySchema: new Map(), fixBySpec: new Map(), fixEntries: new Map(), fixCount: 0};
  const has = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  if (!has('rule_fix') || !has('rule_fix_entry')) return out;
  const specSchema = db.prepare('SELECT schema_id FROM spec_schema_pattern WHERE id = ?');
  for (const r of db.prepare('SELECT * FROM rule_fix ORDER BY fix_id, edit_no').all()) {
    out.fixCount++;
    if (r.tbl === 'pattern') {
      if (!out.fixBySchema.has(r.schema_id)) out.fixBySchema.set(r.schema_id, []);
      out.fixBySchema.get(r.schema_id).push(r);
    } else if (r.tbl === 'spec_pattern') {
      r.spec_schema_id = specSchema.get(r.spec_schema_pattern_id)?.schema_id ?? null;
      if (!out.fixBySpec.has(r.spec_schema_pattern_id)) out.fixBySpec.set(r.spec_schema_pattern_id, []);
      out.fixBySpec.get(r.spec_schema_pattern_id).push(r);
    } else throw new Error(`rule_fix table ${r.tbl}`);
  }
  for (const e of db.prepare("SELECT * FROM rule_fix_entry WHERE status = 'applied'").all()) {
    out.fixEntries.set(e.fix_id, {id: e.fix_id, case: e.fix_case, written_against: e.written_against, reason: servedReason(e.fix_id, e.reason),
      evidence: JSON.parse(e.evidence), errors: JSON.parse(e.errors), reviewed: JSON.parse(e.reviewed)});
  }
  return out;
}

/**
 * The reason a report shows for a rule fix. mcp.vin serves no text a manufacturer supplied (since 2026-11-18, when it
 * stopped asking makers about VINs): rf-008's reviewed reason (data-src/vpic-rule-fixes.jsonl, kept as reviewed)
 * quotes Volkswagen's VIN record, so its served reason keeps only the government evidence the fix rests on (NHTSA's
 * two test Atlases, EPA). Any other reason that quotes a maker's record is not served (null), so it fails closed.
 */
export const SERVED_FIX_REASON = Object.freeze({
  'rf-008': "vPIC keys the 2018 Atlas drive on positions 4, 7 and 8 (G, H, K, L, M, N, R with CA: AWD) but has no row for B with CA, so the vehicle-spec value for 'Launch Model' (AWD) filled it. Both NHTSA test Atlases with B were front-drive; EPA lists FWD and 4Motion Atlases. A row B**CA now gives front-wheel drive.",
});
const MAKER_RECORD_TEXT = /own (?:VIN )?record|recall lookup|record of [A-HJ-NPR-Z0-9]{17}/i;
export function servedReason(id, reason) {
  if (Object.hasOwn(SERVED_FIX_REASON, id)) return SERVED_FIX_REASON[id];
  return typeof reason === 'string' && MAKER_RECORD_TEXT.test(reason) ? null : reason ?? null;
}

/** Release metadata of the local dataset, or null when it is missing. */
export function vpicLocalInfo({file = VPIC_DB_FILE} = {}) {
  try {
    const h = open(file);
    if (!h) return null;
    let fixes = null;
    try { fixes = h.meta.rule_fixes ? JSON.parse(h.meta.rule_fixes) : null; } catch { fixes = null; }
    return {release: h.meta.release, release_name: h.meta.release_name, built_at: h.meta.built_at, nhtsa_dump_started: h.meta.nhtsa_dump_started || null,
      rule_fixes: fixes ? {applied: fixes.applied, needs_review: fixes.needs_review, edits: h.fixCount} : {applied: 0, needs_review: 0, edits: 0}};
  } catch { return null; }
}

/** Close cached handles (tests). */
export function closeVpicLocal() { for (const h of handles.values()) h.db.close(); handles.clear(); }

function schemaPatterns(h, schemaId, ctx) {
  const fixes = h.fixBySchema.get(schemaId);
  if (fixes) {
    if (ctx.rules === 'pristine') return pristinePatterns(h, schemaId, fixes);
    for (const f of fixes) ctx.touched.add(f.fix_id);
  }
  let rows = h.patternCache.get(schemaId);
  if (rows) { h.patternCache.delete(schemaId); h.patternCache.set(schemaId, rows); return rows; }
  rows = h.q.patterns.all(schemaId);
  h.patternCache.set(schemaId, rows);
  if (h.patternCache.size > 96) h.patternCache.delete(h.patternCache.keys().next().value);
  return rows;
}

/** A schema's rows as NHTSA published them: the recorded edits undone (modified rows restored, removed rows back, added rows gone). */
function pristinePatterns(h, schemaId, fixes) {
  let rows = h.pristineCache.get(schemaId);
  if (rows) return rows;
  const byId = new Map(h.q.patterns.all(schemaId).map(r => [r.id, r]));
  for (const f of fixes) {
    if (f.action === 'add') byId.delete(f.row_id);
    else byId.set(f.row_id, {id: f.row_id, keys: f.orig_keys, element_id: f.element_id, attribute_id: f.orig_attribute_id, changed_us: f.orig_changed_us});
  }
  rows = [...byId.values()].sort((a, b) => a.id - b.id);
  h.pristineCache.set(schemaId, rows);
  return rows;
}

/** A vehicle-spec pattern's rows for the chosen rule view. */
function specRows(h, specPatternId, ctx) {
  const rows = h.q.specRows.all(specPatternId);
  const fixes = h.fixBySpec.get(specPatternId);
  if (!fixes) return rows;
  if (ctx.rules !== 'pristine') { for (const f of fixes) ctx.touched.add(f.fix_id); return rows; }
  const byId = new Map(rows.map(r => [r.id, r]));
  for (const f of fixes) {
    byId.set(f.row_id, {id: f.row_id, spec_schema_pattern_id: f.spec_schema_pattern_id, is_key: f.is_key, element_id: f.element_id,
      attribute_id: f.orig_attribute_id, changed_us: f.orig_changed_us, schema_id: f.spec_schema_id});
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------- small NHTSA functions

/** fVinWMI: positions 1-3, plus 12-14 when position 3 is '9' (small manufacturers). */
export function vinWmi(vin) {
  let wmi = vin.length > 3 ? vin.slice(0, 3) : vin;
  if (wmi.charAt(2) === '9' && vin.length >= 14) wmi += vin.slice(11, 14);
  return wmi;
}

/** fVinDescriptor: positions 1-11 (1-14 for '9' WMIs) with the check digit as '*'. */
export function vinDescriptor(vin) {
  let v = (vin.trim() + '*****************').slice(0, 17);
  v = v.slice(0, 8) + '*' + v.slice(9);
  return (v.charAt(2) === '9' ? v.slice(0, 14) : v.slice(0, 11)).toUpperCase();
}

const isCarLt = w => !!w && ([2, 7].includes(w.vehicle_type_id) || (w.vehicle_type_id === 3 && w.truck_type_id === 1));

/** fVinModelYear2: model year from position 10; negative when inconclusive (two 30-year cycles possible). */
export function vinModelYear(vin, wmiRow, now = new Date()) {
  vin = vin.toUpperCase();
  let my = null, conclusive = false;
  if (vin.length >= 10) {
    const c = vin.charAt(9), a = c.charCodeAt(0);
    if (c >= 'A' && c <= 'H') my = 2010 + a - 65;
    if (c >= 'J' && c <= 'N') my = 2010 + a - 65 - 1;
    if (c === 'P') my = 2023;
    if (c >= 'R' && c <= 'T') my = 2010 + a - 65 - 3;
    if (c >= 'V' && c <= 'Y') my = 2010 + a - 65 - 4;
    if (c >= '1' && c <= '9') my = 2031 + a - 49;
  }
  if (my !== null) {
    const carLt = isCarLt(wmiRow);
    const p7 = vin.charAt(6);
    if (carLt && /^[0-9]$/.test(p7)) { my -= 30; conclusive = true; }
    if (carLt && /^[A-Z]$/.test(p7)) conclusive = true;
    if (my > now.getUTCFullYear() + 2) { my -= 30; conclusive = true; }
  }
  if (!conclusive) my = my === null ? null : -my;
  return my;
}

function checkDigitValue(ch) {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  return TRANSLIT[ch] ?? -1;
}
const RX_DEFAULT = /[a-h,j-n,p,r-z,0-9]/i, RX_MY = /[a-h,j-n,p,r-t,v-y,1-9]/i, RX_NUM = /[0-9]/i;
/** fVINCheckDigit (variant 1, used when correcting one position) and fVINCheckDigit2 (variant 2, decode). */
export function vinCheckDigit(vin, {variant = 2, carMpvLt = false} = {}) {
  if (vin.length !== 17) return '';
  let sum = 0;
  for (let i = 1; i <= 17; i++) {
    const ch = vin.charAt(i - 1);
    let rx = RX_DEFAULT;
    if (i === 10) rx = RX_MY;
    else if (variant === 1 && (i === 13 || i === 14)) rx = vin.charAt(2) === '9' ? RX_DEFAULT : RX_NUM;
    else if (variant === 2 && i === 13 && vin.charAt(2) !== '9' && carMpvLt) rx = RX_NUM;
    else if (variant === 2 && i === 14 && vin.charAt(2) !== '9') rx = RX_NUM;
    else if (i >= 15) rx = RX_NUM;
    if (!rx.test(ch)) return '?';
    sum += checkDigitValue(ch.toUpperCase()) * WEIGHTS[i - 1];
  }
  const rem = sum - 11 * Math.floor(sum / 11);
  return rem === 10 ? 'X' : String(rem);
}

/** fValidCharsInRegEx */
function validCharsInRegex(cls) {
  const s = cls.toUpperCase();
  if (!s.includes('-') && !s.includes('^')) return s.replace(/\]/g, '').replace(/\[/g, '');
  let rx;
  try { rx = new RegExp(`^${s}$`); } catch { return ''; }
  let out = '';
  for (const c of VALID_CHARS) if (rx.test(c)) out += c;
  return out;
}
const keyCharsCache = new Map();
/** fValidCharsInKey (strict): Map key position -> Set of explicit characters. */
function validCharsInKey(key) {
  let m = keyCharsCache.get(key);
  if (m) return m;
  m = new Map();
  const add = (p, c) => { if (!m.has(p)) m.set(p, new Set()); m.get(p).add(c); };
  let ind = 0, inside = false, start = 0;
  for (let i = 1; i <= key.length; i++) {
    const s = key.charAt(i - 1);
    if (s === '[' && !inside) { inside = true; start = i; continue; }
    if (!inside) {
      ind++;
      if (s === '#') { for (const d of '0123456789') add(ind, d); continue; }
      if (s === '*') continue;
      add(ind, s);
      continue;
    }
    if (s === ']' && inside) {
      ind++;
      for (const c of validCharsInRegex(key.slice(start - 1, i))) if (c !== '*' && c !== '|') add(ind, c);
      inside = false; start = 0;
    }
  }
  if (keyCharsCache.size > 50000) keyCharsCache.clear();
  keyCharsCache.set(key, m);
  return m;
}

/** sqlwild_to_regex: the PostgreSQL port's regex for keys with a [class]. */
function keysRegex(keys) {
  let out = '';
  for (const ch of keys) {
    if (ch === '*') out += '.';
    else if (ch === '[' || ch === ']') out += ch;
    else if (ch === '|') out += '\\|';
    else if (/[\\.^$+?{}()]/.test(ch)) out += '\\' + ch;
    else out += ch;
  }
  out = out.split('1-A').join('1A');
  return `^${out}.*`;
}
const regexCache = new Map();
/** Does a pattern's keys match the VIN keys (positions 4-8 '|' 10-17)? LIKE ('*' and '_' one character, prefix) or regex. */
function keysMatch(keys, varKeys) {
  if (keys.includes('[')) {
    let rx = regexCache.get(keys);
    if (rx === undefined) {
      try { rx = new RegExp(keysRegex(keys)); } catch { rx = null; }
      if (regexCache.size > 50000) regexCache.clear();
      regexCache.set(keys, rx);
    }
    return rx ? rx.test(varKeys) : false;
  }
  return likePrefix(keys, varKeys, true);
}
/** `text LIKE replace(keys,'*','_') || '%'` */
function likePrefix(keys, text) {
  if (keys.length > text.length) return false;
  for (let i = 0; i < keys.length; i++) {
    const k = keys.charCodeAt(i);
    if (k === 42 || k === 95) continue; // '*' -> '_', and '_' itself
    if (k === 37) return true; // '%' (not used by NHTSA's keys, but LIKE semantics)
    if (k !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Do a pattern's keys match this VIN (positions 4-8, '|', 10-17)? (tests and rule-fix tooling) */
export function keysMatchVin(keys, vin) {
  const v = String(vin || '').toUpperCase();
  let varKeys = v.substr(3, 5);
  if (v.length > 9) varKeys += '|' + v.substr(9, 8);
  return keysMatch(String(keys || ''), varKeys);
}

// ---------------------------------------------------------------- numbers (unit conversions)

function parseDecimal(text) {
  const m = /^\s*([+-]?)(\d*)(?:\.(\d*))?\s*$/.exec(String(text ?? ''));
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) return null;
  const int = m[2] || '0', frac = m[3] ?? '';
  return {neg: m[1] === '-', digits: BigInt(int + frac), scale: frac.length, hasPoint: m[3] !== undefined, intDigits: m[2].replace(/^0+/, '').length};
}
function fmt(neg, digits, scale) {
  let s = digits.toString().padStart(scale + 1, '0');
  if (scale > 0) s = s.slice(0, s.length - scale) + '.' + s.slice(s.length - scale);
  return (neg && digits !== 0n ? '-' : '') + s;
}
/** PostgreSQL numeric weight (base 10000 digit groups) and first group of a decimal. */
function pgWeight(d) {
  const abs = d.digits.toString().padStart(d.scale + 1, '0');
  const intPart = abs.slice(0, abs.length - d.scale).replace(/^0+/, ''), frac = abs.slice(abs.length - d.scale);
  if (intPart.length) {
    const groups = Math.ceil(intPart.length / 4);
    const first = intPart.slice(0, intPart.length - (groups - 1) * 4);
    return {weight: groups - 1, first: Number(first)};
  }
  const padded = frac.padEnd(Math.ceil(frac.length / 4) * 4, '0');
  for (let j = 0; j < padded.length / 4; j++) {
    const g = Number(padded.slice(j * 4, j * 4 + 4));
    if (g !== 0) return {weight: -(j + 1), first: g};
  }
  return {weight: 0, first: 0};
}
const pow10 = n => 10n ** BigInt(n);
function divRound(num, den, roundHalfAway) {
  const q = num / den, r = num % den;
  if (!roundHalfAway || r === 0n) return q;
  return 2n * (r < 0n ? -r : r) >= (den < 0n ? -den : den) ? q + ((num < 0n) !== (den < 0n) ? -1n : 1n) : q;
}
/** Evaluate one of vPIC's conversion formulas ("#x# / 0.016387064") the way the database would. */
export function convert(formula, x, semantics = 'mssql') {
  const f = /^\s*#x#\s*([*/])\s*(\d*\.?\d*)\s*$/.exec(String(formula || ''));
  if (!f) return {ok: false, value: null, reason: 'unknown_formula'};
  const a = parseDecimal(x), b = parseDecimal(f[2]);
  if (!a || !b) return {ok: true, value: '0', reason: 'not_a_number'}; // the SQL fails; NHTSA's code stores '0'
  const neg = a.neg !== b.neg;
  const sa = BigInt(a.neg ? -1 : 1) * a.digits, sb = b.digits;
  if (semantics === 'pg') {
    const aInt = !a.hasPoint, bInt = !b.hasPoint;
    if (f[1] === '*') {
      if (aInt && bInt) return {ok: true, value: (sa * sb).toString()};
      return {ok: true, value: fmt(neg, (a.digits * b.digits), a.scale + b.scale)};
    }
    if (sb === 0n) return {ok: true, value: '0', reason: 'division_by_zero'};
    if (aInt && bInt) return {ok: true, value: (sa / sb).toString()};
    const w1 = pgWeight(a), w2 = pgWeight(b);
    let qweight = w1.weight - w2.weight;
    if (w1.first <= w2.first) qweight--;
    let rscale = 16 - qweight * 4;
    rscale = Math.min(Math.max(rscale, a.scale, b.scale, 0), 1000);
    // a/b = (A/10^sa)/(B/10^sb) -> scaled by 10^rscale
    const num = a.digits * pow10(b.scale + rscale), den = b.digits * pow10(a.scale);
    return {ok: true, value: fmt(neg, divRound(num, den, true), rscale)};
  }
  // SQL Server decimal rules: an integer literal is int (decimal(10,0) next to a decimal); a decimal literal's
  // precision is its digit count. Multiplication is exact; division keeps max(6, s1 + p2 + 1) decimals, truncated.
  const prec = d => (!d.hasPoint ? 10 : Math.max(d.intDigits + d.scale, d.scale, 1));
  const aInt = !a.hasPoint, bInt = !b.hasPoint;
  if (f[1] === '*') {
    if (aInt && bInt) return {ok: true, value: (sa * sb).toString()};
    return {ok: true, value: fmt(neg, a.digits * b.digits, a.scale + b.scale)};
  }
  if (sb === 0n) return {ok: true, value: '0', reason: 'division_by_zero'};
  if (aInt && bInt) return {ok: true, value: (sa / sb).toString()};
  let scale = Math.max(6, a.scale + prec(b) + 1);
  const p = prec(a) - a.scale + b.scale + scale;
  if (p > 38) scale = Math.max(6, scale - (p - 38));
  const num = a.digits * pow10(b.scale + scale), den = b.digits * pow10(a.scale);
  return {ok: true, value: fmt(neg, num / den, scale)};
}

// ---------------------------------------------------------------- ordering helpers

/** DESC comparison of nullable numbers: pg puts NULL first, SQL Server last. */
function descNull(a, b, semantics) {
  if (a === b) return 0;
  if (a === null || a === undefined) return semantics === 'pg' ? -1 : 1;
  if (b === null || b === undefined) return semantics === 'pg' ? 1 : -1;
  return b - a;
}
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- the decode

class Items {
  constructor(pass) { this.pass = pass; this.list = []; this.seq = 0; }
  add(o) { const it = {id: ++this.seq, pass: this.pass, changed: null, patternId: null, keys: null, schemaId: null, wmiId: null, tbq: null, ...o}; this.list.push(it); return it; }
  byElement(el) { return this.list.filter(i => i.elementId === el); }
  has(el) { return this.list.some(i => i.elementId === el); }
}

function core(h, ctx, pass, modelYear, vin, modelYearSource, conclusive, error12) {
  const {semantics, nowUs, stats} = ctx;
  let returnCode = '';
  const varWmi = vinWmi(vin);
  let varKeys = '';
  if (vin.length > 3) { varKeys = vin.substr(3, 5); if (vin.length > 9) varKeys += '|' + vin.substr(9, 8); }
  const items = new Items(pass);
  let correctedVin = null, errorBytes = null, unusedPositions = null;
  const wmiRow = h.q.wmi.get(varWmi) || null;
  const isPublic = wmiRow && wmiRow.public_us !== null && wmiRow.public_us <= nowUs;
  const inYear = r => modelYear === null || (modelYear >= r.year_from && modelYear <= (r.year_to ?? 2999));
  let varModelId = null;

  if (!isPublic) {
    returnCode += ' 7 '; correctedVin = ''; errorBytes = '';
  } else {
    const wvs = h.q.wvs.all(wmiRow.id);
    // 1. patterns of every schema linked to the WMI for the model year (one item per link), ordered by pattern id
    const found = [];
    for (const link of wvs) {
      if (!inYear(link) || link.to_be_qced) continue;
      for (const p of schemaPatterns(h, link.schema_id, ctx)) {
        if (NOT_PATTERN_ELEMENTS.has(p.element_id)) continue;
        const e = h.elements.get(p.element_id);
        if (!e || e.decode === null || e.is_private === 1) continue;
        if (!keysMatch(p.keys, varKeys)) continue;
        found.push({p, link});
      }
    }
    found.sort((x, y) => x.p.id - y.p.id || x.link.year_from - y.link.year_from);
    for (const {p, link} of found) {
      items.add({changed: p.changed_us, patternId: p.id, keys: p.keys.toUpperCase(), schemaId: link.schema_id, wmiId: link.wmi_id, elementId: p.element_id,
        attributeId: p.attribute_id, value: 'XXX', source: 'Pattern', priority: link.year_from, tbq: link.to_be_qced});
    }
    // 2. engine model -> its patterns (chosen before ranking: priority, newest, last inserted)
    const engines = items.byElement(18).sort((a, b) => b.priority - a.priority || descNull(a.changed, b.changed, semantics) || b.id - a.id);
    if (engines.length) {
      const em = engines[0];
      const name = String(em.attributeId ?? '').replace(/^ +| +$/g, '').toLowerCase();
      for (const m of h.engineModels) {
        if (String(m.name ?? '').replace(/^ +| +$/g, '').toLowerCase() !== name) continue;
        for (const p of h.q.emp.all(m.id)) {
          if (!h.elements.has(p.element_id)) continue;
          items.add({changed: p.changed_us, patternId: em.patternId, keys: em.keys, schemaId: em.schemaId, wmiId: wmiRow.id, elementId: p.element_id,
            attributeId: p.attribute_id, value: 'XXX', source: 'EngineModelPattern', priority: 50});
        }
      }
    }
    // 3. vehicle type, manufacturer, model year
    if (wmiRow.vehicle_type_id !== null) {
      const vt = h.lookup('vehicletype', String(wmiRow.vehicle_type_id));
      if (vt) items.add({changed: wmiRow.changed_us, keys: varWmi.toUpperCase(), wmiId: wmiRow.id, elementId: 39, attributeId: String(wmiRow.vehicle_type_id),
        value: String(vt.name).toUpperCase(), source: 'VehType', priority: 100});
    }
    let mfrId = null, mfrName = null;
    if (wmiRow.manufacturer_id !== null) {
      const m = h.lookup('manufacturer', String(wmiRow.manufacturer_id));
      if (m) { mfrId = String(wmiRow.manufacturer_id); mfrName = String(m.name).toUpperCase(); }
    }
    items.add({keys: varWmi.toUpperCase(), wmiId: wmiRow.id, elementId: 27, attributeId: mfrId, value: mfrName, source: 'Manu. Name', priority: 100});
    items.add({keys: varWmi.toUpperCase(), wmiId: wmiRow.id, elementId: 157, attributeId: mfrId, value: mfrId, source: 'Manu. Id', priority: 100});
    if (modelYear !== null) items.add({keys: modelYearSource, elementId: 29, attributeId: String(modelYear), value: String(modelYear), source: 'ModelYear', priority: 100});
    // 4. formula patterns ('#' = any digit; the value is the VIN's digits there)
    const formulaKeys = varKeys.replace(/[0-9]/g, '#');
    const schemaIds = new Set(wvs.filter(inYear).map(l => l.schema_id));
    const formulas = [];
    for (const sid of schemaIds) {
      for (const p of schemaPatterns(h, sid, ctx)) {
        if (!p.keys.includes('#') || NOT_PATTERN_ELEMENTS.has(p.element_id) || !h.elements.has(p.element_id)) continue;
        if (!likePrefix(p.keys, formulaKeys)) continue;
        formulas.push({p, sid});
      }
    }
    formulas.sort((x, y) => x.p.id - y.p.id);
    for (const {p, sid} of formulas) {
      const first = p.keys.indexOf('#') + 1, last = p.keys.length - [...p.keys].reverse().join('').indexOf('#');
      items.add({changed: p.changed_us, patternId: p.id, keys: p.keys, schemaId: sid, elementId: p.element_id, attributeId: p.attribute_id,
        value: varKeys.substr(first - 1, last - first + 1), source: 'Formula Pattern', priority: 100});
    }
    // 5. one value per element (except the multi-value notes)
    const groups = new Map();
    for (const it of items.list) {
      if (MULTI_VALUE.has(it.elementId)) continue;
      if (!groups.has(it.elementId)) groups.set(it.elementId, []);
      groups.get(it.elementId).push(it);
    }
    const drop = new Set();
    for (const [, g] of groups) {
      if (g.length < 2) continue;
      g.sort((a, b) => {
        const r = b.priority - a.priority || descNull(a.changed, b.changed, semantics);
        if (r) return r;
        const ka = (a.keys ?? '').replace(/\*/g, ''), kb = (b.keys ?? '').replace(/\*/g, '');
        if (ka.length !== kb.length) return ka.length - kb.length;
        const sa = (a.keys ?? '').replace(/[[\]]/g, ''), sb = (b.keys ?? '').replace(/[[\]]/g, '');
        if (sa !== sb) { if (stats) stats.collationTies = (stats.collationTies || 0) + 1; return ctx.collate(sa, sb); }
        return a.id - b.id;
      });
      for (const it of g.slice(1)) drop.add(it);
    }
    items.list = items.list.filter(it => !drop.has(it));
    // 6. make from the model (or the WMI's only make)
    const model = items.byElement(28)[0];
    if (model) {
      varModelId = Number.parseInt(model.attributeId, 10);
      if (!Number.isInteger(varModelId) || String(varModelId) !== String(model.attributeId).trim()) throw new Error(`model attribute ${model.attributeId}`);
      for (const mm of h.q.makeModel.all(varModelId)) {
        const mk = h.lookup('make', String(mm.make_id));
        if (!mk) continue;
        items.add({patternId: model.patternId, keys: model.keys, schemaId: model.schemaId, elementId: 26, attributeId: String(mm.make_id), value: String(mk.name).toUpperCase(),
          source: 'pattern - model', priority: 1000});
      }
    } else {
      const makes = h.q.wmiMake.all(wmiRow.id).map(r => ({id: r.make_id, mk: h.lookup('make', String(r.make_id))})).filter(r => r.mk);
      if (makes.length === 1) items.add({changed: wmiRow.changed_us, keys: varWmi, wmiId: wmiRow.id, elementId: 26, attributeId: String(makes[0].id),
        value: String(makes[0].mk.name).toUpperCase(), source: 'Make', priority: -100});
    }
    // 7. unit conversions (displacement L / CC / CI), first missing target wins
    const convRows = [];
    for (const it of items.list) for (const c of h.conversions) if (c.from_element_id === it.elementId && h.elements.has(c.to_element_id)) convRows.push({it, c});
    convRows.sort((x, y) => y.it.priority - x.it.priority || descNull(x.it.changed, y.it.changed, semantics) || x.c.id - y.c.id);
    for (const {it, c} of convRows) {
      if (items.has(c.to_element_id)) continue;
      const formula = c.formula.split('#x#').join(it.attributeId ?? '');
      const r = convert(c.formula, it.attributeId, semantics);
      if (!r.ok) { if (stats) stats.unknownFormula = (stats.unknownFormula || 0) + 1; continue; }
      items.add({patternId: it.patternId, keys: it.keys, schemaId: it.schemaId, wmiId: it.wmiId, elementId: c.to_element_id, attributeId: r.value, value: r.value,
        source: `Conversion ${c.id}: ${formula}`.slice(0, 50), priority: 100});
    }
    // 8. vehicle-spec patterns of the make/model/year whose key values all match the decode so far
    const vtItem = items.byElement(39)[0];
    const tVehicleType = vtItem ? Number(vtItem.attributeId) : null;
    if (tVehicleType !== null && varModelId !== null) {
      const cand = h.q.specPatterns.all(varWmi, tVehicleType, varModelId, modelYear);
      const keep = [];
      for (const sp of cand) {
        const rows = specRows(h, sp.id, ctx);
        let total = 0; const matched = new Set();
        for (const r of rows.filter(r => r.is_key === 1)) {
          const hits = items.list.filter(d => d.elementId === r.element_id && String(d.attributeId ?? '').toLowerCase() === String(r.attribute_id ?? '').toLowerCase() && d.attributeId !== null && r.attribute_id !== null);
          if (!hits.length) total += 1; else { total += hits.length; hits.forEach(d => matched.add(d.id)); }
        }
        if (total === matched.size) keep.push({sp, rows});
      }
      const present = new Set(items.list.filter(d => !SPEC_REPEATABLE.has(d.elementId)).map(d => d.elementId));
      const byEl = new Map();
      const seen = new Set();
      for (const {sp, rows} of keep) {
        for (const r of rows) {
          if (r.is_key !== 0 || present.has(r.element_id)) continue;
          const sig = `${r.schema_id}|${sp.id}|${r.element_id}|${r.attribute_id}|${r.changed_us}|${sp.tbq}`;
          if (seen.has(sig)) continue;
          seen.add(sig);
          const row = {schemaId: r.schema_id, specPatternId: sp.id, elementId: r.element_id, attributeId: r.attribute_id, changed: r.changed_us, tbq: sp.tbq, rowId: r.id};
          const cur = byEl.get(r.element_id);
          if (!cur) byEl.set(r.element_id, [row]); else cur.push(row);
        }
      }
      for (const [el, rows] of byEl) {
        rows.sort((a, b) => descNull(a.changed, b.changed, semantics) || a.rowId - b.rowId);
        if (rows.length > 1 && rows[0].changed === rows[1].changed && rows[0].attributeId !== rows[1].attributeId && stats) stats.specTies = (stats.specTies || 0) + 1;
        const r = rows[0];
        items.add({changed: r.changed, patternId: r.specPatternId, keys: '', schemaId: r.schemaId, elementId: el, attributeId: r.attributeId, value: 'XXX', source: 'Vehicle Specs', priority: -100, tbq: r.tbq});
      }
    }
    // 9. error codes from the characters the WMI's patterns allow
    if (!items.list.some(i => i.patternId !== null)) {
      returnCode += ' 8 '; correctedVin = ''; errorBytes = '';
    } else {
      const e = errorCodeStep(h, vin, varWmi, modelYear, wvs, items);
      returnCode = e.returnCode; correctedVin = e.correctedVin; errorBytes = e.errorBytes; unusedPositions = e.unusedPositions;
    }
  }
  const body = items.byElement(5);
  if (body.some(i => i.attributeId === '64')) returnCode += ' 9 ';
  let isOffRoad = false;
  if (body.some(i => OFFROAD_BODY.has(i.attributeId))) { returnCode += ' 10 '; isOffRoad = true; }
  if (modelYear === null) returnCode += ' 11 ';
  const vehicleType = items.byElement(39)[0]?.attributeId ?? null;
  const isException = !!h.q.exception.get(vin);
  let startPos = 13, carMpvLt = false;
  if (vin.charAt(2) === '9') startPos = 15;
  else if (isCarLt(wmiRow)) { startPos = 13; carMpvLt = true; } else startPos = 14;
  let invalid = '';
  for (let j = 1; j <= vin.length; j++) {
    if (j === 9 && (isOffRoad || isException)) continue;
    let chr = vin.charAt(j - 1);
    const bad = (j !== 9 && j < startPos && !/^[0-9ABCDEFGHJKLMNPRSTUVWXYZ*]$/.test(chr)) || (j !== 9 && j >= startPos && !/^[0-9*]$/.test(chr))
      || (j === 9 && !/^[0-9X*]$/.test(chr)) || (j === 10 && !/^[1-9ABCDEFGHJKLMNPRSTVWXY]$/.test(chr));
    if (bad) {
      if (chr === '') chr = '_';
      if (correctedVin === '') correctedVin = vin;
      invalid += `, ${j}:${chr}`;
      if (correctedVin !== null) correctedVin = correctedVin.slice(0, j - 1) + '!' + correctedVin.slice(j, j + 100);
    }
  }
  if (invalid) returnCode += ' 400 ';
  if (error12) returnCode += ' 12 ';
  // defaults for the vehicle type, for elements nothing decoded
  if (vehicleType !== null && /^\d+$/.test(vehicleType)) {
    const present = new Set(items.list.map(i => i.elementId));
    const seen = new Set();
    for (const dv of h.q.defaults.all(Number(vehicleType))) {
      if (present.has(dv.element_id)) continue;
      const e = h.elements.get(dv.element_id);
      if (!e) continue;
      const value = e.data_type === 'lookup' && dv.default_value === '0' ? 'Not Applicable' : 'XXX';
      const sig = `${dv.changed_us}|${dv.element_id}|${dv.default_value}|${value}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      items.add({changed: dv.changed_us, elementId: dv.element_id, attributeId: dv.default_value, value, source: 'Default', priority: 10});
    }
  }
  if (vin.length < 17) returnCode += ' 6 ';
  else {
    const cd = vin.charAt(8), calc = vinCheckDigit(vin, {variant: 2, carMpvLt});
    if (cd !== calc && !isException) returnCode += ' 1 ';
  }
  let errors = returnCode.split(' 9 ').join('').split(' 10 ').join('').split(' 12 ').join('').replace(/^ +| +$/g, '');
  if (errors === '' || errors === '14') returnCode = ' 0 ' + returnCode;
  const hasModel = items.list.some(i => i.elementId === 28);
  if (returnCode.includes(' 0 ') && !hasModel) returnCode += ' 14 ';
  let info = null;
  const errText = id => h.errorCodes.find(e => e.id === id)?.additional_text ?? '';
  if (returnCode.includes(' 4 ')) info = errText(4);
  if (returnCode.includes(' 5 ')) info = errText(5);
  const append = (txt, nullable = false) => {
    if (nullable === null) { info = null; return; }
    info = ((info ?? '') + txt).replace(/^ +| +$/g, '').slice(0, 500);
  };
  if (returnCode.includes(' 14 ')) { if (unusedPositions === null) info = null; else append(` Unused position(s): ${unusedPositions}. `); }
  if (invalid) append(` Invalid character(s): ${invalid.slice(2)}. `);
  if (vehicleType === '10' || body.some(i => INCOMPLETE_BODY.has(i.attributeId))) append(' Incomplete Vehicle Warning - Please be advised that the vehicle may have been altered and may not be an accurate representation of the vehicle in its current condition. ');
  if (!conclusive) append(' The Model Year decoded for this VIN may be incorrect. If you know the Model year, please enter it and decode again to get more accurate information. ');
  const codes = h.errorCodes.filter(e => returnCode.includes(` ${e.id} `));
  let messages = codes.length ? codes.map(e => (e.name + (isOffRoad && e.id === 1 ? ' NOTE: Disregard if this is an off-road vehicle PIN, as check digit calculation may not be accurate.'
    : isException && e.id === 0 ? ' NOTE: Check Digit Exception - The check digit was given an exception based on data from the OEM indicating an error on production.' : '')).replace(/^ +| +$/g, '')).join('; ') : null;
  if (messages !== null) messages = messages.slice(0, 500);
  const errorCodes = codes.length ? codes.map(e => e.id).join(',') : null;
  for (const [el, val] of [[142, correctedVin], [143, errorCodes], [191, messages], [144, errorBytes], [156, info], [196, vinDescriptor(vin)]]) {
    items.add({keys: '', elementId: el, attributeId: val, value: val, source: 'Corrections', priority: 999});
  }
  return {pass, modelYear, items: items.list, returnCode};
}

/** spvindecode_errorcode: characters the WMI allows per position (error codes 2-5) and unused positions (14). */
function errorCodeStep(h, vin, varWmi, modelYear, wvs, items) {
  let returnCode = '', correctedVin = '', errorBytes = '', unusedPositions = null;
  vin = vin.replace(/^ +| +$/g, '');
  if (varWmi.length < 3) return {returnCode: ' 6 ', correctedVin, errorBytes, unusedPositions};
  let enc = modelYear === null ? null : h.q.yearChars.get(varWmi, modelYear)?.chars ?? null;
  const allowed = new Map(); // position -> sorted string
  if (enc !== null) {
    enc.split(',').forEach((s, i) => { if (s) allowed.set(i + 4, s); });
  } else if (modelYear !== null) {
    const acc = new Map();
    for (const l of wvs) {
      if (!(modelYear >= l.year_from && modelYear <= (l.year_to ?? 2999)) || !l.valid_chars) continue;
      l.valid_chars.split(',').forEach((s, i) => { if (!s) return; const p = i + 4; if (!acc.has(p)) acc.set(p, new Set()); for (const c of s) acc.get(p).add(c); });
    }
    for (const [p, set] of acc) allowed.set(p, [...set].sort((a, b) => (a === '_' ? -1 : b === '_' ? 1 : cmpStr(a, b))).join(''));
  }
  const n = varWmi.length === 6 ? 11 : 14;
  let corrected = '', replacements = '', cntErrors = 0, lastErrorPos = 0, lastReplacements = '';
  for (let i = 4; i <= n && i <= vin.length; i++) {
    const c = vin.charAt(i - 1);
    let r;
    if (i === 9 || i === 10) r = c;
    else {
      const ok = allowed.get(i);
      if (ok) {
        if (ok.includes(c)) r = c;
        else { r = '!'; replacements += `(${i}:${ok})`; cntErrors++; lastErrorPos = i; lastReplacements = ok; }
      } else r = c;
    }
    corrected += r;
  }
  corrected = varWmi.length === 3 ? varWmi + corrected : varWmi.slice(0, 3) + corrected + varWmi.slice(-3);
  if (vin.length > corrected.length) corrected += vin.substr(corrected.length, 3);
  if (cntErrors === 1) {
    if (lastReplacements.length === 1) {
      returnCode += ' 2 ';
      correctedVin = vin.slice(0, lastErrorPos - 1) + lastReplacements + vin.substr(lastErrorPos, 17 - lastErrorPos);
      errorBytes = replacements;
    } else {
      let good = 0, newRepl = '', corrected1 = null;
      for (const c of lastReplacements) {
        const tmp = vin.slice(0, lastErrorPos - 1) + c + vin.substr(lastErrorPos, 17 - lastErrorPos);
        if (tmp.charAt(8) === vinCheckDigit(tmp, {variant: 1})) { good++; newRepl += c; corrected1 = tmp; }
      }
      if (good === 1) { returnCode += ' 3 '; correctedVin = corrected1; errorBytes = `(${lastErrorPos}:${newRepl})`; }
      else { returnCode += ' 4 '; correctedVin = corrected; errorBytes = `(${lastErrorPos}:${lastReplacements})`; }
    }
  }
  if (cntErrors > 1) { returnCode += ' 5 '; correctedVin = corrected; errorBytes = replacements; }
  // positions 4-8 and 11 that no decoded pattern names explicitly
  const used = new Map();
  for (const it of items.list) {
    if (!/pattern/i.test(it.source) || !it.keys) continue;
    for (const [p, set] of validCharsInKey(it.keys)) {
      if (!used.has(p)) used.set(p, new Set());
      for (const c of set) if (c !== '|') used.get(p).add(c);
    }
  }
  const ubound = Math.min(11, vin.length);
  const unused = [];
  for (let i = 4; i <= ubound; i++) {
    if (![4, 5, 6, 7, 8, 11].includes(i)) continue;
    if (!used.get(i - 3)?.has(vin.charAt(i - 1))) unused.push(i);
  }
  if (unused.length) { returnCode += ' 14 '; unusedPositions = unused.join(','); }
  return {returnCode, correctedVin, errorBytes, unusedPositions};
}

function errorValue(h, codes) {
  if (codes === null || codes === undefined) return 0;
  const set = new Set(String(codes).split(','));
  let w = 0, any = false;
  for (const e of h.errorCodes) if (set.has(String(e.id))) { w += e.weight ?? 0; any = true; }
  return any ? w : 0;
}

/** The value the API shows for an item: lookups resolved the way felementattributevalue does. */
function itemValue(h, it) {
  let v = it.value;
  if (v === 'XXX') {
    const e = h.elements.get(it.elementId);
    if (e && e.value_table) {
      const row = it.attributeId === null ? null : h.lookup(e.value_table, String(it.attributeId));
      v = row ? row.name : null;
    } else v = it.attributeId;
  }
  return v === null || v === undefined ? null : String(v).replace(/[\t\r\n]/g, ' ');
}

/**
 * Decode a VIN with the local vPIC copy. Options: {file, rules: 'fixed'|'pristine', semantics: 'mssql'|'pg', year, now, stats}.
 * Returns {available:true, vin, release, rules, pass, model_year, conclusive, elements: [...], values: {Code: text},
 * rule_fixes} or {available:false, reason}. `rule_fixes` is null unless a fix changed a value for this VIN; then
 * {changed: [{field, official_value, value, fix_ids}], fixes: [{id, case, reason, evidence, ...}]}, where
 * official_value is what NHTSA's own rules give (the same decode with rules 'pristine').
 */
export function decodeLocal(vinInput, {file = VPIC_DB_FILE, rules = 'fixed', semantics = 'mssql', year = null, now = new Date(), stats = null, collate = null} = {}) {
  let h;
  try { h = open(file); } catch (err) { return {available: false, reason: 'dataset_unreadable', error: err.message}; }
  if (!h) return {available: false, reason: 'dataset_not_indexed'};
  if (rules !== 'fixed' && rules !== 'pristine') return {available: false, reason: 'decode_failed', error: `rules ${rules}`};
  try {
    const vin = String(vinInput ?? '').replace(/^ +| +$/g, '').toUpperCase();
    if (vin.length > 17) return {available: false, reason: 'vin_too_long'};
    return h.db.transaction(() => { // one read lock per decode
      const opts = {semantics, year, now, stats, collate};
      const d = decodeIn(h, vin, {...opts, rules});
      d.rule_fixes = null;
      if (rules === 'fixed' && d.touched.size) d.rule_fixes = ruleFixDiff(h, d, decodeIn(h, vin, {...opts, rules: 'pristine'}));
      delete d.touched;
      return d;
    })();
  } catch (err) {
    return {available: false, reason: 'decode_failed', error: err.message};
  }
}

/** Element codes a fixed element feeds through unit conversions (DisplacementCI -> DisplacementL, DisplacementCC). */
function fedCodes(h, elementId) {
  const codes = new Set([h.elements.get(elementId)?.code]);
  for (const c of h.conversions) if (c.from_element_id === elementId) codes.add(h.elements.get(c.to_element_id)?.code);
  return codes;
}

/** Every field the fixed rules decode differently from NHTSA's own rules, with the fixes that were in reach. */
function ruleFixDiff(h, fixed, pristine) {
  const changed = [];
  const touched = [...fixed.touched].filter(id => h.fixEntries.has(id)).sort();
  const edits = [...h.fixBySchema.values(), ...h.fixBySpec.values()].flat().filter(f => fixed.touched.has(f.fix_id));
  for (const k of LIVE_VALUE_KEYS) {
    const a = pristine.values[k] ?? '', b = fixed.values[k] ?? '';
    if (a === b) continue;
    let ids = [...new Set(edits.filter(f => fedCodes(h, f.element_id).has(k)).map(f => f.fix_id))].sort();
    if (!ids.length) ids = touched; // a knock-on change (a fixed value selected other vehicle-spec rows)
    changed.push({field: k, official_value: a, value: b, fix_ids: ids});
  }
  if (!changed.length) return null;
  const used = [...new Set(changed.flatMap(c => c.fix_ids))].sort();
  return {release: h.meta.release, changed, fixes: used.map(id => h.fixEntries.get(id)).filter(Boolean),
    note: 'mcp.vin rule fixes (reviewed edits of NHTSA\'s vPIC rule tables) changed these values; official_value is what NHTSA\'s own rules decode.'};
}

function decodeIn(h, vin, {rules, semantics, year, now, stats, collate}) {
  {
    const ctx = {rules, touched: new Set(), semantics, nowUs: now.getTime() * 1000, stats, collate: collate || cmpStr};
    const vLimit = now.getUTCFullYear() + 2;
    const passes = [];
    let conclusive = false, rmy = null, omy = null, dmy = null;
    const wmiRow = h.q.wmi.get(vinWmi(vin)) || null;
    if (semantics !== 'pg') {
      const d = h.q.descriptor.get(vinDescriptor(vin));
      dmy = d ? d.model_year : null;
    }
    if (dmy !== null && dmy >= 1980 && dmy <= vLimit) {
      conclusive = true;
      const e12 = year !== null && year !== dmy;
      passes.push(core(h, ctx, 1, dmy, vin, vinDescriptor(vin), conclusive, e12));
    } else {
      rmy = vinModelYear(vin, wmiRow, now);
      conclusive = true;
      if (rmy !== null && rmy < 0) { omy = -rmy - 30; rmy = -rmy; conclusive = false; }
      if (conclusive && rmy !== null) {
        let alt = null;
        if (rmy >= 1980 && rmy <= vLimit - 30) alt = rmy + 30;
        else if (rmy >= 2010 && rmy <= vLimit) alt = rmy - 30;
        if (alt !== null && alt !== rmy && wmiRow) {
          const links = h.q.wvs.all(wmiRow.id);
          const cnt = y => links.filter(l => y >= l.year_from && y <= (l.year_to ?? 2999)).length;
          if (cnt(rmy) === 0 && cnt(alt) > 0) rmy = alt;
        }
      }
      let do34 = true;
      const myLabel = '***X*|Y';
      if (year !== null && year >= 1980 && year <= vLimit) {
        if (year === rmy || year === omy) do34 = true;
        else {
          const p2 = core(h, ctx, 2, year, vin, String(year), true, true);
          passes.push(p2);
          do34 = p2.returnCode.includes(' 8 ') && rmy !== null;
        }
      }
      if (do34) {
        passes.push(core(h, ctx, 3, rmy, vin, year !== null && year >= 1980 && year <= vLimit && year !== rmy && year !== omy ? String(year) : myLabel, conclusive,
          year !== null && rmy !== null && year !== rmy));
        if (omy !== null) passes.push(core(h, ctx, 4, omy, vin, myLabel, conclusive, year !== null && year !== omy));
      }
    }
    // best pass: fewest/lightest errors, then the heaviest decoded elements, then most pattern values, then year
    const scored = passes.map(p => {
      const ec = p.items.find(i => i.elementId === 143);
      const ev = ec ? errorValue(h, ec.value) : null;
      const wEls = new Map();
      for (const i of p.items) {
        const e = h.elements.get(i.elementId);
        if (e && e.weight !== null && (i.value ?? '') !== '') wEls.set(i.elementId, e.weight);
      }
      const ew = wEls.size ? [...wEls.values()].reduce((a, b) => a + b, 0) : null;
      const pc = p.items.filter(i => PATTERN_SOURCES.has(i.source) && !['', 'Not Applicable'].includes(i.value ?? '')).length || null;
      const myItem = p.items.find(i => i.elementId === 29);
      const my = myItem ? Number(myItem.value) + (year !== null && Number(myItem.value) === year ? 10000 : 0) : null;
      return {p, ev, ew, pc, my};
    });
    scored.sort((a, b) => descNull(a.ev, b.ev, semantics) || descNull(a.ew, b.ew, semantics) || descNull(a.pc, b.pc, semantics) || descNull(a.my, b.my, semantics));
    const best = scored[0].p;
    const kept = best.items.filter(i => i.tbq !== true && i.tbq !== 1);
    // output: public elements with a decode role
    const elements = [];
    for (const it of kept) {
      const e = h.elements.get(it.elementId);
      if (!e || !e.decode || e.is_private === 1) continue;
      elements.push({element_id: e.id, code: e.code, name: e.name, value: itemValue(h, it), attribute_id: it.attributeId, source: it.source,
        pattern_id: it.patternId, schema_id: it.schemaId, keys: it.keys, priority: it.priority, changed_us: it.changed, seq: it.id});
    }
    return {available: true, vin, release: h.meta.release, release_name: h.meta.release_name, built_at: h.meta.built_at, semantics, rules,
      rule_fixes_in_dataset: rules === 'fixed' ? h.fixEntries.size : 0,
      pass: best.pass, model_year: best.modelYear, conclusive, passes: passes.length, elements, values: flatValues(h, vin, kept), touched: ctx.touched};
  }
}

/**
 * DecodeVinValues shape: the live API's keys, '' when nothing decoded. A multi-valued element (notes) lists its
 * distinct values joined by ', ' as the live API does; the live API's order of those values is not stable (it
 * follows no column), so they are given in decode order.
 */
function flatValues(h, vin, items) {
  const byCode = new Map();
  for (const it of items) {
    const e = h.elements.get(it.elementId);
    if (!e || !e.code || e.is_private === 1 || !e.decode) continue;
    if (!byCode.has(e.code)) byCode.set(e.code, []);
    byCode.get(e.code).push(it);
  }
  const attr = el => items.find(i => i.elementId === el)?.attributeId ?? '';
  const out = {};
  for (const k of LIVE_VALUE_KEYS) {
    if (k === 'VIN') { out.VIN = vin; continue; }
    if (k === 'MakeID') { out.MakeID = String(attr(26) ?? ''); continue; }
    if (k === 'ManufacturerId') { out.ManufacturerId = String(attr(27) ?? ''); continue; }
    if (k === 'ModelID') { out.ModelID = String(attr(28) ?? ''); continue; }
    const vals = [];
    for (const it of byCode.get(k) || []) {
      const v = itemValue(h, it);
      if (v !== null && v !== '' && !vals.includes(v)) vals.push(v);
    }
    out[k] = vals.join(', ');
  }
  return out;
}

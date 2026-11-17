/**
 * Match a decoded VIN to FuelEconomy.gov configurations (pure functions, no I/O).
 *
 * Input rows are FuelEconomy.gov vehicle records: the web service's JSON or the vehicles.csv
 * row (same field names: model, baseModel, trany, drive, displ, cylinders, atvType, comb08...).
 *
 * Order:
 *  1. Model: EPA's model name must be the VIN's model followed only by words that describe a
 *     configuration (drive, powertrain, body, a few trim codes, a bracketed note) or words from the
 *     VIN's own trim. "Corolla Cross" is not a "Corolla"; "F150 Pickup 4WD" is an "F-150".
 *  2. Powertrain class is never substituted: electric, plug-in hybrid, hybrid, diesel and natural gas
 *     only match their own kind. A VIN that says nothing about electrification prefers non-hybrid rows.
 *  3. Every attribute the VIN states (engine size, cylinders, drive, transmission, speeds, turbo,
 *     trim, battery) must agree: exact. Otherwise the closest rows with what differs stated. Engine
 *     size is never relaxed; cylinders only when the engine size agrees (vPIC's cylinder count is
 *     sometimes wrong for the size it gives).
 *  4. One row: match 'exact' or 'closest'. Several: 'multiple_configurations' with the mpg range;
 *     nothing is picked.
 */

export const compact = v => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = v => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const clean = v => (v === undefined || v === null ? null : typeof v === 'string' ? (v.trim() || null) : v);

// Words in EPA model names that describe a configuration of the same model.
const DRIVE_WORDS = new Set(['2WD', '4WD', 'AWD', 'FWD', 'RWD', '4X4', '4X2', '2X4', '4MOTION', '4MATIC', '4MATIC+', 'QUATTRO', 'XDRIVE', 'SDRIVE', 'FF',
  'C10', 'K10', 'C15', 'K15', 'C1500', 'K1500', 'ALL4', 'EAWD']);
const POWER_WORDS = new Set(['HYBRID', 'HEV', 'PHEV', 'PLUGIN', 'PLUG', 'IN', 'EV', 'BEV', 'ELECTRIC', 'FFV', 'CNG', 'DIESEL', 'ETORQUE', 'MHEV', 'TURBO']);
const BODY_WORDS = {PICKUP: 'pickup', TRUCK: 'pickup', CAB: 'chassis', CHASSIS: 'chassis', VAN: 'van', CARGO: 'van', PASSENGER: 'van', WAGON: 'wagon', SPORTWAGEN: 'wagon',
  SPORTWAGON: 'wagon', AVANT: 'wagon', ESTATE: 'wagon', HATCHBACK: 'hatchback', SEDAN: 'sedan', COUPE: 'coupe', CONVERTIBLE: 'convertible',
  CABRIO: 'convertible', CABRIOLET: 'convertible', ROADSTER: 'convertible', SPYDER: 'convertible'};
// Trim codes EPA puts in model names of the same model (Camry HEV AWD SE/XLE, Titan 4WD PRO4X, 1500 HFE).
const TRIM_WORDS = new Set(['LE', 'XLE', 'XSE', 'SE', 'LTD', 'SEL', 'XFE', 'HFE', 'PRO4X', 'TRAILBOSS', 'BLUE', 'ECO']);
// Electric-drive configurations (Polestar "2 Dual Motor", Model 3 "Long Range AWD") and EPA's own generation
// names (Ram "1500 Classic"), which the VIN decode often cannot tell apart: kept as configurations, never preferred away.
const CONFIG_WORDS = new Set(['LONG', 'RANGE', 'STANDARD', 'EXTENDED', 'MID', 'DUAL', 'TWIN', 'SINGLE', 'TRI', 'QUAD', 'MOTOR', 'PERFORMANCE', 'CLASSIC']);
// Weight series in EPA names of the same model (Tahoe 1500 2WD, Express 1500/2500 2WD, Transit T150 Wagon): 1 = half ton, 2 = three-quarter, 3 = one ton.
const WEIGHT_WORDS = {1500: 1, 2500: 2, 3500: 3, T150: 1, T250: 2, T350: 3};
/** The VIN's weight series from vPIC's series, trim or model ("1/2 Ton", "1500 (1/2 ton)", "150"). */
function vinWeight(decoded) {
  const t = [decoded?.raw?.Series, decoded?.raw?.Series2, decoded?.vehicle?.trim, decoded?.raw?.Trim2, decoded?.vehicle?.model].filter(Boolean).join(' ');
  if (/1\/2\s*ton|\b1500\b|\b150\b/i.test(t)) return 1;
  if (/3\/4\s*ton|\b2500\b|\b250\b/i.test(t)) return 2;
  if (/\b1\s*ton|\b3500\b|\b350\b/i.test(t)) return 3;
  return null;
}
const GENERATION_PLANTS = [
  {make: /^(RAM|DODGE)$/i, model: /^1500$/, plant: /STERLING HEIGHTS/i, classic: false, note: 'built in Sterling Heights: the current Ram 1500, not the 1500 Classic'},
  {make: /^(RAM|DODGE)$/i, model: /^1500$/, plant: /^WARREN$/i, classic: true, note: 'built in Warren: the Ram 1500 Classic'},
];
const doorsOf = word => { const m = String(word).match(/^(\d)(?:DOORS?|DR)$/); return m ? Number(m[1]) : null; };

/** Tokens of an EPA model name: words outside brackets, and the bracketed notes. */
function nameParts(name) {
  const notes = [];
  const outside = String(name || '').replace(/\(([^)]*)\)/g, (_, inner) => { notes.push(inner.trim()); return ' '; })
    .replace(/\b(\d)\s*-?\s*(doors?|dr)\b/gi, '$1door');
  const tokens = outside.split(/[\s/]+/).filter(t => compact(t));
  return {words: tokens.map(compact), raw: tokens, notes};
}

/** Names to try for the VIN's model: as decoded, without a bracketed note ("Prius Prime (PHEV)"), without a leading make ("Mazda3"). */
export function modelAlternatives(model, make = '') {
  const out = new Set();
  const add = v => { const c = compact(v); if (c) out.add(c); };
  const m = String(model || '').replace(/&/g, ' and ');
  add(m);
  add(m.replace(/\([^)]*\)/g, ' '));
  const mk = compact(make);
  for (const v of [...out]) if (mk && v.startsWith(mk) && v.length > mk.length) out.add(v.slice(mk.length));
  const bare = m.replace(/\s+(MPV|SUV|CUV)\s*$/i, '');
  if (bare !== m) add(bare);
  return [...out];
}

/** The VIN decode's trim alternatives: "LE, XLE, SE" and "One/Two" list several possible trims. */
const trimAlternatives = decoded => String(decoded?.vehicle?.trim || '').split(/[,/]/).map(s => s.trim()).filter(Boolean);
const realTrim = decoded => [decoded?.vehicle?.trim, decoded?.raw?.Trim2].some(t => String(t || '').trim());
const vinTrimWords = decoded => new Set(String([decoded?.vehicle?.trim, decoded?.raw?.Trim2, decoded?.raw?.Series, decoded?.raw?.Series2].filter(Boolean).join(' '))
  .split(/[\s,/]+/).map(compact).filter(Boolean));

/**
 * How an EPA model name relates to the VIN's model: null (another model) or
 * {extra: residual words, trims: trim words, body: body kinds, notes}.
 */
export function nameRelation(epaModel, vinModel, {make = '', trimWords = new Set(), modelNumbers = false, prefix = false} = {}) {
  const {words, raw, notes} = nameParts(String(epaModel || '').replace(/&/g, ' and '));
  for (const want of modelAlternatives(vinModel, make)) {
    let acc = '', k = 0;
    while (k < words.length && acc.length < want.length) acc += words[k++];
    // Infiniti marks all-wheel drive with an x on the model (M37x, G37x Coupe).
    const infinitiX = acc === want + 'X' && compact(make) === 'INFINITI';
    if (acc !== want && !infinitiX) continue;
    const rest = words.slice(k), trims = [], body = [], weights = [], numbers = [];
    let ok = true;
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i];
      if (w === 'PLUG' && rest[i + 1] === 'IN') { i++; continue; }
      if (DRIVE_WORDS.has(w) || POWER_WORDS.has(w) || CONFIG_WORDS.has(w) || doorsOf(w)) continue;
      if (WEIGHT_WORDS[w]) { weights.push(WEIGHT_WORDS[w]); continue; }
      if (BODY_WORDS[w]) { body.push(BODY_WORDS[w]); continue; }
      if (TRIM_WORDS.has(w) || trimWords.has(w)) { trims.push(w); continue; }
      if (modelNumbers && /^\d{2,3}[A-Z]{0,4}$/.test(w)) { numbers.push(w); continue; }
      if (prefix) { trims.push(w); continue; }
      ok = false; break;
    }
    if (ok) return {extra: rest, extraRaw: raw.slice(k), trims, body: [...new Set(body)], notes, weights, numbers, infinitiX};
  }
  return null;
}

// ---- normalised attributes ----

export function vinPowertrain(decoded) {
  const e = decoded?.engine || {};
  const ev = String(e.ev_type || ''), fuel = String(e.fuel_type || ''), fuel2 = String(decoded?.raw?.FuelTypeSecondary || '');
  if (/plug|PHEV/i.test(ev)) return 'phev';
  if (/BEV|battery electric/i.test(ev)) return 'ev';
  if (/mild/i.test(ev)) return 'mhev';
  if (/hybrid|HEV/i.test(ev)) return 'hev';
  if (/^electric/i.test(fuel)) return 'ev';
  if (/diesel/i.test(fuel)) return 'diesel';
  if (/CNG|compressed natural|natural gas/i.test(fuel)) return 'cng';
  if (/flex|FFV|E85|ethanol/i.test(fuel + ' ' + fuel2)) return 'ffv';
  if (/gasoline/i.test(fuel)) return 'gas';
  return null;
}

export function rowPowertrain(row) {
  const atv = String(row.atvType || ''), fuel = String(row.fuelType || row.fuelType1 || ''), dscr = String(row.eng_dscr || '');
  if (/^EV$/i.test(atv) || (/electricity/i.test(fuel) && !row.fuelType2 && !num(row.displ))) return 'ev';
  if (/plug-in/i.test(atv)) return 'phev';
  if (/hybrid/i.test(atv)) return /mild|etorque|MHEV/i.test(dscr) ? 'mhev' : 'hev';
  if (/diesel/i.test(atv) || /diesel/i.test(fuel)) return 'diesel';
  if (/CNG|bifuel/i.test(atv) || /natural gas|CNG/i.test(fuel)) return 'cng';
  if (/FFV/i.test(atv) || /E85/i.test(fuel)) return 'ffv';
  return 'gas';
}

const POWER_LABEL = {ev: 'battery-electric', phev: 'plug-in hybrid', hev: 'hybrid', mhev: 'mild hybrid', diesel: 'diesel', cng: 'natural gas', ffv: 'flex-fuel', gas: 'gasoline'};

/** Powertrain tiers: rows of the first tier that has any are used. */
function powertrainTiers(vin) {
  switch (vin) {
    case 'ev': return [['ev']];
    case 'phev': return [['phev']];
    case 'hev': return [['hev'], ['mhev']];
    case 'mhev': return [['mhev', 'hev'], ['gas', 'ffv']];
    case 'diesel': return [['diesel']];
    case 'cng': return [['cng']];
    case 'ffv': return [['ffv'], ['gas', 'mhev']];
    case 'gas': return [['gas', 'ffv', 'mhev'], ['hev']];
    default: return [['gas', 'ffv', 'mhev', 'hev', 'phev', 'ev', 'diesel', 'cng']];
  }
}

export function vinDrive(decoded) {
  const d = String(decoded?.transmission?.drive_type || '');
  if (!d) return null;
  if (/2WD\s*\/\s*4WD|4WD\s*\/\s*2WD|4x2\s*\/\s*4x4|4x4\s*\/\s*4x2/i.test(d)) return null; // vPIC "2WD/4WD": either
  if (/4WD|AWD|4x4|all.wheel|4-wheel|6x6/i.test(d)) return 'all';
  if (/FWD|front/i.test(d)) return 'front';
  if (/RWD|rear/i.test(d)) return 'rear';
  if (/4x2|2WD|2x4/i.test(d)) return 'two';
  return null;
}

/**
 * Drive named in the decode's trim or series ("4Motion S", "GLE350-4M", "sDrive30i", "SH-AWD"). Every trim
 * alternative must name the same drive; an alternative that names none leaves the drive open.
 */
export function trimDrive(decoded) {
  const DRIVES = [[/(^|[^A-Z0-9])(AWD|4WD|4X4|4MOTION|4MATIC|4M|XDRIVE|QUATTRO|SH-?AWD|E-?AWD|ALL4|ALL[- ]WHEEL|4-WHEEL|FOUR[- ]WHEEL)(?![A-Z])/i, 'all'],
    [/(^|[^A-Z0-9])(FWD|FRONT[- ]WHEEL)(?![A-Z])/i, 'front'], [/(^|[^A-Z0-9])(RWD|SDRIVE|REAR[- ]WHEEL)(?![A-Z])/i, 'rear'], [/(^|[^A-Z0-9])(2WD|4X2)(?![A-Z0-9])/i, 'two']];
  const named = text => { const hits = DRIVES.filter(([re]) => re.test(text)).map(([, d]) => d); return hits.length === 1 ? hits[0] : hits.length ? 'mixed' : null; };
  const found = [];
  for (const field of [decoded?.vehicle?.trim, decoded?.raw?.Trim2, decoded?.raw?.Series, decoded?.raw?.Series2]) {
    const alts = String(field || '').split(/[,/]/).map(t => t.trim()).filter(Boolean);
    if (!alts.length) continue;
    const drives = alts.map(named);
    if (drives.every(d => d && d !== 'mixed') && new Set(drives).size === 1) found.push({drive: drives[0], text: String(field).trim()});
    else if (drives.some(Boolean)) return {drive: null, text: String(field).trim(), mixed: true};
  }
  if (!found.length) return {drive: null};
  return new Set(found.map(f => f.drive)).size === 1 ? found[0] : {drive: null, text: found.map(f => f.text).join('; '), mixed: true};
}

export function rowDrive(row) {
  const w = nameParts(row.model).words;
  if (w.some(x => ['AWD', '4WD', '4X4', '4MOTION', '4MATIC', 'QUATTRO', 'XDRIVE', 'K10', 'K15', 'K1500', 'ALL4', 'EAWD'].includes(x))) return 'all';
  if (w.some(x => ['FWD', 'FF'].includes(x))) return 'front';
  if (w.some(x => ['RWD', 'SDRIVE'].includes(x))) return 'rear';
  const d = String(row.drive || '');
  if (/4-wheel|all-wheel|4wd|awd/i.test(d)) return 'all';
  if (/front/i.test(d)) return 'front';
  if (/rear/i.test(d)) return 'rear';
  if (/2-wheel/i.test(d) || w.some(x => ['2WD', '4X2', 'C10', 'C15', 'C1500'].includes(x))) return 'two';
  return null;
}
const DRIVE_LABEL = {all: 'four/all-wheel drive', front: 'front-wheel drive', rear: 'rear-wheel drive', two: 'two-wheel drive'};
const driveAgrees = (vin, row) => vin === row || (vin === 'two' && (row === 'front' || row === 'rear')) || (row === 'two' && (vin === 'front' || vin === 'rear'));

export function vinTransmission(decoded) {
  const t = String(decoded?.transmission?.type || '');
  const speeds = num(decoded?.transmission?.speeds);
  if (!t) return {kind: null, speeds: null};
  if (/continuously|CVT/i.test(t)) return {kind: 'cvt', speeds: null};
  if (/manual|standard/i.test(t) && !/automated/i.test(t)) return {kind: 'manual', speeds};
  if (/dual.clutch|DCT|automated manual|AMT/i.test(t)) return {kind: 'am', speeds};
  if (/auto/i.test(t)) return {kind: 'auto', speeds};
  return {kind: null, speeds: null};
}

export function rowTransmission(row) {
  const t = String(row.trany || '');
  if (/^manual/i.test(t)) { const m = t.match(/(\d+)/); return {kind: 'manual', speeds: m ? Number(m[1]) : null}; }
  if (/variable|\(AV/i.test(t)) return {kind: 'cvt', speeds: null};
  if (/\(AM/i.test(t)) { const m = t.match(/(\d+)\)/); return {kind: 'am', speeds: m ? Number(m[1]) : null}; }
  if (/^auto/i.test(t)) { const m = t.match(/(\d+)/); return {kind: 'auto', speeds: m ? Number(m[1]) : null}; }
  return {kind: null, speeds: null};
}
const transAgrees = (vin, row) => {
  if (!vin || !row) return true;
  if (vin === 'auto') return row !== 'manual'; // vPIC says "Automatic" for many CVTs and dual-clutch boxes
  if (vin === 'cvt') return row === 'cvt';
  if (vin === 'am') return row === 'am' || row === 'auto';
  return vin === row;
};
const TRANS_LABEL = {manual: 'manual', auto: 'automatic', cvt: 'continuously variable', am: 'automated manual / dual-clutch'};

const bodyKind = decoded => {
  const b = String(decoded?.vehicle?.body_class || '');
  if (!b) return null;
  if (/pickup/i.test(b)) return 'pickup';
  if (/chassis|incomplete/i.test(b)) return 'chassis';
  if (/convertible|cabrio|roadster/i.test(b)) return 'convertible';
  if (/coupe/i.test(b)) return 'coupe';
  if (/hatchback|liftback/i.test(b)) return 'hatchback';
  if (/sedan|saloon/i.test(b)) return 'sedan';
  if (/wagon/i.test(b)) return 'wagon';
  if (/van/i.test(b)) return 'van';
  if (/sport utility|SUV|MPV|crossover/i.test(b)) return 'suv';
  return null;
};
// Body words in an EPA name that cannot be the VIN's body.
const bodyConflicts = (vinBody, rowBody) => {
  if (!vinBody) return false;
  return rowBody.some(b => {
    if (b === 'pickup') return vinBody !== 'pickup' && vinBody !== 'chassis';
    if (b === 'chassis') return vinBody !== 'chassis';
    if (b === 'convertible') return vinBody !== 'convertible';
    if (b === 'coupe') return !['coupe', 'convertible'].includes(vinBody);
    if (b === 'sedan') return vinBody !== 'sedan';
    if (b === 'hatchback') return !['hatchback', 'wagon', 'suv'].includes(vinBody);
    if (b === 'wagon') return !['wagon', 'hatchback', 'suv', 'van'].includes(vinBody);
    if (b === 'van') return !['van', 'wagon', 'suv'].includes(vinBody);
    return false;
  });
};

const turboRow = row => /^T$/i.test(String(row.tCharger || '').trim()) || /turbo/i.test(String(row.eng_dscr || '')) ? true : /^S|SC$/i.test(String(row.sCharger || '').trim()) ? 'super' : false;
/** Wheel sizes in EPA's bracket notes: "(20 and 22 Inch Wheels)", "(18in Wheels)" → [20, 22]. */
const rowWheels = notes => { const out = []; for (const n of notes) { if (!/wheel/i.test(n)) continue; for (const m of String(n).matchAll(/\b(1[4-9]|2[0-4])\b/g)) out.push(Number(m[1])); } return out; };
const batteryInNote = notes => { for (const n of notes) { const m = String(n).match(/(\d+(?:\.\d+)?)\s*kW-?hr/i); if (m) return Number(m[1]); } return null; };

/** One configuration in the output. */
/** Electric range in miles: a plug-in hybrid's all-electric range is rangeA; its `range` is gasoline plus electric. */
export function electricRange(row) {
  const kind = rowPowertrain(row);
  if (kind === 'phev') return num(row.rangeA) || null;
  return kind === 'ev' ? (num(row.range) || num(row.rangeCity) || null) : null;
}

export function configuration(row, efids = []) {
  const ev = rowPowertrain(row) === 'ev';
  return {
    vehicle_id: String(row.id), epa_model: clean(row.model), transmission: clean(row.trany), drive: clean(row.drive),
    displacement: num(row.displ), cylinders: num(row.cylinders), fuel_type: clean(row.fuelType) || clean(row.fuelType1), powertrain: POWER_LABEL[rowPowertrain(row)],
    engine_note: clean(row.eng_dscr), city_mpg: num(row.city08) || num(row.cityA08), highway_mpg: num(row.highway08) || num(row.highwayA08),
    combined_mpg: num(row.comb08) || num(row.combA08), unit: ev ? 'MPGe' : 'mpg', electric_range_mi: electricRange(row), efids,
    source_url: `https://www.fueleconomy.gov/feg/Find.do?action=sbs&id=${row.id}`,
  };
}

const rangeOf = values => { const v = values.filter(x => typeof x === 'number' && x > 0); return v.length ? {min: Math.min(...v), max: Math.max(...v)} : null; };
const span = r => (r ? (r.min === r.max ? String(r.min) : `${r.min}-${r.max}`) : null);

/**
 * Match decoded VIN data to FuelEconomy.gov rows of the same model year and make.
 * efidsOf(row) gives a row's EPA test groups. Returns {status, ...}:
 *  - status 'none': {reason, basis}
 *  - status 'one': {row, match: 'exact'|'closest', basis, differs}
 *  - status 'several': {rows, basis, differs_in}
 */
export function matchRows(decoded, rows, {make = '', efidsOf = () => []} = {}) {
  const v = decoded?.vehicle || {}, e = decoded?.engine || {};
  const trimWords = vinTrimWords(decoded);
  const basis = [];
  const gvwrMin = num(String(decoded?.dimensions?.gvwr || decoded?.raw?.GVWR || '').replace(/,/g, '').match(/(\d{4,5})\s*-/)?.[1]);
  const heavy = gvwrMin > 8500 && ['pickup', 'chassis', 'van'].includes(bodyKind(decoded))
    ? `gross vehicle weight rating over 8,500 lb (${decoded?.dimensions?.gvwr || decoded?.raw?.GVWR}): EPA fuel economy ratings do not cover heavy-duty pickups and vans` : null;
  // A 2500/3500 or HD series is never matched to the light-duty listings of the same name.
  if (heavy && /\b(2500|3500|4500|250|350|450|HD|super duty)\b/i.test([v.model, v.trim, decoded?.raw?.Series, decoded?.raw?.Series2].filter(Boolean).join(' '))) {
    return {status: 'none', reason: 'heavy_duty_not_rated', basis: [heavy]};
  }
  // 1. model name
  const vp = vinPowertrain(decoded);
  let generationNote = null;
  const relate = (name, opts = {}) => { const out = []; for (const row of rows) { const rel = nameRelation(row.model, name, {make, trimWords, ...opts}); if (rel) out.push({row, rel}); } return out; };
  let cands = [], nameNote = null;
  const series = clean(decoded?.raw?.Series);
  if (series && /[A-Z]/i.test(series) && series.split(/\s+/).length <= 3 && !/ton\b/i.test(series)) {
    // MINI: vPIC model "Cooper Convertible" or "Countryman", series "Cooper S"; EPA "Cooper S Convertible", "Cooper S Countryman".
    const mw = String(v.model || '').split(/\s+/), sw = series.split(/\s+/);
    const merged = compact(mw[0]) === compact(sw[0]) ? [...sw, ...mw.slice(1)].join(' ') : `${series} ${v.model}`;
    if (compact(merged) !== compact(v.model)) {
      cands = relate(merged);
      if (cands.length) nameNote = `EPA lists this model with its series (${merged})`;
    }
  }
  if (!cands.length) cands = relate(v.model);
  if (!cands.length) {
    // EPA names some lines by trim (BMW "328i xDrive" in base model "3 Series", Mercedes "ML350 4matic" in base model "ML-Class"):
    // the trim must start the EPA name; a trim without a model number must also share EPA's base model.
    const base = modelAlternatives(v.model, make);
    const trims = [...new Set(trimAlternatives(decoded).flatMap(t => [t, t.split(/[\s-]+/)[0]]))];
    for (const row of rows) {
      for (const t of trims) {
        if (!base.includes(compact(row.baseModel)) && !(/\d/.test(t) && /[A-Z]/i.test(t) && t.length >= 3)) continue;
        const rel = nameRelation(row.model, t, {make, trimWords});
        if (rel) { cands.push({row, rel}); nameNote = `EPA lists this model by trim (${t})`; break; }
      }
    }
  }
  if (!cands.length && series) {
    // MINI: vPIC model "Hardtop", series "Cooper"; EPA "Cooper (3-doors)".
    cands = relate(series);
    if (cands.length) nameNote = `EPA lists this model by its series name (${series})`;
  }
  if (!cands.length) {
    // vPIC prefixes some models with a sister model ("Corolla Matrix"); EPA lists the "Matrix". Used only when the first
    // word is itself a model EPA lists and the rest is another.
    const words = String(v.model || '').split(/\s+/);
    if (words.length > 1 && relate(words[0]).length) {
      const rest = words.slice(1).join(' ');
      cands = relate(rest);
      if (cands.length) nameNote = `EPA lists the ${v.model} as ${rest}`;
    }
  }
  let subName = null;
  if (!cands.length) {
    // A sub-name EPA does not list (vPIC "Versa Note"; EPA rates it under "Versa"): the listings of the leading name,
    // never as an exact match, saying so.
    const words = String(v.model || '').split(/\s+/);
    for (let k = words.length - 1; k >= 1 && !cands.length; k--) {
      const head = words.slice(0, k).join(' '), tail = words.slice(k).join(' ');
      if (rows.some(r => compact(r.model).includes(compact(tail)))) break;
      cands = relate(head);
      if (cands.length) { subName = `EPA lists no ${v.model}; its ${head} listings are shown`; nameNote = subName; }
    }
  }
  // A mild hybrid is listed by EPA as a hybrid (2012 "Regal eAssist"): one family for this step.
  const family = p => (p === 'mhev' ? 'hev' : p);
  if (['ev', 'phev', 'hev', 'mhev'].includes(vp) && !cands.some(c => family(rowPowertrain(c.row)) === family(vp))) {
    // EPA names some electric versions on their own (F-150 Lightning, Fusion Energi, S60 T8 AWD Recharge, Regal
    // eAssist): the model name followed by any words, for rows of the VIN's own electric powertrain only.
    const electric = relate(v.model, {prefix: true}).filter(c => family(rowPowertrain(c.row)) === family(vp));
    if (electric.length) { cands = electric; nameNote = `EPA lists the ${POWER_LABEL[vp]} version under its own name (${[...new Set(electric.map(c => c.row.model))].slice(0, 3).join(', ')})`; }
  }
  if (!cands.length) return {status: 'none', reason: heavy ? 'heavy_duty_not_rated' : 'not_found', basis: heavy ? [heavy] : [`no EPA model name for this model year matches "${v.model}"`]};
  // Generations sold side by side under one vPIC model name, told apart by the assembly plant (checked on NHTSA's test
  // trucks: every 2019-2020 Ram 1500 from Warren was a 1500 Classic, every one from Sterling Heights the new 1500).
  const plant = String(decoded?.raw?.PlantCity || '');
  for (const g of GENERATION_PLANTS) {
    if (!g.make.test(String(v.make || make)) || !g.model.test(String(v.model || '')) || !g.plant.test(plant)) continue;
    const fit = cands.filter(c => c.rel.extra.includes('CLASSIC') === g.classic);
    if (fit.length && fit.length < cands.length) { cands = fit; generationNote = g.note; }
  }
  // Weight series: a half-ton VIN is never matched to a 2500 listing.
  const weight = vinWeight(decoded);
  let weightNote = null;
  if (weight && cands.some(c => c.rel.weights.length)) {
    const fit = cands.filter(c => !c.rel.weights.length || c.rel.weights.includes(weight));
    const label = {1: 'half ton / 1500', 2: 'three-quarter ton / 2500', 3: 'one ton / 3500'}[weight];
    // Never another weight series: a 2012 Ram 2500 is not rated by EPA, whatever the 1500 gets.
    if (!fit.length) return {status: 'none', reason: weight >= 2 ? 'heavy_duty_not_rated' : 'no_matching_variant', basis: [`weight series ${label}: EPA lists this model only as ${[...new Set(cands.flatMap(c => c.rel.weights))].map(w => ({1: '1500', 2: '2500', 3: '3500'}[w])).join(', ')}`]};
    cands = fit; weightNote = `weight series (${label})`;
  }
  const vinBody = bodyKind(decoded);
  const bodyFit = cands.filter(c => !bodyConflicts(vinBody, c.rel.body));
  if (!bodyFit.length) return {status: 'none', reason: heavy ? 'heavy_duty_not_rated' : 'no_matching_variant', basis: [`EPA lists "${v.model}" only with another body style (${[...new Set(cands.map(c => c.row.model))].slice(0, 4).join(', ')})`]};
  cands = bodyFit;
  basis.push(nameNote || 'same model year, make and model name');
  if (generationNote) basis.push(generationNote);
  if (weightNote) basis.push(weightNote);

  // 2. powertrain class: never another kind (the preferred kinds are chosen after the engine size below)
  const tiers = powertrainTiers(vp);
  const compatible = cands.filter(c => tiers.some(t => t.includes(rowPowertrain(c.row))));
  if (!compatible.length) {
    return {status: 'none', reason: 'no_matching_variant',
      basis: [...basis, `the VIN says ${POWER_LABEL[vp] || vp}; EPA lists this model only as ${[...new Set(cands.map(c => POWER_LABEL[rowPowertrain(c.row)]))].join(', ')}`]};
  }
  cands = compatible;

  // 3. attributes the VIN states
  const displ = num(e.displacement_l) > 0 ? num(e.displacement_l) : null;
  const cyl = num(e.cylinders) > 0 ? num(e.cylinders) : null;
  // Drive: the decode's drive type; when it has none, a drive the trim names. When the two disagree, neither is used.
  const decodedDrive = vinDrive(decoded), named = trimDrive(decoded);
  let drive = decodedDrive;
  if (!decodedDrive && named.drive) { drive = named.drive; basis.push(`drive from the trim (${named.text})`); }
  else if (decodedDrive && named.drive && !driveAgrees(decodedDrive, named.drive)) {
    drive = null;
    basis.push(`drive not used: the decode says ${DRIVE_LABEL[decodedDrive]}, its trim (${named.text}) says ${DRIVE_LABEL[named.drive]}`);
  }
  const trans = vinTransmission(decoded);
  const turbo = /^yes$/i.test(String(e.turbo || '')) ? true : null;
  // Battery: vPIC's battery field, or the pack size Nissan writes into the engine note ("Motor (BAT:62kw)").
  const batNote = String(decoded?.raw?.OtherEngineInfo || '').match(/\bBAT\s*:\s*(\d+(?:\.\d+)?)\s*kw/i);
  const kwh = num(e.battery_kwh) || num(decoded?.raw?.BatteryKWh) || (batNote ? Number(batNote[1]) : null), kwhTo = num(decoded?.raw?.BatteryKWh_to) || kwh;
  const evLike = vp === 'ev';
  const motorText = [decoded?.raw?.OtherEngineInfo, decoded?.raw?.EngineConfiguration, decoded?.raw?.EngineModel].filter(Boolean).join(' ');
  if (!drive && evLike && /\b(dual|twin|two|2)[- ]motors?\b/i.test(motorText)) {
    // One motor per axle: a two-motor electric car drives all four wheels.
    drive = 'all'; basis.push(`drive from the motor count (${motorText.match(/\b(dual|twin|two|2)[- ]motors?\b/i)[0]})`);
  }
  let trimConflict = null;
  const beforeSize = cands;
  const sizeFits = c => !displ || num(c.row.displ) === null || Math.abs(num(c.row.displ) - Math.round(displ * 10) / 10) < 0.051;
  // Engine size is hard: rows of another size are other engines.
  if (displ && !evLike) {
    let sized = cands.filter(sizeFits);
    if (!sized.length) {
      // Model numbers name engines (Lexus NX 250 / NX 350): when the decode's trim points at a listing with another engine,
      // the listing of the same model with the VIN's engine size is shown as closest, saying so.
      const numbered = relate(v.model, {modelNumbers: true}).filter(c => c.rel.numbers.length && !bodyConflicts(vinBody, c.rel.body)
        && tiers.some(t => t.includes(rowPowertrain(c.row))) && num(c.row.displ) !== null && sizeFits(c));
      if (numbered.length) {
        const names = [...new Set(numbered.map(c => c.row.model.split(/\s+/).slice(0, 2).join(' ')))];
        trimConflict = `the VIN decode's trim (${v.trim || decoded?.raw?.Series}) names another engine; EPA lists the ${displ.toFixed(1)} L engine as ${names.join(', ')}`;
        sized = numbered;
      }
    }
    if (!sized.length) {
      const sizes = [...new Set(cands.map(c => num(c.row.displ)).filter(Boolean))].sort((a, b) => a - b);
      return {status: 'none', reason: 'no_matching_variant', basis: [...basis, `the VIN's ${displ.toFixed(1)} L engine is not among EPA's ${sizes.map(s => s.toFixed(1) + ' L').join(', ')} for this model`]};
    }
    cands = sized;
    basis.push(`${displ.toFixed(1)} L engine`);
  } else if (cyl && !evLike) {
    // No engine size: cylinders are then the engine attribute and are not relaxed.
    const fit = cands.filter(c => num(c.row.cylinders) === null || num(c.row.cylinders) === cyl);
    if (!fit.length) return {status: 'none', reason: 'no_matching_variant', basis: [...basis, `no ${cyl}-cylinder engine for this model`]};
    cands = fit;
    basis.push(`${cyl} cylinders`);
  } else if (!evLike) basis.push('engine size not checked (not in the VIN decode)');
  const checks = [];
  if (displ && cyl && !evLike) checks.push({key: 'cylinders', weight: 2, label: `${cyl} cylinders`, agree: r => num(r.cylinders) === null || num(r.cylinders) === cyl,
    differ: rs => `the VIN says ${cyl} cylinders; EPA lists the ${displ.toFixed(1)} L engine with ${[...new Set(rs.map(r => num(r.cylinders)))].join(' or ')}`});
  if (drive) checks.push({key: 'drive', weight: 3, label: DRIVE_LABEL[drive], agree: r => { const d = rowDrive(r); return !d || driveAgrees(drive, d); },
    differ: rs => `the VIN says ${DRIVE_LABEL[drive]}; EPA lists ${[...new Set(rs.map(r => DRIVE_LABEL[rowDrive(r)] || r.drive))].join(', ')}`});
  if (trans.kind && !evLike) checks.push({key: 'transmission', weight: 2, label: `${TRANS_LABEL[trans.kind]} transmission`, agree: r => transAgrees(trans.kind, rowTransmission(r).kind),
    differ: rs => `the VIN says ${TRANS_LABEL[trans.kind]}; EPA lists ${[...new Set(rs.map(r => r.trany))].join(', ')}`});
  if (trans.speeds > 1 && trans.kind !== 'cvt' && !evLike) checks.push({key: 'speeds', weight: 1, label: `${trans.speeds} speeds`, agree: r => { const s = rowTransmission(r).speeds; return !s || s === trans.speeds; },
    differ: rs => `the VIN says ${trans.speeds} speeds; EPA lists ${[...new Set(rs.map(r => r.trany))].join(', ')}`});
  if (turbo && !evLike) checks.push({key: 'turbo', weight: 2, label: 'turbocharged', agree: r => turboRow(r) === true,
    differ: () => 'the VIN says turbocharged; EPA does not mark this engine as turbocharged'});
  const kwhText = kwhTo > kwh ? `${kwh}-${kwhTo} kWh` : `${kwh} kWh`;
  if (kwh && evLike) checks.push({key: 'battery', weight: 1, label: `${kwhText} battery`, agree: r => { const b = batteryInNote(nameParts(r.model).notes); return b === null || (b >= kwh - 2 && b <= kwhTo + 2); },
    differ: rs => `the VIN says a ${kwhText} battery; EPA lists ${rs.map(r => batteryInNote(nameParts(r.model).notes)).filter(Boolean).join(', ')} kWh packs`});
  const doors = num(v.doors) || num(decoded?.raw?.Doors);
  const rowDoors = r => { const p = nameParts(r.model); for (const w of p.words) if (doorsOf(w)) return doorsOf(w); for (const n of p.notes) { const m = n.match(/(\d)\s*-?\s*doors?/i); if (m) return Number(m[1]); } return null; };
  if (doors && cands.some(c => rowDoors(c.row))) checks.push({key: 'doors', weight: 1, label: `${doors} doors`, agree: r => { const d = rowDoors(r); return !d || d === doors; },
    differ: rs => `the VIN says ${doors} doors; EPA lists ${[...new Set(rs.map(r => r.model))].join(', ')}`});
  // Powertrain kind: the first tier with a configuration that fits every other attribute, else the first tier listed
  // (a flex-fuel VIN gets EPA's gasoline listing when only that one has the VIN's drive: 2012 Journey AWD).
  const inTier = tier => cands.filter(c => tier.includes(rowPowertrain(c.row)));
  const tierFit = tiers.find(t => inTier(t).some(c => checks.every(k => k.agree(c.row)))) || tiers.find(t => inTier(t).length);
  if (tierFit) cands = inTier(tierFit);
  const kinds = new Set(cands.map(c => rowPowertrain(c.row)));
  if (vp) basis.push(`${POWER_LABEL[vp]} powertrain`);
  // Labels that differ without another powertrain: EPA flags mild hybrids and flex-fuel engines unevenly.
  if (vp === 'mhev' && !kinds.has('mhev') && !kinds.has('hev')) basis.push('the VIN says mild hybrid; EPA does not mark this engine as a hybrid');
  if (vp === 'ffv' && !kinds.has('ffv')) basis.push('the VIN says flex-fuel; EPA lists this engine as gasoline');
  if (vp === 'gas' && kinds.has('ffv')) basis.push("EPA lists this engine as flex-fuel; its gasoline figures are shown");
  if (vp === 'gas' && kinds.size === 1 && kinds.has('hev')) basis.push('EPA lists this model only as a hybrid');
  if (!drive && !basis.some(b => b.startsWith('drive not used'))) basis.push('drive not checked (not in the VIN decode)');
  if (!trans.kind && !evLike) basis.push('transmission not checked (not in the VIN decode)');

  let exact = cands.filter(c => checks.every(k => k.agree(c.row)));
  let chosen, match, differs = [];
  let driveListing = null;
  if (!exact.length && drive) {
    // EPA lists some drive versions only with trim names ("Prologue FWD", then "Prologue AWD Elite", "Prologue AWD
    // Touring"): listings named model + drive word + other words that fit every attribute, shown as closest.
    const named = relate(v.model, {prefix: true}).filter(c => !cands.includes(c) && DRIVE_WORDS.has(c.rel.extra[0]) && c.rel.trims.length
      && !cands.some(x => x.row === c.row) && !bodyConflicts(vinBody, c.rel.body) && tierFit?.includes(rowPowertrain(c.row)) && sizeFits(c) && checks.every(k => k.agree(c.row)));
    if (named.length) {
      exact = named;
      driveListing = `EPA lists the ${DRIVE_LABEL[drive]} ${v.model} only under trim names (${[...new Set(named.map(c => c.row.model))].slice(0, 4).join(', ')}), not the VIN's trim`;
    }
  }
  if (exact.length) {
    chosen = exact; match = trimConflict || subName || driveListing ? 'closest' : 'exact';
    if (trimConflict) differs.push(trimConflict);
    if (driveListing) differs.push(driveListing);
    if (subName) differs.push(subName);
    for (const k of checks) basis.push(k.label);
  } else {
    // Closest: most agreeing weight; what differs is stated.
    const score = c => checks.reduce((s, k) => s + (k.agree(c.row) ? k.weight : 0), 0);
    const best = Math.max(...cands.map(score));
    chosen = cands.filter(c => score(c) === best); match = 'closest';
    if (trimConflict) differs.push(trimConflict);
    if (subName) differs.push(subName);
    for (const k of checks) {
      if (chosen.every(c => k.agree(c.row))) basis.push(k.label);
      else differs.push(k.differ(chosen.map(c => c.row)));
    }
    // The decode's engine size against everything else it states: when only another engine size fits every other
    // attribute (Acura "TL SH-AWD" decoded as 3.5 L; EPA's all-wheel-drive TL is the 3.7 L), one of the two decode fields
    // is wrong, and the decode cannot say which: both are shown.
    const tier = new Set(cands.map(c => rowPowertrain(c.row)));
    const other = displ && !evLike && !trimConflict ? beforeSize.filter(c => !sizeFits(c) && tier.has(rowPowertrain(c.row)) && checks.every(k => k.agree(c.row))) : [];
    if (other.length && checks.length) {
      chosen = [...chosen, ...other];
      const sizes = [...new Set(other.map(c => `${Number(c.row.displ).toFixed(1)} L`))].join(', ');
      differs.push(`only EPA's ${sizes} configuration${other.length > 1 ? 's' : ''} fit${other.length > 1 ? '' : 's'} the VIN's other details; its decoded ${displ.toFixed(1)} L engine size or those details are wrong, so both are shown`);
    }
  }
  // Preferences inside the set: the VIN's trim named by EPA, a flex-fuel VIN's flex-fuel rows.
  // Trim: each trim the VIN decode allows keeps the EPA listings naming it, or else EPA's base listings.
  // Without a known drive the preference works inside each drive: "Tiguan S" (front-wheel drive) must not remove
  // "Tiguan 4motion", the all-wheel-drive listing of every trim.
  const alts = trimAlternatives(decoded);
  const driveGroups = rows => { if (drive) return [rows]; const g = new Map(); for (const c of rows) { const k = rowDrive(c.row) || '?'; if (!g.has(k)) g.set(k, []); g.get(k).push(c); } return [...g.values()]; };
  if (chosen.length > 1 && alts.length) {
    const keep = new Set(), named = new Set();
    for (const group of driveGroups(chosen)) {
      for (const alt of alts) {
        const words = new Set(alt.split(/[\s,/-]+/).map(compact).filter(Boolean));
        const hit = group.filter(c => c.rel.trims.some(t => words.has(t)));
        (hit.length ? hit : group.filter(c => !c.rel.trims.length)).forEach(c => keep.add(c));
        hit.forEach(c => c.rel.trims.filter(t => words.has(t)).forEach(t => named.add(t)));
      }
    }
    if (keep.size && keep.size < chosen.length) {
      chosen = chosen.filter(c => keep.has(c));
      basis.push(named.size ? `trim named by EPA (${[...named].join(', ')})` : "EPA's base listing (the VIN's trim is not one EPA lists separately)");
    }
  } else if (chosen.length > 1 && trimWords.size) {
    const named = [];
    for (const group of driveGroups(chosen)) { const hit = group.filter(c => c.rel.trims.some(t => trimWords.has(t))); named.push(...(hit.length ? hit : group)); }
    if (named.length < chosen.length) { chosen = named; basis.push(`trim named by EPA (${[...new Set(named.flatMap(c => c.rel.trims.filter(t => trimWords.has(t))))].join(', ')})`); }
  }
  // Words the decode states about the version, matched to EPA listing words: "Non-Performance" / "Dual Motor - Standard"
  // (not the Performance listing), "Motor: Performance", a trim's "LR" / "Long Range", and wheels named in the trim ('with 20"').
  const versionText = [decoded?.raw?.OtherEngineInfo, v.trim, decoded?.raw?.Trim2, decoded?.raw?.Series, decoded?.raw?.Series2].filter(Boolean).join(' ');
  const prefer = (test, label) => {
    if (chosen.length < 2) return;
    const fit = chosen.filter(test);
    if (fit.length && fit.length < chosen.length) { chosen = fit; basis.push(label); }
  };
  const has = (c, w) => c.rel.extra.includes(w);
  if (/non-?performance|motor\s*[-:]\s*standard/i.test(versionText)) prefer(c => !has(c, 'PERFORMANCE'), `not the Performance version (${versionText.match(/non-?performance|motor\s*[-:]\s*standard/i)[0]})`);
  else if (/\bperformance\b/i.test(String(decoded?.raw?.OtherEngineInfo || ''))) prefer(c => has(c, 'PERFORMANCE'), 'the Performance version (VIN decode)');
  // Trim words count only when every alternative the decode lists states the same ("Light, Light Long Range, Wind" does not).
  const stated = f => { const found = new Set(); for (const field of [v.trim, decoded?.raw?.Trim2, decoded?.raw?.Series]) { const alts = String(field || '').split(/[,/]/).map(t => t.trim()).filter(Boolean); if (!alts.length) continue; const vals = alts.map(f); if (vals.every(Boolean) && new Set(vals).size === 1) found.add(vals[0]); else if (vals.some(Boolean)) return null; } return found.size === 1 ? [...found][0] : null; };
  const rangeWord = stated(t => (/\bLR\b|long[- ]range/i.test(t) ? 'LONG' : /\bSR\b|standard[- ]range/i.test(t) ? 'STANDARD' : /extended[- ]range/i.test(t) ? 'EXTENDED' : null));
  if (rangeWord && evLike) prefer(c => has(c, rangeWord), `${rangeWord.toLowerCase()} range (from the trim)`);
  const wheelSize = stated(t => { const m = t.match(/\b(1[5-9]|2[0-3])\s*(?:"|''|-?\s*inch\b|in\b)/i); return m ? Number(m[1]) : null; });
  if (wheelSize) prefer(c => rowWheels(c.rel.notes).includes(wheelSize), `${wheelSize}-inch wheels (from the trim)`);
  // Body: a listing that names the VIN's body style wins over one that names none (Impreza Wagon for a wagon).
  const POSITIVE = {sedan: ['sedan'], hatchback: ['hatchback', 'wagon'], wagon: ['wagon', 'hatchback'], coupe: ['coupe'], convertible: ['convertible'], pickup: ['pickup'], van: ['van']};
  if (chosen.length > 1 && POSITIVE[vinBody]) {
    const named = chosen.filter(c => c.rel.body.some(b => POSITIVE[vinBody].includes(b)));
    if (named.length && named.length < chosen.length && named.some(c => !c.rel.body.includes('pickup'))) { chosen = named; basis.push(`EPA listing names the body style (${vinBody})`); }
  }
  if (chosen.length > 1 && vp === 'ffv') {
    const ffv = chosen.filter(c => rowPowertrain(c.row) === 'ffv');
    if (ffv.length) chosen = ffv;
  }
  // Duplicate listings (same EPA model, transmission, engine and figures) count once.
  const seen = new Map();
  for (const c of chosen) {
    const r = c.row, key = [r.model, r.trany, r.drive, num(r.displ), num(r.cylinders), num(r.comb08), num(r.city08), num(r.highway08), r.fuelType, r.eng_dscr].join('|');
    if (!seen.has(key)) seen.set(key, c);
  }
  chosen = [...seen.values()];
  if (chosen.length === 1) return {status: 'one', row: chosen[0].row, match, basis, differs, efids: efidsOf(chosen[0].row)};
  const rs = chosen.map(c => c.row);
  const {labels, separators} = describeDifferences(chosen);
  return {status: 'several', rows: rs, labels, match, basis, differs, differs_in: separators, efidsOf};
}

// ---- plain words for what separates several configurations ----

const DUPLICATE_RATING = 'EPA rates the same configuration more than once';
const ENGINE_FEATURES = [[/FFV|E85|flex/i, 'flex-fuel (E85)'], [/\bS?IDI\b|\bGDI\b|direct inj/i, 'direct injection'], [/\bPFI\b|port inj/i, 'port injection'],
  [/VCM|AFM|DFM|cyl(inder)? deact|ECO-?CYL/i, 'cylinder deactivation'], [/stop-?start|start-?stop|\bSS\b|\bISG\b/i, 'start-stop'], [/mild hybrid|MHEV|eTorque|48V/i, 'mild hybrid'],
  [/PZEV/i, 'PZEV emissions'], [/(\d{2,3})\s*HP/i, m => `${m[1]} hp`], [/full time 4WD/i, 'full-time 4WD'], [/part time 4WD/i, 'part-time 4WD'], [/\bCA model\b/i, 'California model'],
  [/high output|\bHO\b/i, 'high-output engine'], [/sport plus|5-mode/i, 'sport transmission modes']];
function plainTransmission(row) {
  const t = rowTransmission(row);
  if (t.kind === 'manual') return t.speeds ? `${t.speeds}-speed manual` : 'manual';
  if (t.kind === 'cvt') return 'continuously variable (CVT)';
  if (t.kind === 'am') return t.speeds ? `${t.speeds}-speed dual-clutch automatic` : 'dual-clutch automatic';
  if (t.kind === 'auto') return t.speeds ? `${t.speeds}-speed automatic` : 'automatic';
  return clean(row.trany);
}
function plainDrive(row) {
  const d = String(row.drive || '').toLowerCase();
  if (/part-time/.test(d)) return 'part-time four-wheel drive';
  if (/all-wheel/.test(d) && !/4-wheel/.test(d)) return 'all-wheel drive';
  if (/4-wheel/.test(d)) return 'four-wheel drive';
  return DRIVE_LABEL[rowDrive(row)] || clean(row.drive);
}
function engineFeatures(row) {
  const text = String(row.eng_dscr || '').replace(/FFV|E85|flex[- ]?fuel/gi, ' ');
  const out = [];
  for (const [re, label] of ENGINE_FEATURES) { const m = text.match(re); if (m) out.push(typeof label === 'function' ? label(m) : label); }
  return [...new Set(out)];
}
/** Listing words EPA adds to the model name beyond drive, powertrain, body and door words (Classic, Eco, XLE/LTD, PRO4X, Extended Range). */
function listingWords(c) {
  const skip = w => DRIVE_WORDS.has(w) || doorsOf(w) || BODY_WORDS[w] || ['HYBRID', 'HEV', 'PHEV', 'EV', 'BEV', 'ELECTRIC', 'PLUG', 'IN', 'PLUGIN', 'FFV'].includes(w);
  const words = (c.rel?.extraRaw || c.rel?.extra || []).filter(w => !skip(compact(w)) && !WEIGHT_WORDS[compact(w)]);
  const notes = (c.rel?.notes || []).map(n => n.replace(/(\d+)\s*-?\s*(?:in|inch)\b\.?/gi, '$1-inch').replace(/\bwheels\b/i, 'wheels'));
  return [words.join(' '), ...notes].filter(Boolean).join(', ');
}
/**
 * What separates several configurations, in plain words: one label per configuration ("6-speed automatic,
 * with start-stop") and the separating phrases for the summary ("6-speed automatic or 5-speed manual").
 */
export function describeDifferences(cands) {
  const rows = cands.map(c => c.row || c);
  const ATTRS = [
    ['transmission', plainTransmission],
    ['drive', plainDrive],
    ['engine', r => [num(r.displ) ? `${Number(r.displ).toFixed(1)} L` : null, num(r.cylinders) ? `${num(r.cylinders)}-cylinder` : null, turboRow(r) === true ? 'turbo' : turboRow(r) === 'super' ? 'supercharged' : null].filter(Boolean).join(' ') || null],
    ['powertrain', r => POWER_LABEL[rowPowertrain(r)]],
    ['start_stop', r => (r.startStop === 'Y' ? 'with start-stop' : r.startStop === 'N' ? 'without start-stop' : null)],
    ['listing', (r, i) => listingWords(cands[i]) || 'base listing'],
    ['electric_range', r => (electricRange(r) ? `${electricRange(r)} mi electric range` : null)],
    ['fuel', r => (/^regular/i.test(r.fuelType || '') ? 'regular gasoline' : /^premium/i.test(r.fuelType || '') ? 'premium gasoline' : null)],
  ];
  const labels = rows.map(() => []), separators = [];
  // Engine features EPA notes for some configurations only: "with or without direct injection".
  const feats = rows.map(r => new Set(engineFeatures(r).filter(f => f !== 'start-stop')));
  for (const f of [...new Set(feats.flatMap(x => [...x]))]) {
    if (feats.every(x => x.has(f))) continue;
    feats.forEach((x, i) => labels[i].push(x.has(f) ? `with ${f}` : `without ${f}`));
    separators.push(`with or without ${f}`);
  }
  for (const [key, f] of ATTRS) {
    const vals = rows.map((r, i) => f(r, i));
    const distinct = [...new Set(vals.filter(Boolean))];
    if (distinct.length < 2) continue;
    vals.forEach((v, i) => { if (v) labels[i].push(v); });
    if (key === 'start_stop') separators.push('with or without start-stop');
    else if (key === 'listing') separators.push(`EPA listing: ${distinct.join(' or ')}`);
    else separators.push(distinct.join(' or '));
  }
  if (!separators.length) separators.push(DUPLICATE_RATING);
  return {labels: labels.map(l => l.join(', ') || null), separators};
}

/** Summary sentence and range block for several configurations. */
export function severalSummary(rows, {differs_in = [], match = 'exact'} = {}) {
  const ev = rows.every(r => rowPowertrain(r) === 'ev'), mixed = !ev && rows.some(r => rowPowertrain(r) === 'ev');
  const unit = ev ? 'MPGe' : 'mpg';
  const comb = rangeOf(rows.map(r => num(r.comb08) || num(r.combA08)));
  const city = rangeOf(rows.map(r => num(r.city08) || num(r.cityA08)));
  const hwy = rangeOf(rows.map(r => num(r.highway08) || num(r.highwayA08)));
  const which = differs_in.length ? `: ${differs_in.join('; ')}` : '';
  const sameRating = !mixed && comb && comb.min === comb.max;
  const head = mixed || !comb ? `${rows.length} EPA configurations of this model`
    : sameRating ? `${comb.min} ${unit} combined for ${rows.length === 2 ? 'both' : `all ${rows.length}`} EPA configurations this VIN fits`
      : `${span(comb)} ${unit} combined across ${rows.length} EPA configurations of this model`;
  const dup = differs_in.length === 1 && differs_in[0] === DUPLICATE_RATING;
  const tail = sameRating ? `, so the figure holds whichever it is (${dup ? 'EPA lists this configuration more than once' : `they differ in${which ? which.slice(1) : ' details'}`})${match === 'closest' ? '; none matches every detail the VIN gives' : ''}`
    : match === 'closest' ? `; none matches every detail the VIN gives, and the VIN does not say which${which}` : `; the VIN does not say which${which}`;
  return {summary: head + tail, mpg_range: mixed ? null : {unit, combined: comb, city, highway: hwy}, same_rating: Boolean(sameRating)};
}

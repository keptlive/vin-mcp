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
  'C10', 'K10', 'C15', 'K15', 'C1500', 'K1500']);
const POWER_WORDS = new Set(['HYBRID', 'HEV', 'PHEV', 'PLUGIN', 'PLUG', 'IN', 'EV', 'BEV', 'ELECTRIC', 'FFV', 'CNG', 'DIESEL', 'ETORQUE', 'MHEV', 'TURBO']);
const BODY_WORDS = {PICKUP: 'pickup', CAB: 'chassis', CHASSIS: 'chassis', VAN: 'van', CARGO: 'van', PASSENGER: 'van', WAGON: 'wagon', SPORTWAGEN: 'wagon',
  SPORTWAGON: 'wagon', AVANT: 'wagon', ESTATE: 'wagon', HATCHBACK: 'hatchback', SEDAN: 'sedan', COUPE: 'coupe', CONVERTIBLE: 'convertible',
  CABRIO: 'convertible', CABRIOLET: 'convertible', ROADSTER: 'convertible', SPYDER: 'convertible'};
// Trim codes EPA puts in model names of the same model (Camry HEV AWD SE/XLE, Titan 4WD PRO4X, 1500 HFE).
const TRIM_WORDS = new Set(['LE', 'XLE', 'XSE', 'SE', 'LTD', 'SEL', 'XFE', 'HFE', 'PRO4X', 'TRAILBOSS', 'BLUE', 'ECO']);
// Electric-drive configurations (Polestar "2 Dual Motor", Model 3 "Long Range AWD") and EPA's own generation
// names (Ram "1500 Classic"), which the VIN decode often cannot tell apart: kept as configurations, never preferred away.
const CONFIG_WORDS = new Set(['LONG', 'RANGE', 'STANDARD', 'EXTENDED', 'MID', 'DUAL', 'SINGLE', 'TRI', 'QUAD', 'MOTOR', 'PERFORMANCE', 'CLASSIC']);
const doorsOf = word => { const m = String(word).match(/^(\d)(?:DOORS?|DR)$/); return m ? Number(m[1]) : null; };

/** Tokens of an EPA model name: words outside brackets, and the bracketed notes. */
function nameParts(name) {
  const notes = [];
  const outside = String(name || '').replace(/\(([^)]*)\)/g, (_, inner) => { notes.push(inner.trim()); return ' '; })
    .replace(/\b(\d)\s*-?\s*(doors?|dr)\b/gi, '$1door');
  return {words: outside.split(/[\s/]+/).map(compact).filter(Boolean), notes};
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
export function nameRelation(epaModel, vinModel, {make = '', trimWords = new Set()} = {}) {
  const {words, notes} = nameParts(String(epaModel || '').replace(/&/g, ' and '));
  for (const want of modelAlternatives(vinModel, make)) {
    let acc = '', k = 0;
    while (k < words.length && acc.length < want.length) acc += words[k++];
    if (acc !== want) continue;
    const rest = words.slice(k), trims = [], body = [];
    let ok = true;
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i];
      if (w === 'PLUG' && rest[i + 1] === 'IN') { i++; continue; }
      if (DRIVE_WORDS.has(w) || POWER_WORDS.has(w) || CONFIG_WORDS.has(w) || doorsOf(w)) continue;
      if (BODY_WORDS[w]) { body.push(BODY_WORDS[w]); continue; }
      if (TRIM_WORDS.has(w) || trimWords.has(w)) { trims.push(w); continue; }
      ok = false; break;
    }
    if (ok) return {extra: rest, trims, body: [...new Set(body)], notes};
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
  if (/4WD|AWD|4x4|all.wheel|4-wheel|6x6/i.test(d)) return 'all';
  if (/FWD|front/i.test(d)) return 'front';
  if (/RWD|rear/i.test(d)) return 'rear';
  if (/4x2|2WD|2x4/i.test(d)) return 'two';
  return null;
}

export function rowDrive(row) {
  const w = nameParts(row.model).words;
  if (w.some(x => ['AWD', '4WD', '4X4', '4MOTION', '4MATIC', 'QUATTRO', 'XDRIVE', 'K10', 'K15', 'K1500'].includes(x))) return 'all';
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
const batteryInNote = notes => { for (const n of notes) { const m = String(n).match(/(\d+(?:\.\d+)?)\s*kW-?hr/i); if (m) return Number(m[1]); } return null; };

/** One configuration in the output. */
export function configuration(row, efids = []) {
  const ev = rowPowertrain(row) === 'ev';
  return {
    vehicle_id: String(row.id), epa_model: clean(row.model), transmission: clean(row.trany), drive: clean(row.drive),
    displacement: num(row.displ), cylinders: num(row.cylinders), fuel_type: clean(row.fuelType) || clean(row.fuelType1), powertrain: POWER_LABEL[rowPowertrain(row)],
    engine_note: clean(row.eng_dscr), city_mpg: num(row.city08) || num(row.cityA08), highway_mpg: num(row.highway08) || num(row.highwayA08),
    combined_mpg: num(row.comb08) || num(row.combA08), unit: ev ? 'MPGe' : 'mpg', efids,
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
  let cands = [];
  for (const row of rows) {
    const rel = nameRelation(row.model, v.model, {make, trimWords});
    if (rel) cands.push({row, rel});
  }
  let nameNote = null;
  if (!cands.length) {
    // EPA names some lines by trim (BMW "328i xDrive" in base model "3 Series"): the trim must start the EPA name.
    const base = modelAlternatives(v.model, make);
    const trims = [...new Set(trimAlternatives(decoded).flatMap(t => [t, t.split(/[\s-]+/)[0]]))];
    for (const row of rows) {
      if (!base.includes(compact(row.baseModel))) continue;
      for (const t of trims) {
        const rel = nameRelation(row.model, t, {make, trimWords});
        if (rel) { cands.push({row, rel}); nameNote = `EPA lists this model by trim (${t})`; break; }
      }
    }
  }
  if (!cands.length && clean(decoded?.raw?.Series)) {
    // MINI: vPIC model "Hardtop", series "Cooper"; EPA "Cooper (3-doors)".
    const series = clean(decoded.raw.Series);
    for (const row of rows) { const rel = nameRelation(row.model, series, {make, trimWords}); if (rel) cands.push({row, rel}); }
    if (cands.length) nameNote = `EPA lists this model by its series name (${series})`;
  }
  if (!cands.length) return {status: 'none', reason: heavy ? 'heavy_duty_not_rated' : 'not_found', basis: heavy ? [heavy] : [`no EPA model name for this model year matches "${v.model}"`]};
  const vinBody = bodyKind(decoded);
  const bodyFit = cands.filter(c => !bodyConflicts(vinBody, c.rel.body));
  if (!bodyFit.length) return {status: 'none', reason: heavy ? 'heavy_duty_not_rated' : 'no_matching_variant', basis: [`EPA lists "${v.model}" only with another body style (${[...new Set(cands.map(c => c.row.model))].slice(0, 4).join(', ')})`]};
  cands = bodyFit;
  basis.push(nameNote || 'same model year, make and model name');

  // 2. powertrain class: never another kind (the preferred kinds are chosen after the engine size below)
  const vp = vinPowertrain(decoded);
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
  const drive = vinDrive(decoded);
  const trans = vinTransmission(decoded);
  const turbo = /^yes$/i.test(String(e.turbo || '')) ? true : null;
  const kwh = num(e.battery_kwh) || num(decoded?.raw?.BatteryKWh), kwhTo = num(decoded?.raw?.BatteryKWh_to) || kwh;
  const evLike = vp === 'ev';
  // Engine size is hard: rows of another size are other engines.
  if (displ && !evLike) {
    const sized = cands.filter(c => num(c.row.displ) === null || Math.abs(num(c.row.displ) - Math.round(displ * 10) / 10) < 0.051);
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
  for (const tier of tiers) {
    const fit = cands.filter(c => tier.includes(rowPowertrain(c.row)));
    if (fit.length) { cands = fit; break; }
  }
  const kinds = new Set(cands.map(c => rowPowertrain(c.row)));
  if (vp) basis.push(`${POWER_LABEL[vp]} powertrain`);
  // Labels that differ without another powertrain: EPA flags mild hybrids and flex-fuel engines unevenly.
  if (vp === 'mhev' && !kinds.has('mhev') && !kinds.has('hev')) basis.push('the VIN says mild hybrid; EPA does not mark this engine as a hybrid');
  if (vp === 'ffv' && !kinds.has('ffv')) basis.push('the VIN says flex-fuel; EPA lists this engine as gasoline');
  if (vp === 'gas' && kinds.has('ffv')) basis.push("EPA lists this engine as flex-fuel; its gasoline figures are shown");
  if (vp === 'gas' && kinds.size === 1 && kinds.has('hev')) basis.push('EPA lists this model only as a hybrid');

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
  if (!drive) basis.push('drive not checked (not in the VIN decode)');
  if (!trans.kind && !evLike) basis.push('transmission not checked (not in the VIN decode)');

  const exact = cands.filter(c => checks.every(k => k.agree(c.row)));
  let chosen, match, differs = [];
  if (exact.length) {
    chosen = exact; match = 'exact';
    for (const k of checks) basis.push(k.label);
  } else {
    // Closest: most agreeing weight; what differs is stated.
    const score = c => checks.reduce((s, k) => s + (k.agree(c.row) ? k.weight : 0), 0);
    const best = Math.max(...cands.map(score));
    chosen = cands.filter(c => score(c) === best); match = 'closest';
    for (const k of checks) {
      if (chosen.every(c => k.agree(c.row))) basis.push(k.label);
      else differs.push(k.differ(chosen.map(c => c.row)));
    }
  }
  // Preferences inside the set: the VIN's trim named by EPA, a flex-fuel VIN's flex-fuel rows.
  // Trim: each trim the VIN decode allows keeps the EPA listings naming it, or else EPA's base listings.
  const alts = trimAlternatives(decoded);
  if (chosen.length > 1 && alts.length) {
    const keep = new Set(), named = new Set();
    for (const alt of alts) {
      const words = new Set(alt.split(/[\s,/-]+/).map(compact).filter(Boolean));
      const hit = chosen.filter(c => c.rel.trims.some(t => words.has(t)));
      (hit.length ? hit : chosen.filter(c => !c.rel.trims.length)).forEach(c => keep.add(c));
      hit.forEach(c => c.rel.trims.filter(t => words.has(t)).forEach(t => named.add(t)));
    }
    if (keep.size && keep.size < chosen.length) {
      chosen = chosen.filter(c => keep.has(c));
      basis.push(named.size ? `trim named by EPA (${[...named].join(', ')})` : "EPA's base listing (the VIN's trim is not one EPA lists separately)");
    }
  } else if (chosen.length > 1 && trimWords.size) {
    const named = chosen.filter(c => c.rel.trims.some(t => trimWords.has(t)));
    if (named.length) { chosen = named; basis.push(`trim named by EPA (${[...new Set(named.flatMap(c => c.rel.trims.filter(t => trimWords.has(t))))].join(', ')})`); }
  }
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
  const varies = [];
  const vary = (label, f) => { const vals = [...new Set(rs.map(f))]; if (vals.length > 1) varies.push(`${label} (${vals.map(x => x ?? 'not stated').join('; ')})`); };
  vary('EPA listing', r => r.model); vary('transmission', r => r.trany); vary('drive', r => r.drive);
  vary('engine', r => [num(r.displ) && `${Number(r.displ).toFixed(1)} L`, num(r.cylinders) && `${num(r.cylinders)} cyl`, r.eng_dscr].filter(Boolean).join(' ') || null);
  vary('EPA electric range', r => (num(r.range) ? `${num(r.range)} mi` : null)); vary('motor', r => clean(r.evMotor));
  vary('turbo or supercharger', r => (turboRow(r) === true ? 'turbo' : turboRow(r) === 'super' ? 'supercharged' : 'none listed'));
  vary('powertrain', r => POWER_LABEL[rowPowertrain(r)]); vary('fuel', r => r.fuelType);
  return {status: 'several', rows: rs, match, basis, differs, differs_in: varies, efidsOf};
}

/** Summary sentence and range block for several configurations. */
export function severalSummary(rows, {differs_in = [], match = 'exact'} = {}) {
  const ev = rows.every(r => rowPowertrain(r) === 'ev'), mixed = !ev && rows.some(r => rowPowertrain(r) === 'ev');
  const unit = ev ? 'MPGe' : 'mpg';
  const comb = rangeOf(rows.map(r => num(r.comb08) || num(r.combA08)));
  const city = rangeOf(rows.map(r => num(r.city08) || num(r.cityA08)));
  const hwy = rangeOf(rows.map(r => num(r.highway08) || num(r.highwayA08)));
  const which = differs_in.length ? ` (they differ in ${differs_in.join(', ')})` : '';
  const head = mixed || !comb ? `${rows.length} EPA configurations of this model` : `${span(comb)} ${unit} combined across ${rows.length} EPA configurations of this model`;
  const tail = match === 'closest' ? '; none matches every detail the VIN gives, and the VIN does not say which' : '; the VIN does not say which';
  return {summary: head + tail + which, mpg_range: mixed ? null : {unit, combined: comb, city, highway: hwy}};
}

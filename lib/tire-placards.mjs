/**
 * NHTSA test-vehicle data, per vehicle NHTSA crash-tested, from its test reports:
 * - tire_placard: door-placard tire size and cold pressures (data-src/tire-placards.jsonl);
 * - test_vehicle_specs: usable fuel tank, payload (vehicle capacity weight), seating, GVWR/GAWR and the
 *   curb weight as delivered with its front/rear split (data-src/test-vehicle-specs.jsonl).
 * Both are built into data/tire-placards.db by scripts/import-tire-placards.py and keyed by the vPIC make,
 * model and model year of the test vehicle's own VIN.
 *
 * Closest match (owner rule 2026-11-17). Never estimated, blended or averaged: every value shown is one
 * tested vehicle's printed value, and every vehicle carries a `match` object saying how it relates to the VIN:
 * - exact: same make, model and model year, and no visible difference in trim, series, body, drive or
 *   electrification (as vPIC decodes the two VINs);
 * - nearest_model_year: another model year within MAX_YEAR_GAP; the nearest year wins and on a tie (one year
 *   older, one newer) both are returned. A year whose Transport Canada wheelbase differs from the VIN year's
 *   (a different generation) is ranked last (match.generation_check);
 * - different_variant: same model year, but a visible difference (listed in match.differences).
 * Only the best tier is returned (see tier() for the order).
 * A tested vehicle whose battery-electric class differs from the VIN's is never used (one vPIC model name can
 * cover a gasoline and an electric version). For capacities and weights, a tested vehicle with the same
 * electrification (hybrid, plug-in hybrid, none...) is preferred, and the fuel tank is never shown from one
 * whose electrification differs. The values describe NHTSA's test vehicle, not the decoded VIN: the owner's own
 * door placard and labels govern. Missing means not tested or not indexed, never zero.
 */
import Database from 'better-sqlite3';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dimensions as transportCanadaDimensions} from './research.mjs';

export const TIRE_PLACARDS_FILE = fileURLToPath(new URL('../data/tire-placards.db', import.meta.url));
/** Reach for nearest_model_year, proposed from the measured cross-year stability (docs/data-sources.md). */
export const MAX_YEAR_GAP = 2;

const SCOPE = 'nhtsa_test_vehicle';
const KG_PER_LB = 0.45359237, L_PER_GAL = 3.785411784;
const NOTE_MATCH = 'Tire size and cold pressures from the door placard of a vehicle NHTSA crash-tested, as printed in NHTSA\'s test report (reports print kPa; psi = kPa ÷ 6.895, rounded). Each vehicle\'s match says whether it is the same model year and version as this VIN. Not this VIN\'s placard: your own door placard governs; it can differ by year, trim and tire size.';
const NOTE_NONE = `NHTSA's crash-test reports in this index have no test vehicle of this make and model within ${MAX_YEAR_GAP} model years (not tested, or not indexed). Use the tire placard on the driver's door pillar.`;
const NOTE_OTHER_POWERTRAIN = 'NHTSA tested this make and model nearby only with a different powertrain (battery-electric or not), so its values are not shown. Use the tire placard on the driver\'s door pillar.';
const NOTE_UNAVAILABLE = 'The NHTSA test-vehicle index is not available, so this was not checked. Use the tire placard on the driver\'s door pillar.';
const SPECS_MATCH = 'Capacities and weights of a vehicle NHTSA crash-tested, as printed in its test report (certification label, seating table, vehicle capacity weight, usable fuel tank capacity, axle weights as delivered). Not this VIN\'s values: your own vehicle\'s labels and manual govern. A fuel tank from a tested vehicle that is not the same model year and version is labelled a best guess.';
const SPECS_NONE = `NHTSA's crash-test reports in this index have no test vehicle of this make and model within ${MAX_YEAR_GAP} model years (not tested, or not indexed). Capacities are on the door-pillar label and in the owner's manual.`;

/** Upper case, trimmed, inner spaces collapsed. Same rule as key() in the import script. */
export function keyName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * Powertrain class from vPIC FuelTypePrimary + ElectrificationLevel; same rule as powertrain() in the
 * research build. PHEV and hybrids count as not battery-electric; 'unknown' when vPIC gives neither.
 */
export function powertrainClass(fuelType, evType) {
  const fuel = String(fuelType ?? '').trim(), ev = String(evType ?? '').trim();
  if (/^BEV/i.test(ev)) return 'battery_electric';
  if (ev || fuel) return fuel.toLowerCase() === 'electric' && !ev ? 'battery_electric' : 'not_battery_electric';
  return 'unknown';
}

/**
 * Electrification from vPIC: battery_electric, plug_in_hybrid, fuel_cell, mild_hybrid, hybrid, or none (vPIC
 * gives a fuel type and no electrification level); null when vPIC gives neither (unknown).
 */
export function electrification(fuelType, evType) {
  const fuel = String(fuelType ?? '').trim(), ev = String(evType ?? '').trim();
  if (/^BEV/i.test(ev) || (!ev && /^electric$/i.test(fuel))) return 'battery_electric';
  if (/^PHEV|plug-?in/i.test(ev)) return 'plug_in_hybrid';
  if (/^FCEV|fuel\s*cell/i.test(ev)) return 'fuel_cell';
  if (/mild/i.test(ev)) return 'mild_hybrid';
  if (/HEV|hybrid/i.test(ev)) return 'hybrid';
  if (ev) return null;
  return fuel ? 'none' : null;
}

/** What the VIN decodes to, in the shape the matcher needs (from lib/nhtsa.mjs decodeVin). */
export function vinProfile(decoded) {
  const v = decoded?.vehicle || {}, e = decoded?.engine || {}, t = decoded?.transmission || {}, raw = decoded?.raw || {};
  return {make: v.make, model: v.model, year: v.year, trim: v.trim ?? null, series: raw.Series ?? null, body_class: v.body_class ?? null,
    drive_type: t.drive_type ?? null, fuelType: e.fuel_type ?? null, evType: e.ev_type ?? null};
}

const squash = s => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const options = s => String(s ?? '').split(/[/,;]/).map(squash).filter(Boolean);
function driveClass(v) {
  const s = String(v ?? '').toUpperCase();
  if (!s.trim()) return null;
  if (/AWD|4WD|4X4|ALL-WHEEL|4-WHEEL|FOUR/.test(s)) return 'all_or_four_wheel';
  if (/FWD|FRONT/.test(s)) return 'front';
  if (/RWD|REAR/.test(s)) return 'rear';
  if (/4X2|2WD/.test(s)) return 'two_wheel';
  return squash(s);
}
const sameDrive = (a, b) => a === b || (a === 'two_wheel' && ['front', 'rear'].includes(b)) || (b === 'two_wheel' && ['front', 'rear'].includes(a));

/** Visible differences between a tested vehicle (a db row) and the VIN, both as vPIC decodes them. */
export function variantDifferences(row, vin) {
  const out = [];
  const t = row.vpic_trim, y = vin.trim;
  if (t && y && !options(t).some(o => options(y).includes(o))) out.push({field: 'trim', tested: t, yours: y});
  if (row.vpic_series && vin.series && squash(row.vpic_series) !== squash(vin.series)) out.push({field: 'series', tested: row.vpic_series, yours: vin.series});
  if (row.body_class && vin.body_class && squash(row.body_class) !== squash(vin.body_class)) out.push({field: 'body', tested: row.body_class, yours: vin.body_class});
  const dt = driveClass(row.drive_type), dy = driveClass(vin.drive_type);
  if (dt && dy && !sameDrive(dt, dy)) out.push({field: 'drive', tested: row.drive_type, yours: vin.drive_type});
  const et = electrification(row.fuel_type, row.ev_type), ey = electrification(vin.fuelType, vin.evType);
  if (et && ey && et !== ey) out.push({field: 'electrification', tested: et, yours: ey});
  return out;
}

/**
 * Tier of a candidate (lower is closer). The owner's order is exact > nearest_model_year > different_variant;
 * a nearest-year vehicle that also differs in version is weaker than a same-year one that differs only in
 * version, and a year with a different wheelbase (another generation) is ranked last:
 *   1 exact · 2 nearest year, same version · 3 same year, different version · 4 nearest year, different version
 *   · 5 nearest year whose Transport Canada wheelbase differs from the VIN year's.
 */
function tier(c) {
  const variant = c.match.differences.some(d => d.field !== 'model_year');
  if (c.match.year_gap === 0) return variant ? 3 : 1;
  if (c.match.generation_check === 'different_wheelbase') return 5;
  return variant ? 4 : 2;
}

/**
 * The closest tested vehicles for one VIN, from rows of the same make and model (already powertrain-guarded):
 * all vehicles of the best tier; in a nearest-year tier only the nearest year(s), both when one is older and one
 * newer (a tie). Pure; `generations` maps tested year -> generation check; `prefer` ranks equals (higher first).
 */
export function selectClosest(rows, vin, {maxGap = MAX_YEAR_GAP, generations = new Map(), prefer = () => 0} = {}) {
  const year = Number(vin.year);
  const annotate = r => {
    const differences = variantDifferences(r, vin), gap = Math.abs(r.year - year);
    const kind = gap === 0 ? (differences.length ? 'different_variant' : 'exact') : 'nearest_model_year';
    return {row: r, match: {kind, tested_model_year: r.year, vin_model_year: year, year_gap: gap,
      differences: gap ? [{field: 'model_year', tested: r.year, yours: year}, ...differences] : differences,
      generation_check: gap ? generations.get(r.year) || 'unknown' : null}};
  };
  const all = rows.filter(r => Math.abs(r.year - year) <= maxGap).map(annotate);
  if (!all.length) return [];
  const best = Math.min(...all.map(tier));
  let chosen = all.filter(c => tier(c) === best);
  const gap = Math.min(...chosen.map(c => c.match.year_gap));
  chosen = chosen.filter(c => c.match.year_gap === gap);
  const genOrder = c => ({same_wheelbase: 0, unknown: 1, different_wheelbase: 2})[c.match.generation_check] ?? 0;
  return chosen.sort((a, b) => a.match.differences.length - b.match.differences.length || genOrder(a) - genOrder(b)
    || prefer(b.row) - prefer(a.row) || b.row.year - a.row.year
    || (a.row.confidence === 'high' ? 0 : 1) - (b.row.confidence === 'high' ? 0 : 1) || a.row.test_no - b.row.test_no);
}

/** Transport Canada wheelbases (cm) for one make/model/year, retrying once with the model's first word. */
async function wheelbases(make, model, year, dims) {
  const ask = async m => { try { return await dims({year: String(year), make, model: m}); } catch { return null; } };
  let r = await ask(model);
  if (r?.available && Array.isArray(r.data) && !r.data.length && /\s/.test(String(model).trim())) r = await ask(String(model).trim().split(/\s+/)[0]);
  if (!r?.available || !Array.isArray(r.data)) return null;
  const values = r.data.map(x => Number((x.Specs || []).find(s => s.Name === 'WB')?.Value)).filter(n => Number.isFinite(n) && n > 0);
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * Generation check for one tested year against the VIN year: Transport Canada wheelbases of both years
 * (cm); when the tested year has no record, the wheelbase NHTSA measured on that test vehicle (mm).
 */
export function compareWheelbases(vinCm, testedCm, measuredMm = []) {
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  if (vinCm?.length && testedCm?.length) {
    const covers = (xs, ys) => xs.every(x => ys.some(y => near(x, y, 1)));
    if (covers(vinCm, testedCm) || covers(testedCm, vinCm)) return 'same_wheelbase';
    if (!vinCm.some(x => testedCm.some(y => near(x, y, 1)))) return 'different_wheelbase';
    return 'unknown';
  }
  const mm = measuredMm.filter(n => Number.isFinite(n) && n > 0);
  if (vinCm?.length && mm.length) {
    const gaps = mm.map(m => Math.min(...vinCm.map(c => Math.abs(c * 10 - m))));
    if (gaps.every(g => g <= 15)) return 'same_wheelbase';
    if (gaps.every(g => g > 30)) return 'different_wheelbase';
  }
  return 'unknown';
}

const unavailable = (reason, note) => ({available: false, reason, scope: SCOPE, vin_specific: false, note});

function readRows(file, mk, md) {
  const db = new Database(file, {readonly: true, fileMustExist: true});
  try {
    const placards = db.prepare('SELECT * FROM placards WHERE make_key=? AND model_key=?').all(mk, md);
    const hasSpecs = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='specs'").get();
    const specs = hasSpecs ? db.prepare('SELECT * FROM specs WHERE make_key=? AND model_key=?').all(mk, md).map(r => ({...r, data: JSON.parse(r.data)})) : null;
    const meta = key => { const r = db.prepare('SELECT value FROM metadata WHERE key=?').get(key); return r ? JSON.parse(r.value) : null; };
    return {placards, specs, source: meta('source') || {}, specsSource: meta('specs_source')};
  } finally { db.close(); }
}

const round = (v, d = 0) => Math.round(v * 10 ** d) / 10 ** d;
const massBoth = (value, unit) => unit === 'lb' ? {kg: round(value * KG_PER_LB), lb: round(value)} : {kg: round(value), lb: round(value / KG_PER_LB)};
const tank = t => t && {litres: t.litres, gallons: round(t.litres / L_PER_GAL, 1),
  printed: t.printed != null && t.unit_printed ? `${t.printed} ${t.unit_printed}` : null};

function testedVehicle(r) {
  return {model_year: r.year, make: r.make, model: r.model, tested_as: r.tested_as, powertrain: r.powertrain,
    electrification: electrification(r.fuel_type, r.ev_type),
    ...(r.vpic_trim ? {vin_decoded_trim: r.vpic_trim} : {}), test_no: r.test_no, report_url: r.report_url};
}

function placardVehicle({row: r, match}) {
  return {...testedVehicle(r), match,
    tires: {front: r.tire_front, rear: r.tire_rear},
    cold_pressure_psi: {front: r.psi_front, rear: r.psi_rear},
    cold_pressure_kpa: {front: r.kpa_front, rear: r.kpa_rear},
    confidence: r.confidence, other_reports: JSON.parse(r.other_reports || '[]')};
}

function specsVehicle({row: r, match}) {
  const d = r.data, out = {...testedVehicle(r), match, test_type: r.test_type || null};
  if (d.fuel_tank_standard) out.fuel_tank = tank(d.fuel_tank_standard);
  if (d.fuel_tank_optional) out.fuel_tank_optional = tank(d.fuel_tank_optional);
  if (d.vehicle_capacity_weight_kg) out.payload_vehicle_capacity_weight = massBoth(d.vehicle_capacity_weight_kg, 'kg');
  if (d.seating) out.seating = d.seating;
  for (const k of ['gvwr', 'gawr_front', 'gawr_rear']) {
    if (d[k]) out[k] = {...massBoth(d[k].value, d[k].unit_printed), printed: `${d[k].value} ${d[k].unit_printed || '(no unit printed; read as kg)'}`};
  }
  if (d.curb_weight_kg) {
    const c = d.curb_weight_kg;
    out.curb_weight_as_delivered = {total: massBoth(c.total, 'kg'), front: massBoth(c.front, 'kg'), rear: massBoth(c.rear, 'kg'),
      front_percent: round(100 * c.front / c.total, 1)};
  }
  return out;
}

const ELEC_WORDS = {battery_electric: 'battery-electric', plug_in_hybrid: 'a plug-in hybrid', fuel_cell: 'fuel-cell', mild_hybrid: 'a mild hybrid', hybrid: 'a hybrid', none: 'not a hybrid or electric'};

/** The fuel tank summary: one or more tested vehicles' printed usable standard tank, never averaged. */
function fuelTankSummary(chosen, pool, vinElec, electrificationDiffers) {
  const vehicles = chosen.filter(c => c.row.data.fuel_tank_standard);
  const sizes = [];
  for (const c of pool.filter(c => c.row.data.fuel_tank_standard)) {
    const l = c.row.data.fuel_tank_standard.litres, hit = sizes.find(s => Math.abs(s.litres - l) <= 1);
    if (hit) hit.model_years = [...new Set([...hit.model_years, c.row.year])].sort();
    else sizes.push({litres: l, gallons: round(l / L_PER_GAL, 1), model_years: [c.row.year], electrification: electrification(c.row.fuel_type, c.row.ev_type)});
  }
  const modelSizes = sizes.length > 1 ? {model_tank_sizes: sizes.sort((a, b) => a.litres - b.litres)} : {};
  if (electrificationDiffers) {
    const tested = electrification(chosen[0].row.fuel_type, chosen[0].row.ev_type);
    return {shown: false, reason: 'different_electrification', ...modelSizes,
      note: `NHTSA's closest test vehicle is ${ELEC_WORDS[tested] || 'of unknown electrification'}, and this VIN ${vinElec ? `decodes as ${ELEC_WORDS[vinElec]}` : 'does not decode its electrification'}; tank sizes often differ between them, so no tank size is shown.`};
  }
  if (!vehicles.length) return {shown: false, reason: chosen.length ? 'not_printed_for_this_test_vehicle' : 'no_close_match', ...modelSizes};
  const values = [];
  for (const c of vehicles) {
    const l = c.row.data.fuel_tank_standard.litres;
    if (!values.some(v => Math.abs(v.litres - l) <= 1)) values.push({...tank(c.row.data.fuel_tank_standard), test_no: c.row.test_no, model_year: c.row.year, match_kind: c.match.kind});
  }
  const best = vehicles[0].match.kind !== 'exact';
  const optional = vehicles.map(c => c.row.data.fuel_tank_optional).find(Boolean);
  return {shown: true, best_guess: best, label: best ? 'best guess' : 'NHTSA test vehicle, same model year', values,
    ...(optional ? {optional_tank_listed: tank(optional)} : {}), ...modelSizes};
}

/**
 * Both blocks for one decoded VIN. Async only for the generation check (Transport Canada via vPIC, cached),
 * which runs only when a nearest_model_year match is in play. `dims` is injectable for tests.
 */
export async function lookupTestVehicleData(vin, options = {}) {
  try { return await lookup(vin, options); } catch (err) {
    console.error('[tire-placards] lookup failed:', err.message);
    const bad = unavailable('index_unreadable', NOTE_UNAVAILABLE);
    return {tire_placard: bad, test_vehicle_specs: bad};
  }
}

async function lookup(vin, {file = TIRE_PLACARDS_FILE, dims = transportCanadaDimensions, maxGap = MAX_YEAR_GAP} = {}) {
  if (!existsSync(file)) return {tire_placard: unavailable('dataset_not_indexed', NOTE_UNAVAILABLE), test_vehicle_specs: unavailable('dataset_not_indexed', NOTE_UNAVAILABLE)};
  const mk = keyName(vin.make), md = keyName(vin.model), year = Number(vin.year);
  if (!mk || !md || !Number.isInteger(year)) {
    const none = unavailable('no_vehicle', 'No make, model and model year to look up.');
    return {tire_placard: none, test_vehicle_specs: none};
  }
  let data;
  try { data = readRows(file, mk, md); } catch (err) {
    console.error('[tire-placards] lookup error:', err.message);
    const bad = unavailable('index_unreadable', NOTE_UNAVAILABLE);
    return {tire_placard: bad, test_vehicle_specs: bad};
  }
  const vinClass = powertrainClass(vin.fuelType, vin.evType), vinElec = electrification(vin.fuelType, vin.evType);
  const sameClass = r => vinClass === 'unknown' || r.powertrain === 'unknown' || r.powertrain === vinClass;
  const inReach = r => Math.abs(r.year - year) <= maxGap;
  const placards = data.placards.filter(sameClass), hiddenPlacards = data.placards.filter(r => !sameClass(r) && inReach(r)).length;
  const specsAll = (data.specs || []).filter(sameClass), hiddenSpecs = (data.specs || []).filter(r => !sameClass(r) && inReach(r)).length;
  const sameElec = specsAll.filter(r => { const e = electrification(r.fuel_type, r.ev_type); return e && vinElec && e === vinElec; });
  const specsPool = sameElec.some(inReach) ? sameElec : specsAll;
  const electrificationDiffers = specsPool !== sameElec;

  // Generation check only when a nearest-year vehicle can win for either block (no exact match).
  const needs = rows => rows.some(r => r.year !== year && inReach(r)) && !selectClosest(rows, vin, {maxGap}).some(c => c.match.kind === 'exact');
  const generations = new Map();
  if (needs(placards) || needs(specsPool)) {
    const years = [...new Set([...placards, ...specsPool].filter(r => r.year !== year && inReach(r)).map(r => r.year))];
    const vinWb = await wheelbases(vin.make, vin.model, year, dims);
    await Promise.all(years.map(async y => {
      const measured = (data.specs || []).filter(r => r.year === y && r.data.wheelbase_mm).map(r => r.data.wheelbase_mm);
      generations.set(y, compareWheelbases(vinWb, vinWb?.length ? await wheelbases(vin.make, vin.model, y, dims) : null, measured));
    }));
  }

  const source = {provider: 'NHTSA vehicle crash-test reports', indexed_at: data.source.indexed_at ?? null, dataset_generated_at: data.source.dataset_generated_at ?? null};
  const chosenTires = selectClosest(placards, vin, {maxGap, generations});
  const vehicles = chosenTires.map(placardVehicle);
  const tirePlacard = {
    available: true, ...(vehicles.length ? {match_kind: vehicles[0].match.kind} : {reason: hiddenPlacards ? 'other_powertrain_only' : 'no_close_match'}),
    scope: SCOPE, vin_specific: false, max_year_gap: maxGap, vehicles,
    ...(hiddenPlacards ? {other_powertrain_not_shown: hiddenPlacards} : {}),
    note: vehicles.length ? NOTE_MATCH : hiddenPlacards ? NOTE_OTHER_POWERTRAIN : NOTE_NONE, source,
  };

  let specs;
  if (!data.specs) specs = unavailable('dataset_not_indexed', NOTE_UNAVAILABLE);
  else {
    // Among equally close vehicles, the report with more of the shown fields comes first.
    const chosen = selectClosest(specsPool, vin, {maxGap, generations, prefer: r => Object.keys(r.data).length});
    const pool = specsAll.map(r => ({row: r}));
    specs = {
      available: true, ...(chosen.length ? {match_kind: chosen[0].match.kind} : {reason: hiddenSpecs ? 'other_powertrain_only' : 'no_close_match'}),
      scope: SCOPE, vin_specific: false, max_year_gap: maxGap, vehicles: chosen.map(specsVehicle),
      fuel_tank: chosen.length ? fuelTankSummary(chosen, pool, vinElec, electrificationDiffers) : {shown: false, reason: 'no_close_match'},
      ...(hiddenSpecs ? {other_powertrain_not_shown: hiddenSpecs} : {}),
      note: chosen.length ? SPECS_MATCH : hiddenSpecs ? NOTE_OTHER_POWERTRAIN.replace('Use the tire placard on the driver\'s door pillar.', 'Capacities are on the door-pillar label and in the owner\'s manual.') : SPECS_NONE,
      source: {provider: 'NHTSA vehicle crash-test reports', indexed_at: data.specsSource?.indexed_at ?? null, dataset_generated_at: data.specsSource?.dataset_generated_at ?? null},
    };
  }
  return {tire_placard: tirePlacard, test_vehicle_specs: specs};
}

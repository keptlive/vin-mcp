/**
 * What FuelEconomy.gov lists for a decoded model and model year, used to cross-check the VIN decode:
 * a decoded drive type, engine size, cylinder count, fuel/electrification or transmission that EPA lists for no
 * configuration of that model and year is doubtful (lib/decode-checks.mjs). No test vehicle is needed.
 *
 * The configurations are the fuel-economy matcher's name stage (lib/fueleconomy-match.mjs matchRows) run on the
 * decode's year, make, model, series, body and plant only: no engine, drive or transmission, so nothing the check
 * is about narrows the list. A model EPA does not list (heavy-duty trucks, vans, models EPA names differently)
 * gives no configurations, and then nothing is checked: missing is unknown.
 */
import {matchRows, nameRelation, rowDrive, rowPowertrain, rowTransmission} from './fueleconomy-match.mjs';
import {fuelIndexRows, FUELECONOMY_FILE} from './fueleconomy-index.mjs';

const num = v => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** The decode with only what names the model (year, make, model, trim and series for EPA's trim-named lines, body, plant, GVWR). */
export function bareDecode(decoded) {
  const v = decoded?.vehicle || {}, raw = decoded?.raw || {};
  return {
    vehicle: {year: v.year, make: v.make, model: v.model, body_class: v.body_class ?? null, trim: v.trim ?? null},
    engine: {}, transmission: {}, dimensions: {gvwr: decoded?.dimensions?.gvwr ?? null},
    raw: {Series: raw.Series ?? null, Series2: raw.Series2 ?? null, Trim2: raw.Trim2 ?? null, PlantCity: raw.PlantCity ?? null, GVWR: raw.GVWR ?? null},
  };
}

/** One EPA configuration in the compact form the checks compare against. */
export function configOf(row) {
  const p = rowPowertrain(row), t = rowTransmission(row), size = num(row.displ), cyl = num(row.cylinders);
  return {id: String(row.id), model: row.model, drive: rowDrive(row), size: p === 'ev' || !size ? null : Math.round(size * 10) / 10,
    cylinders: p === 'ev' || !cyl ? null : cyl, powertrain: p, transmission: t.kind, speeds: t.speeds};
}

function summarize(configs) {
  const set = k => [...new Set(configs.map(c => c[k]).filter(v => v !== null && v !== undefined))];
  return {count: configs.length, drives: set('drive'), sizes: set('size').sort((a, b) => a - b), cylinders: set('cylinders').sort((a, b) => a - b),
    powertrains: set('powertrain'), transmissions: [...new Map(configs.filter(c => c.transmission).map(c => [`${c.transmission}|${c.speeds}`, {kind: c.transmission, speeds: c.speeds}])).values()],
    unknown: {drive: configs.some(c => !c.drive), size: configs.some(c => c.powertrain !== 'ev' && !c.size), cylinders: configs.some(c => c.powertrain !== 'ev' && !c.cylinders)}};
}

/**
 * EPA configurations for a decoded vehicle from rows of its model year and make (pure).
 * strict: the fuel-economy matcher's own name stage. broad: also every listing whose name is the model followed by
 * any words ("Regal eAssist", "Prologue AWD Elite", "F150 Lightning"), so a version EPA names on its own still counts
 * as listed. A value is called unlisted only when the broad set lacks it.
 */
export function epaConfigurations(decoded, rows, {make = decoded?.vehicle?.make || ''} = {}) {
  if (!rows?.length) return {available: false, reason: 'no_epa_rows'};
  const m = matchRows(bareDecode(decoded), rows, {make});
  const strictRows = m.status === 'none' ? [] : m.status === 'one' ? [m.row] : m.rows;
  const strictIds = new Set(strictRows.map(r => String(r.id)));
  const model = decoded?.vehicle?.model;
  const prefixRows = rows.filter(r => !strictIds.has(String(r.id)) && nameRelation(r.model, model, {make, prefix: true}));
  // A broad set only extends a model EPA lists by the matcher's own rules; a prefix-only hit is a weaker name match.
  if (!strictRows.length) return {available: false, reason: m.reason, basis: m.basis};
  const configs = [...strictRows.map(r => ({...configOf(r), strict: true})), ...prefixRows.map(r => ({...configOf(r), strict: false}))];
  return {available: true, basis: m.basis, models: [...new Set(configs.map(c => c.model))].slice(0, 12), configs,
    strict: summarize(configs.filter(c => c.strict)), broad: summarize(configs)};
}

/** Same, reading the local FuelEconomy.gov index (with the sub-brand fallback getFuelEconomy uses: "Scion xD"). */
export function epaOffers(decoded, {file = FUELECONOMY_FILE} = {}) {
  const v = decoded?.vehicle || {};
  if (!v.year || !v.make || !v.model) return {available: false, reason: 'missing_vehicle'};
  const idx = fuelIndexRows(v.year, v.make, file);
  if (!idx.available) return {available: false, reason: idx.reason};
  let out = epaConfigurations(decoded, idx.rows, {make: v.make});
  const [first, ...rest] = String(v.model).split(/\s+/);
  if (!out.available && rest.length) {
    const sub = fuelIndexRows(v.year, first, file);
    if (sub.available && sub.rows.length) {
      const d2 = {...decoded, vehicle: {...v, make: first, model: rest.join(' ')}};
      const o2 = epaConfigurations(d2, sub.rows, {make: first});
      if (o2.available) out = o2;
    }
  }
  return out;
}

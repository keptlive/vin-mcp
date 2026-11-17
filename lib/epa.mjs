/**
 * EPA fuel economy (FuelEconomy.gov) for a decoded VIN.
 *
 * Source, in order:
 *  1. the local index of FuelEconomy.gov's vehicles.csv (data/fueleconomy.db, scripts/import-fueleconomy.py);
 *  2. the FuelEconomy.gov web service (https://www.fueleconomy.gov/feg/ws/) when the index is missing
 *     or has nothing for that model year and make.
 * Matching is in lib/fueleconomy-match.mjs: exact when every attribute the VIN gives agrees; otherwise
 * the closest configuration with what differs stated; several configurations are never narrowed to one
 * silently (match 'multiple_configurations', with the mpg range).
 *
 * Response: the original fields (available, reason, vehicle_id, efids, matched_variant, city_mpg ...)
 * plus match, match_basis, summary, epa_model, configurations, mpg_range and data_source.
 * Several configurations keep available:false and reason 'ambiguous_variant' (no single figure).
 */
import {matchRows, nameRelation, configuration, severalSummary, rowPowertrain, compact} from './fueleconomy-match.mjs';
import {fuelIndexRows, FUELECONOMY_FILE} from './fueleconomy-index.mjs';

const BASE = 'https://fueleconomy.gov/ws/rest/vehicle';
const FETCH_TIMEOUT = 10_000;
const MAX_LIVE_MODELS = 4;
const MAX_LIVE_DETAILS = 12;
const MAX_LISTED = 12;

const timeoutSignal = (ms = FETCH_TIMEOUT) => AbortSignal.timeout(ms);
function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}
function clean(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') { const t = value.trim(); return t === '' ? null : t; }
  return value;
}

/** The empty/unavailable response object. */
function unavailable(reason = 'not_found', extra = {}) {
  return {
    available: false, reason,
    city_mpg: null, highway_mpg: null, combined_mpg: null, annual_fuel_cost: null, co2_grams_per_mile: null,
    fuel_type: null, fuel_type2: null, is_ev: false, ev_range: null, total_range: null, ev_charge_time_240v: null, phev_combined: null,
    cylinders: null, displacement: null, drive: null, transmission: null, vehicle_class: null,
    ...extra,
  };
}

const unitOf = row => (rowPowertrain(row) === 'ev' ? 'MPGe' : 'mpg');
const variantText = row => [row.trany, num(row.cylinders) ? `${num(row.cylinders)} cyl` : null, num(row.displ) ? `${Number(row.displ).toFixed(1)} L` : null].filter(Boolean).join(', ');

/** Response for one matched row. */
function oneResult(row, m, ctx) {
  const fuelType1 = clean(row.fuelType) || clean(row.fuelType1), fuelType2 = clean(row.fuelType2);
  const isEv = rowPowertrain(row) === 'ev';
  const comb = num(row.comb08) || num(row.combA08), city = num(row.city08) || num(row.cityA08), hwy = num(row.highway08) || num(row.highwayA08);
  const unit = unitOf(row);
  const figures = comb ? `${comb} ${unit} combined${city && hwy ? ` (${city} city, ${hwy} highway)` : ''}` : 'EPA figures';
  const what = `EPA's ${row.year} ${row.make} ${row.model}, ${variantText(row)}`;
  const summary = m.match === 'exact' ? `${figures}: ${what}.`
    : `${figures}: closest EPA configuration, ${what}. Not an exact match: ${m.differs.join('; ')}.`;
  return {
    available: true,
    vehicle_id: String(row.id),
    efids: [...new Set((m.efids || []).map(e => String(e).toUpperCase()))],
    matched_variant: `${row.model} · ${variantText(row)}`,
    source_url: `https://www.fueleconomy.gov/feg/Find.do?action=sbs&id=${row.id}`,
    city_mpg: city, highway_mpg: hwy, combined_mpg: comb,
    annual_fuel_cost: num(row.fuelCost08) || num(row.fuelCostA08),
    co2_grams_per_mile: num(row.co2TailpipeGpm) ?? num(row.co2TailpipeAGpm),
    fuel_type: fuelType1, fuel_type2: fuelType2, is_ev: isEv,
    // A plug-in hybrid's `range` is gasoline plus electric: ev_range is its all-electric range (rangeA), total_range the other.
    ev_range: rowPowertrain(row) === 'phev' ? num(row.rangeA) || null : num(row.range) || num(row.rangeCity),
    total_range: rowPowertrain(row) === 'phev' ? num(row.range) || null : null,
    ev_charge_time_240v: num(row.charge240), phev_combined: num(row.combE),
    cylinders: num(row.cylinders), displacement: num(row.displ), drive: clean(row.drive), transmission: clean(row.trany), vehicle_class: clean(row.VClass),
    match: m.match, match_basis: [...m.basis, ...m.differs.map(d => `differs: ${d}`)], summary,
    epa_model: clean(row.model), atv_type: clean(row.atvType), engine_note: clean(row.eng_dscr), unit,
    data_source: ctx.source,
  };
}

/**
 * Response for several remaining configurations. Different ratings: no single figure, the range and every
 * configuration (available false, reason 'ambiguous_variant', match 'multiple_configurations'). The same combined
 * rating for all of them: that figure, exact for practical purposes (available true, match 'same_rating').
 */
function severalResult(m, ctx) {
  const rows = m.rows;
  const {summary, mpg_range, same_rating} = severalSummary(rows, {differs_in: m.differs_in, match: m.match});
  const efidSets = rows.map(r => new Set((m.efidsOf(r) || []).map(e => String(e).toUpperCase())));
  // Test groups every remaining configuration shares: the engine family is then known whichever it is.
  const shared = efidSets.length && efidSets.every(s => s.size) ? [...efidSets[0]].filter(e => efidSets.every(s => s.has(e))) : [];
  const same = f => { const vals = [...new Set(rows.map(f))]; return vals.length === 1 ? vals[0] : null; };
  const configurations = rows.slice(0, MAX_LISTED).map((r, i) => ({...configuration(r, m.efidsOf(r)), label: m.labels?.[i] ?? null}));
  const common = {
    match_basis: [...m.basis, ...m.differs.map(d => `differs: ${d}`)],
    summary,
    mpg_range,
    configuration_count: rows.length,
    configurations,
    separated_by: m.differs_in || [],
    efids: shared,
    is_ev: rows.every(r => rowPowertrain(r) === 'ev'),
    fuel_type: same(r => clean(r.fuelType) || clean(r.fuelType1)),
    atv_type: same(r => clean(r.atvType)),
    epa_model: same(r => clean(r.model)),
    data_source: ctx.source,
  };
  if (!same_rating) return unavailable('ambiguous_variant', {match: 'multiple_configurations', ...common});
  const unit = mpg_range.unit, comb = mpg_range.combined.min;
  const one = (range) => (range && range.min === range.max ? range.min : null);
  const {reason, ...empty} = unavailable('ambiguous_variant');
  return {
    ...empty, available: true,
    match: 'same_rating', closest: m.match === 'closest',
    vehicle_id: null,
    matched_variant: `${rows.length} EPA configurations (${[...new Set(rows.map(r => r.model))].join('; ')}), all ${comb} ${unit} combined`,
    source_url: configurations[0]?.source_url ?? null,
    city_mpg: one(mpg_range.city), highway_mpg: one(mpg_range.highway), combined_mpg: comb, unit,
    annual_fuel_cost: same(r => num(r.fuelCost08) || num(r.fuelCostA08)),
    co2_grams_per_mile: same(r => num(r.co2TailpipeGpm) ?? num(r.co2TailpipeAGpm)),
    ev_range: same(r => (rowPowertrain(r) === 'phev' ? num(r.rangeA) || null : num(r.range) || num(r.rangeCity))),
    cylinders: same(r => num(r.cylinders)), displacement: same(r => num(r.displ)), drive: same(r => clean(r.drive)), transmission: same(r => clean(r.trany)),
    vehicle_class: same(r => clean(r.VClass)),
    ...common,
  };
}

function fromMatch(m, ctx) {
  if (m.status === 'one') return oneResult(m.row, m, ctx);
  if (m.status === 'several') return severalResult(m, ctx);
  return unavailable(m.reason, {match: null, match_basis: m.basis, data_source: ctx.source});
}

// ---- live FuelEconomy.gov web service (fallback) ----

async function getJson(url) {
  const res = await fetch(url, {headers: {Accept: 'application/json'}, signal: timeoutSignal()});
  if (!res.ok) { const err = new Error(`HTTP ${res.status}`); err.http = res.status; throw err; }
  return res.json();
}
const menuItems = data => { const items = data?.menuItem; return !items ? [] : Array.isArray(items) ? items : [items]; };

/** Option text "Auto 5-spd, 6 cyl, 3.0 L": engine and transmission when given. */
function optionAttrs(text) {
  const t = String(text || '');
  const cyl = t.match(/(\d+)\s*cyl/i), liters = t.match(/([\d.]+)\s*L\b/i);
  return {cyl: cyl ? Number(cyl[1]) : null, displ: liters ? Number(liters[1]) : null, manual: /^man/i.test(t), auto: /^auto/i.test(t)};
}

async function liveMatch(year, make, model, decoded) {
  const e = decoded.engine || {}, tr = decoded.transmission || {};
  const displ = num(e.displacement_l) > 0 ? num(e.displacement_l) : null, cyl = num(e.cylinders) > 0 ? num(e.cylinders) : null;
  // 1. the VIN's model name as EPA's menu name; 2. otherwise EPA's model names for the year and make that fit it.
  let options = menuItems(await getJson(`${BASE}/menu/options?${new URLSearchParams({year: String(year), make: String(make), model: String(model)})}`))
    .map(o => ({...o, model: String(model)}));
  if (!options.length) {
    const names = menuItems(await getJson(`${BASE}/menu/model?${new URLSearchParams({year: String(year), make: String(make)})}`)).map(i => String(i.value ?? i.text ?? ''));
    const trimWords = new Set(String(decoded.vehicle?.trim || '').split(/[\s,/]+/).map(compact).filter(Boolean));
    const fits = names.filter(n => nameRelation(n, model, {make, trimWords})).slice(0, MAX_LIVE_MODELS);
    for (const name of fits) {
      options.push(...menuItems(await getJson(`${BASE}/menu/options?${new URLSearchParams({year: String(year), make: String(make), model: name})}`)).map(o => ({...o, model: name})));
    }
  }
  if (!options.length) return unavailable('not_found', {match: null, match_basis: [`no EPA model name for this model year matches "${model}"`], data_source: 'fueleconomy.gov web service'});
  // Engine size (or cylinders when no size is given) from the option text; transmission kind only narrows.
  let fit = options.filter(o => { const a = optionAttrs(o.text); return !displ || a.displ === null || Math.abs(a.displ - displ) <= 0.11; });
  if (!displ && cyl) fit = fit.filter(o => { const a = optionAttrs(o.text); return a.cyl === null || a.cyl === cyl; });
  if (!fit.length) return unavailable('no_matching_variant', {match: null, match_basis: ['no EPA option has the engine the VIN gives'], data_source: 'fueleconomy.gov web service'});
  const kind = /manual|standard/i.test(tr.type || '') ? 'man' : /auto|cvt|continuously/i.test(tr.type || '') ? 'auto' : null;
  if (kind) { const k = fit.filter(o => (kind === 'man' ? optionAttrs(o.text).manual : !optionAttrs(o.text).manual)); if (k.length) fit = k; }
  if (fit.length > MAX_LIVE_DETAILS) {
    return unavailable('ambiguous_variant', {match: 'multiple_configurations', incomplete: true, configuration_count: fit.length,
      summary: `${fit.length} EPA configurations of this model; the VIN does not say which`, match_basis: ['too many EPA configurations to compare one by one'], data_source: 'fueleconomy.gov web service'});
  }
  const rows = [];
  let invalid = 0;
  for (const o of fit) {
    if (!o.value) { invalid++; continue; }
    const v = await getJson(`${BASE}/${o.value}`);
    const a = optionAttrs(o.text);
    const ok = v && v.id && String(v.id) === String(o.value) && Number(v.year) === Number(year) && compact(v.make) === compact(make)
      && compact(v.model) === compact(o.model)
      && (a.cyl === null || num(v.cylinders) === null || num(v.cylinders) === a.cyl)
      && (a.displ === null || num(v.displ) === null || Math.abs(num(v.displ) - a.displ) <= 0.11);
    if (!ok) { invalid++; continue; }
    const emissions = v.emissionsList?.emissionsInfo;
    v._efids = [...new Set((Array.isArray(emissions) ? emissions : emissions ? [emissions] : []).map(x => clean(x?.efid)).filter(Boolean))];
    rows.push(v);
  }
  // A configuration whose record failed could be the right one: nothing is concluded from the rest.
  if (invalid) return fit.length === 1 ? unavailable('invalid_response') : unavailable('ambiguous_variant', {incomplete: true, match: null, data_source: 'fueleconomy.gov web service'});
  const m = matchRows(decoded, rows, {make, efidsOf: r => r._efids || []});
  return fromMatch(m, {source: 'fueleconomy.gov web service'});
}

/**
 * Fuel economy for a decoded vehicle.
 * @param {object} options.file - index path (tests pass a missing path to use the web service)
 */
export async function getFuelEconomy(year, make, model, decoded = {}, {file = FUELECONOMY_FILE} = {}) {
  if (!year || !make || !model) return unavailable('missing_vehicle');
  const full = {...decoded, vehicle: {...(decoded.vehicle || {}), year, make, model}};
  try {
    const idx = fuelIndexRows(year, make, file);
    if (idx.available) {
      let m = idx.rows.length ? matchRows(full, idx.rows, {make, efidsOf: idx.efidsOf}) : null;
      // vPIC files some sub-brands under the parent make ("TOYOTA" / "Scion xD"); EPA under their own make.
      const [first, ...rest] = String(model).split(/\s+/);
      if ((!m || (m.status === 'none' && m.reason === 'not_found')) && rest.length) {
        const sub = fuelIndexRows(year, first, file);
        if (sub.available && sub.rows.length) {
          const m2 = matchRows({...full, vehicle: {...full.vehicle, make: first, model: rest.join(' ')}}, sub.rows, {make: first, efidsOf: sub.efidsOf});
          if (m2.status !== 'none' || !m) { m2.basis.unshift(`EPA lists "${model}" under the make ${sub.rows[0].make}`); m = m2; }
        }
      }
      if (m) {
        const dated = idx.files?.find(f => f.file === 'vehicles.csv.zip')?.last_modified;
        return fromMatch(m, {source: `fueleconomy.gov vehicles.csv${dated ? ` (file dated ${dated})` : ''}, local index`});
      }
    }
    return await liveMatch(year, make, model, full);
  } catch (err) {
    console.error('[epa] getFuelEconomy error:', err.message);
    return unavailable('upstream_error');
  }
}

/**
 * Extra matching rules between a VIN and NHTSA's test vehicles (lib/tire-placards.mjs), chosen by a leave-one-out
 * accuracy test: every test vehicle in the index played a visitor, its own reports held out, and the values the
 * site would show were compared with its own (research folder tire-placards-2026-11-17, scripts/loo_eval.mjs,
 * LOO_PLAN.md). Each rule adds a visible difference ("engine 2.4 L 4-cyl (yours: 3.5 L 6-cyl)"); a tested vehicle with
 * a difference is a different version, so a same-version vehicle is preferred and the difference is stated.
 *
 * Features of the test vehicle come from the full vPIC decode of its own VIN (row.vpic_extra); the visitor's come
 * from vPIC's decode of their VIN. A rule applies only when both sides are known.
 */

/**
 * Rules per block, as measured (docs/data-sources.md, "How a VIN is matched"). Applied in order to the equally
 * close candidates (narrowCandidates); 'drop:different_wheelbase' removes model years Transport Canada lists with a
 * different wheelbase (another generation) before anything else. Rules tried and dropped: engine, wheel size, GVWR
 * class, cab, doors and plant as tier-changing differences (a same-year vehicle pushed below a nearest-year one: as
 * many losses as gains); narrowing by doors and plant (no gain); for the tank, narrowing by cab or engine (turned
 * more value sets into wrong single values than into right ones).
 */
export const MATCH_RULES = Object.freeze({
  tires: Object.freeze(['drop:different_wheelbase', 'fewest', 'narrow:wheel_size', 'narrow:engine', 'narrow:cab']),
  specs: Object.freeze(['drop:different_wheelbase', 'narrow:cab', 'narrow:engine', 'narrow:gvwr_class']),
  tank: Object.freeze(['drop:different_wheelbase', 'fewest', 'narrow:gvwr_class']),
  brake: Object.freeze(['drop:different_wheelbase']),
});

const squash = s => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = v => { const n = Number.parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : null; };

/** The visitor's matching features from lib/nhtsa.mjs decodeVin (engine block and raw vPIC fields). */
export function matchFeatures(decoded) {
  const e = decoded?.engine || {}, raw = decoded?.raw || {};
  const plant = [raw.PlantCity, raw.PlantState, raw.PlantCountry].filter(x => x && String(x).trim()).join(', ');
  return {displacement_l: num(e.displacement_l ?? raw.DisplacementL), cylinders: num(e.cylinders ?? raw.EngineCylinders),
    gvwr_class: raw.GVWR || null, wheel_size_front: num(raw.WheelSizeFront), cab: raw.BodyCabType || null,
    doors: num(raw.Doors), plant: plant || null};
}

/** GVWR class text from vPIC ("Class 1C: 4,001 - 5,000 lb (1,814 - 2,268 kg)") as [low, high] lb, or null. */
export function gvwrClassRange(text) {
  const s = String(text ?? '').replace(/,/g, '');
  let m = /(\d+)\s*-\s*(\d+)\s*lb/i.exec(s);
  if (m) return [Number(m[1]), Number(m[2])];
  m = /(\d+)\s*lb\s+or\s+less/i.exec(s);
  if (m) return [0, Number(m[1])];
  m = /(\d+)\s*lb\s+or\s+more|over\s+(\d+)\s*lb/i.exec(s);
  if (m) return [Number(m[1] || m[2]), Infinity];
  return null;
}

const engineText = (l, c) => [l != null ? `${Math.round(l * 10) / 10} L` : null, c != null ? `${c}-cyl` : null].filter(Boolean).join(' ');
const rimOf = size => { const m = /\d{3}\s?\/\s?\d{2}\s?(?:Z?R|RF|B|D)\s?(\d{2}(?:\.\d)?)/i.exec(String(size ?? '')); return m ? Number(m[1]) : null; };
const KG_PER_LB = 0.45359237;

/** Differences between a tested vehicle (db row with vpic_extra) and the VIN's features, for the rules given. */
export function extraDifferences(row, vin, rules = []) {
  const out = [], x = row.vpic_extra || {};
  if (rules.includes('engine')) {
    const dl = x.displacement_l != null && vin.displacement_l != null && Math.abs(x.displacement_l - vin.displacement_l) >= 0.15;
    const dc = x.cylinders != null && vin.cylinders != null && x.cylinders !== vin.cylinders;
    if (dl || dc) out.push({field: 'engine', tested: engineText(x.displacement_l, x.cylinders), yours: engineText(vin.displacement_l, vin.cylinders)});
  }
  if (rules.includes('wheel_size') && row.tire_front != null) {
    const rim = rimOf(row.tire_front);
    if (rim != null && vin.wheel_size_front != null && Math.round(rim) !== Math.round(vin.wheel_size_front)) out.push({field: 'wheel_size', tested: `${rim} in`, yours: `${vin.wheel_size_front} in`});
  }
  if (rules.includes('gvwr_class')) {
    const range = gvwrClassRange(vin.gvwr_class);
    const g = row.data?.gvwr, lb = g && Number.isFinite(g.value) ? (g.unit_printed === 'lb' ? g.value : g.value / KG_PER_LB) : null;
    const code = s => (/Class\s+(\w+)/i.exec(String(s ?? '')) || [])[1];
    // the test vehicle's printed GVWR against the VIN's class range (1% slack for kg/lb rounding); else vPIC's classes
    const differs = range && lb != null ? lb < range[0] * 0.99 || lb > range[1] * 1.01
      : code(x.gvwr_class) && code(vin.gvwr_class) ? code(x.gvwr_class) !== code(vin.gvwr_class) : false;
    if (differs) out.push({field: 'gvwr_class', tested: lb != null ? `${Math.round(lb)} lb` : x.gvwr_class, yours: vin.gvwr_class});
  }
  if (rules.includes('cab') && x.cab && vin.cab && squash(x.cab) !== squash(vin.cab)) out.push({field: 'cab', tested: x.cab, yours: vin.cab});
  if (rules.includes('doors') && x.doors != null && vin.doors != null && x.doors !== vin.doors) out.push({field: 'doors', tested: x.doors, yours: vin.doors});
  if (rules.includes('plant') && x.plant && vin.plant && squash(x.plant) !== squash(vin.plant)) out.push({field: 'plant', tested: x.plant, yours: vin.plant});
  return out;
}

/**
 * Among equally close candidates (same tier, same year gap), the rules in order: 'fewest' keeps those with the
 * fewest visible differences; 'narrow:<rule>' keeps those that match the VIN on that rule, but only when some do
 * and some do not (a rule that separates them). When nothing separates them, all stay: the site shows the set.
 */
export function narrowCandidates(chosen, vin, rules = []) {
  for (const rule of rules) {
    if (chosen.length < 2) break;
    if (rule === 'fewest') {
      const few = Math.min(...chosen.map(c => c.match.differences.length));
      chosen = chosen.filter(c => c.match.differences.length === few);
    } else if (rule.startsWith('narrow:')) {
      const same = chosen.filter(c => !extraDifferences(c.row, vin, [rule.slice(7)]).length);
      if (same.length && same.length < chosen.length) chosen = same;
    }
  }
  return chosen;
}

/** A mass {kg, lb} or a seating {total}; equal within 1% (mass) or exactly (seats). */
const sameValue = (field, a, b) => field === 'seating' ? a.total === b.total : Math.abs(a.kg - b.kg) <= Math.max(1, 0.01 * Math.max(a.kg, b.kg));

/**
 * Payload, seating total and GVWR across the equally close tested vehicles (specs vehicles of one tier): every
 * distinct value with the vehicle that printed it, for each field where they differ (two or more values). The
 * site then shows all of them, never one picked.
 */
export function capacitySets(vehicles) {
  const out = {};
  for (const [field, key] of [['payload', 'payload_vehicle_capacity_weight'], ['seating', 'seating'], ['gvwr', 'gvwr']]) {
    const vals = [];
    for (const v of vehicles) {
      const x = v[key];
      if (!x || (field === 'seating' ? !x.total : !(x.kg > 0))) continue;
      if (!vals.some(o => sameValue(field, o.value, x))) vals.push({value: x, tested_as: v.tested_as, model_year: v.model_year, report_url: v.report_url, report_label: v.report_label});
    }
    if (vals.length > 1) out[field] = vals;
  }
  return out;
}

/**
 * How often a match of each kind gave the vehicle's own value, measured by the leave-one-out test above on the
 * complete index (2026-11-17, 2,382 NHTSA test vehicles; research run f_final2). Percent of the vehicles shown a value
 * that got the right one (tire size ignoring load index; pressure within 1 psi; tank within 1 L; weights within 1%);
 * pressures are the lower of front and rear. Not measured: GAWR, curb weight. Kinds: exact, different_variant
 * (same year, other version), nearest_same_version, nearest_other_version (other model year).
 */
export const MATCH_ACCURACY = Object.freeze({
  basis: 'mcp.vin accuracy test 2026-11-17: each of 2,382 NHTSA test vehicles held out in turn and looked up like a visitor\'s VIN',
  tires: {exact: {tire_size: 92, cold_pressure: 96}, different_variant: {tire_size: 74, cold_pressure: 84},
    nearest_same_version: {tire_size: 75, cold_pressure: 84}, nearest_other_version: {tire_size: 54, cold_pressure: 70}},
  fuel_tank: {exact: 92, different_variant: 86, nearest_same_version: 87, nearest_other_version: 91},
  capacities: {exact: {payload: 87, seating: 98, gvwr: 93}, different_variant: {payload: 68, seating: 92},
    nearest_same_version: {payload: 70, seating: 92, gvwr: 71}, nearest_other_version: {payload: 67, seating: 84}},
});

/** The accuracy kind of a match object (see MATCH_ACCURACY). */
export function accuracyKind(m) {
  if (!m) return null;
  if (m.kind !== 'nearest_model_year') return m.kind;
  return (m.differences || []).some(d => d.field !== 'model_year') ? 'nearest_other_version' : 'nearest_same_version';
}

/** {kind, ...right_pct, basis} for one block ('tires', 'fuel_tank', 'capacities') and its first vehicle's match, or null. */
export function accuracyFor(block, m) {
  const kind = accuracyKind(m), a = kind && MATCH_ACCURACY[block]?.[kind];
  if (a == null) return null;
  const pct = typeof a === 'number' ? {right_pct: a} : Object.fromEntries(Object.entries(a).map(([k, v]) => [`${k}_right_pct`, v]));
  return {kind, ...pct, basis: MATCH_ACCURACY.basis};
}

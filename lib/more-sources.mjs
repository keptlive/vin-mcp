/**
 * Report blocks from extra official datasets indexed locally (each lookup is a read-only SQLite file):
 *  - epa_test_vehicles: EPA Test Car List (lib/epa-test-cars.mjs)
 *  - production_theft: NHTSA final theft data with line production, MY1998-2012 (lib/theft-rates.mjs)
 * A missing dataset gives {available:false, reason:'dataset_not_indexed'}; nothing is estimated.
 */
import {lookupEpaTestCars} from './epa-test-cars.mjs';
import {lookupTheftRates} from './theft-rates.mjs';

/** Extra blocks for a decoded vehicle and its matched EPA fuel record. Never throws. */
export function extraReportBlocks(decoded, fuel) {
  const safe = (fn, fallback) => { try { return fn(); } catch (err) { console.error('[more-sources]', err.message); return fallback; } };
  const report = {...decoded, fuel_economy: fuel};
  return {
    epa_test_vehicles: safe(() => lookupEpaTestCars(report), {available: false, reason: 'index_unreadable'}),
    production_theft: safe(() => lookupTheftRates(report), {available: false, reason: 'index_unreadable'}),
  };
}

/** Shorter versions of the extra blocks for MCP decode_vin: the facts, the match disclosure and one source link. */
export function compactExtraBlocks(report) {
  const out = {};
  const t = report?.epa_test_vehicles;
  if (t) out.epa_test_vehicles = !t.available ? t : {
    available: true, match: t.match, vin_specific: false, model_year: t.model_year, tested_model_years: t.tested_model_years, match_basis: t.match_basis,
    rated_hp: t.rated_hp, transmissions: t.transmissions, axle_ratios: t.axle_ratios, test_weight_lb: t.test_weight_lb,
    test_groups: (t.test_groups || []).slice(0, 3), source_url: t.source?.url ?? null, note: t.note,
  };
  const p = report?.production_theft;
  if (p) out.production_theft = !p.available ? {available: false, reason: p.reason} : {
    available: true, vin_specific: false, model_year: p.model_year, calendar_year: p.calendar_year, match: p.match, match_basis: p.match_basis,
    lines: p.lines, source_url: p.source?.url ?? null, note: p.note,
  };
  return out;
}

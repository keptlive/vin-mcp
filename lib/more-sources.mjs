/**
 * Report blocks from extra official datasets indexed locally (each lookup is a read-only SQLite file):
 *  - epa_test_vehicles: EPA Test Car List (lib/epa-test-cars.mjs)
 * A missing dataset gives {available:false, reason:'dataset_not_indexed'}; nothing is estimated.
 */
import {lookupEpaTestCars} from './epa-test-cars.mjs';

/** Extra blocks for a decoded vehicle and its matched EPA fuel record. Never throws. */
export function extraReportBlocks(decoded, fuel) {
  const safe = (fn, fallback) => { try { return fn(); } catch (err) { console.error('[more-sources]', err.message); return fallback; } };
  const report = {...decoded, fuel_economy: fuel};
  return {
    epa_test_vehicles: safe(() => lookupEpaTestCars(report), {available: false, reason: 'index_unreadable'}),
  };
}

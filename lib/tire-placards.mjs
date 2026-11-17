/**
 * Tire placard values from NHTSA crash-test reports, per tested vehicle.
 * Built by scripts/import-tire-placards.py from data-src/tire-placards.jsonl. Each row is the
 * door-placard tire size and cold pressures printed in the report's data sheet for the vehicle
 * NHTSA tested, keyed by the vPIC make, model and model year of that test vehicle's own VIN.
 *
 * Rules: only an exact make + model + model-year match is returned; another model year's value is
 * never applied; nothing is computed or estimated. The values describe NHTSA's test vehicle, not
 * the decoded VIN: the owner's own door placard governs. Missing means not tested or not indexed.
 */
import Database from 'better-sqlite3';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const TIRE_PLACARDS_FILE = fileURLToPath(new URL('../data/tire-placards.db', import.meta.url));

const SCOPE = 'nhtsa_test_vehicle';
const NOTE_MATCH = 'Tire size and cold pressures from the door placard of the vehicle NHTSA crash-tested (same make, model and model year), as printed in NHTSA\'s test report (reports print kPa; psi = kPa ÷ 6.895, rounded). Not this VIN\'s placard: your own door placard governs; it can differ by trim and tire size.';
const NOTE_NONE = 'NHTSA\'s crash-test reports in this index have no test vehicle with this exact make, model and model year (not tested, or not indexed). Use the tire placard on the driver\'s door pillar.';
const NOTE_UNAVAILABLE = 'The NHTSA test-vehicle placard index is not available, so this was not checked. Use the tire placard on the driver\'s door pillar.';

/** Upper case, trimmed, inner spaces collapsed. Same rule as key() in the import script. */
export function keyName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

const unavailable = reason => ({available: false, reason, scope: SCOPE, vin_specific: false, note: NOTE_UNAVAILABLE});

/**
 * Placard values for NHTSA's test vehicles with exactly this vPIC make, model and model year.
 * Several tested variants (different tire options) are all returned.
 */
export function lookupTirePlacards({make, model, year}, file = TIRE_PLACARDS_FILE) {
  if (!existsSync(file)) return unavailable('dataset_not_indexed');
  const mk = keyName(make), md = keyName(model), y = Number(year);
  if (!mk || !md || !Number.isInteger(y)) return {...unavailable('no_vehicle'), note: 'No make, model and model year to look up.'};
  let db;
  try {
    db = new Database(file, {readonly: true, fileMustExist: true});
    const rows = db.prepare('SELECT * FROM placards WHERE make_key=? AND model_key=? AND year=? ORDER BY confidence=\'high\' DESC, test_no').all(mk, md, y);
    const source = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='source'").get().value);
    const vehicles = rows.map(r => ({
      model_year: r.year, make: r.make, model: r.model, tested_as: r.tested_as,
      tires: {front: r.tire_front, rear: r.tire_rear},
      cold_pressure_psi: {front: r.psi_front, rear: r.psi_rear},
      cold_pressure_kpa: {front: r.kpa_front, rear: r.kpa_rear},
      report_url: r.report_url, test_no: r.test_no, confidence: r.confidence,
      ...(r.vpic_trim ? {vin_decoded_trim: r.vpic_trim} : {}),
      other_reports: JSON.parse(r.other_reports || '[]'),
    }));
    return {
      available: true, ...(vehicles.length ? {} : {reason: 'no_exact_match'}), scope: SCOPE, vin_specific: false, vehicles,
      note: vehicles.length ? NOTE_MATCH : NOTE_NONE,
      source: {provider: 'NHTSA vehicle crash-test reports', indexed_at: source.indexed_at ?? null, dataset_generated_at: source.dataset_generated_at ?? null},
    };
  } catch (err) {
    console.error('[tire-placards] lookup error:', err.message);
    return unavailable('index_unreadable');
  } finally {
    db?.close();
  }
}

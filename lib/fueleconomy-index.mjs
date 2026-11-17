/**
 * Local index of FuelEconomy.gov's vehicle table (vehicles.csv + emissions.csv, public domain).
 * Built by scripts/import-fueleconomy.py into data/fueleconomy.db. Column names are the CSV's,
 * which are also the web service's field names, so lib/fueleconomy-match.mjs reads both alike.
 */
import Database from 'better-sqlite3';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const FUELECONOMY_FILE = fileURLToPath(new URL('../data/fueleconomy.db', import.meta.url));
const compact = v => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * FuelEconomy.gov rows for one model year and make, with their EPA test groups.
 * {available:false, reason:'dataset_not_indexed'} when the index is missing;
 * {available:true, rows:[], ...} when the index has nothing for that year and make.
 */
export function fuelIndexRows(year, make, file = FUELECONOMY_FILE) {
  if (!existsSync(file)) return {available: false, reason: 'dataset_not_indexed'};
  let db;
  try {
    db = new Database(file, {readonly: true, fileMustExist: true});
    const source = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='source'").get().value);
    const rows = db.prepare('SELECT * FROM vehicles WHERE year=? AND make_key=? ORDER BY id').all(Number(year), compact(make));
    const efids = new Map();
    if (rows.length) {
      for (const e of db.prepare('SELECT e.id, e.efid FROM emissions e JOIN vehicles v ON v.id=e.id WHERE v.year=? AND v.make_key=?').all(Number(year), compact(make))) {
        if (!efids.has(e.id)) efids.set(e.id, []);
        efids.get(e.id).push(e.efid);
      }
    }
    const files = (source.sources || []).map(s => ({file: s.file, url: s.url, last_modified: s.last_modified ?? null}));
    return {available: true, rows, efidsOf: row => efids.get(Number(row.id)) || [], model_years: source.model_years, files, indexed_at: source.indexed_at ?? null};
  } catch (err) {
    console.error('[fueleconomy-index] lookup error:', err.message);
    return {available: false, reason: 'index_unreadable'};
  } finally {
    db?.close();
  }
}

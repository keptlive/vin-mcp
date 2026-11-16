/**
 * Local index of the model names NHTSA files recall campaigns under, per make and model year.
 * Built by scripts/import-recall-labels.py from NHTSA's recall flat files. It lists names only;
 * campaign details still come from the live recallsByVehicle API.
 */
import Database from 'better-sqlite3';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const RECALL_LABELS_FILE = fileURLToPath(new URL('../data/recall-labels.db', import.meta.url));

/** Letters and digits only, upper case ('F-150' -> 'F150'). Same rule as the import script. */
export function compactName(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Labels for the given makes and model year, and which of `names` (compact forms) NHTSA has used as
 * a label for these makes in any model year. Returns {available:false} when the index is missing
 * or unreadable, so callers can say the label list is partial instead of guessing.
 */
export function lookupRecallLabels({makes, year, names = []}, file = RECALL_LABELS_FILE) {
  if (!existsSync(file)) return {available: false, reason: 'dataset_not_indexed'};
  let db;
  try {
    db = new Database(file, {readonly: true, fileMustExist: true});
    const ms = [...new Set(makes.map(m => String(m).trim().toUpperCase()).filter(Boolean))];
    if (!ms.length) return {available: false, reason: 'no_make'};
    const marks = ms.map(() => '?').join(',');
    const labels = db.prepare(`SELECT make, model, campaigns FROM labels WHERE year=? AND make IN (${marks}) ORDER BY make, model`).all(Number(year), ...ms);
    const wanted = [...new Set(names.filter(Boolean))];
    const used = new Set(wanted.length ? db.prepare(`SELECT DISTINCT compact FROM labels WHERE make IN (${marks}) AND compact IN (${wanted.map(() => '?').join(',')})`).all(...ms, ...wanted).map(r => r.compact) : []);
    const source = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='source'").get().value);
    return {available: true, labels, used_names: used, source: {provider: 'NHTSA recall flat files', latest_report_date: source.latest_report_date ?? null, indexed_at: source.indexed_at ?? null}};
  } catch (err) {
    console.error('[recall-labels] lookup error:', err.message);
    return {available: false, reason: 'index_unreadable'};
  } finally {
    db?.close();
  }
}

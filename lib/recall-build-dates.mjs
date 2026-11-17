/**
 * Manufacturer build-date ranges for recall campaigns, from NHTSA's recall flat files
 * (fields BGMAN/ENDMAN and POTAFF), kept per campaign + make + model + model year in the
 * `campaign_builds` table of data/recall-labels.db (scripts/import-recall-labels.py).
 *
 * The range is what the manufacturer filed for the campaign rows of this make, model and year.
 * It says when affected vehicles were built; it does not say whether this VIN is affected,
 * and the VIN does not carry a build month. Missing dates stay null (unknown).
 */
import Database from 'better-sqlite3';
import {existsSync} from 'node:fs';
import {RECALL_LABELS_FILE, compactName} from './recall-labels.mjs';

export const BUILD_DATES_NOTE = 'Manufacturer-filed build-date range for the campaign rows of this make, model and year (NHTSA recall flat file, BGMAN/ENDMAN). It does not say whether this VIN is affected; the vehicle\'s build month is on the door-jamb label.';

/**
 * Build ranges for [{campaign, make, model, year}] keys. Returns {available:true, ranges: Map(key -> row)}
 * where key = buildKey(campaign, make, model, year), or {available:false, reason}.
 * Matching ignores case, spaces and punctuation in make and model ('F-150' = 'F150').
 */
export function lookupBuildDates(keys, file = RECALL_LABELS_FILE) {
  if (!existsSync(file)) return {available: false, reason: 'dataset_not_indexed'};
  let db;
  try {
    db = new Database(file, {readonly: true, fileMustExist: true});
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='campaign_builds'").get()) return {available: false, reason: 'dataset_not_indexed'};
    const query = db.prepare('SELECT built_from, built_to, distinct_ranges FROM campaign_builds WHERE campaign=? AND make_compact=? AND model_compact=? AND year=?');
    const units = db.prepare('SELECT units_affected FROM campaign_units WHERE campaign=?');
    const ranges = new Map();
    for (const k of keys) {
      if (!k?.campaign || !k.make || !k.model || !Number(k.year)) continue;
      const key = buildKey(k.campaign, k.make, k.model, k.year);
      if (ranges.has(key)) continue;
      const campaign = String(k.campaign).trim().toUpperCase();
      const row = query.get(campaign, compactName(k.make), compactName(k.model), Number(k.year));
      ranges.set(key, {...(row || {built_from: null, built_to: null, distinct_ranges: 0}), units_affected: units.get(campaign)?.units_affected ?? null});
    }
    const source = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='source'").get().value);
    return {available: true, ranges, latest_report_date: source.latest_report_date ?? null};
  } catch (err) {
    console.error('[recall-build-dates] lookup error:', err.message);
    return {available: false, reason: 'index_unreadable'};
  } finally {
    db?.close();
  }
}

export function buildKey(campaign, make, model, year) {
  return [String(campaign).trim().toUpperCase(), compactName(make), compactName(model), Number(year)].join('|');
}

/** Fields added to one campaign: manufactured_from/to (ISO dates or null), plus units affected for the whole campaign. */
function fields(row) {
  if (!row) return {manufactured_from: null, manufactured_to: null};
  const out = {manufactured_from: row.built_from ?? null, manufactured_to: row.built_to ?? null};
  if (row.distinct_ranges > 1) out.manufactured_range_note = `The manufacturer filed ${row.distinct_ranges} different ranges for this campaign, make, model and year; this is the earliest start to the latest end.`;
  if (row.units_affected) out.campaign_units_affected = row.units_affected; // whole campaign, all makes, models and years
  return out;
}

/**
 * Attach build-date ranges to a recall block from modelYearRecalls(): exact campaigns by the decoded
 * model name, related-model campaigns by the NHTSA model name they were filed under. Adds
 * `build_dates` (source and coverage) to the block. Returns the block unchanged when it is unavailable.
 */
export function withBuildDates(recalls, make, model, year, {lookup = lookupBuildDates} = {}) {
  if (!recalls || recalls.available === false || !make || !model || !year) return recalls;
  const related = recalls.related_models;
  const keys = [
    ...(recalls.recalls || []).map(r => ({campaign: r.campaign_number, make, model, year})),
    ...(related?.models || []).flatMap(m => (m.recalls || []).map(r => ({campaign: r.campaign_number, make, model: m.nhtsa_model, year}))),
    ...(related?.flat_file_only?.campaigns || []).map(c => ({campaign: c.campaign_number, make, model: c.nhtsa_model, year})),
  ];
  if (!keys.length) return recalls;
  const found = lookup(keys);
  if (!found.available) return {...recalls, build_dates: {available: false, reason: found.reason}};
  const get = (campaign, name) => campaign ? fields(found.ranges.get(buildKey(campaign, make, name, year))) : {};
  const out = {...recalls, recalls: (recalls.recalls || []).map(r => ({...r, ...get(r.campaign_number, model)}))};
  if (related?.models || related?.flat_file_only) {
    out.related_models = {
      ...related,
      models: (related.models || []).map(m => ({...m, recalls: (m.recalls || []).map(r => ({...r, ...get(r.campaign_number, m.nhtsa_model)}))})),
      ...(related.flat_file_only && {flat_file_only: {...related.flat_file_only, campaigns: related.flat_file_only.campaigns.map(c => ({...c, ...get(c.campaign_number, c.nhtsa_model)}))}}),
    };
  }
  const all = [...out.recalls, ...(out.related_models?.models || []).flatMap(m => m.recalls), ...(out.related_models?.flat_file_only?.campaigns || [])];
  out.build_dates = {available: true, source: 'NHTSA recall flat file (BGMAN/ENDMAN)', snapshot_latest_report_date: found.latest_report_date,
    campaigns: all.length, campaigns_with_dates: all.filter(c => c.manufactured_from || c.manufactured_to).length, vin_specific: false, note: BUILD_DATES_NOTE};
  return out;
}

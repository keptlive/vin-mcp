/**
 * mcp.vin's local copies of NHTSA's recall campaigns, owner complaints and 5-Star Safety Ratings.
 *
 * Built from NHTSA's own public data (scripts/nhtsa-refresh.sh):
 *   data/nhtsa-recalls.db     recall flat files FLAT_RCL_PRE_2010.zip + FLAT_RCL_POST_2010.zip (daily), scripts/import-nhtsa-recalls.py
 *   data/nhtsa-complaints.db  complaint flat file FLAT_CMPL.zip (daily), scripts/import-nhtsa-complaints.py
 *   data/nhtsa-ratings.db     a gentle crawl of the 5-Star Safety Ratings API (no bulk file carries the API's vehicle
 *                             ids and variants), scripts/harvest-nhtsa-ratings.py + scripts/import-nhtsa-ratings.py
 *
 * Each lookup returns rows shaped like the matching api.nhtsa.gov answer (recallsByVehicle, complaintsByVehicle,
 * SafetyRatings list + VehicleId), so lib/nhtsa.mjs maps local and live answers with the same code. The rules that
 * turn flat-file rows into API rows were measured against live answers (docs/nhtsa-local-data.md); where the flat
 * files cannot say what the API says (the over-the-air flag, which of several recalled components the API names,
 * the API's own report date and line breaks), a gentle per-campaign crawl of the API fills it in
 * (scripts/harvest-nhtsa-recall-campaigns.py); a campaign the crawl has not reached yet says less rather than guess.
 *
 * NHTSA_LOCAL_DB=off turns all three off (tests); NHTSA_RECALLS_DB, NHTSA_COMPLAINTS_DB, NHTSA_RATINGS_DB replace a
 * file path.
 */
import Database from 'better-sqlite3';
import {existsSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const NHTSA_RECALLS_FILE = fileURLToPath(new URL('../data/nhtsa-recalls.db', import.meta.url));
export const NHTSA_COMPLAINTS_FILE = fileURLToPath(new URL('../data/nhtsa-complaints.db', import.meta.url));
export const NHTSA_RATINGS_FILE = fileURLToPath(new URL('../data/nhtsa-ratings.db', import.meta.url));

const DATASETS = {
  recalls: {file: NHTSA_RECALLS_FILE, env: 'NHTSA_RECALLS_DB', name: 'nhtsa_recalls'},
  complaints: {file: NHTSA_COMPLAINTS_FILE, env: 'NHTSA_COMPLAINTS_DB', name: 'nhtsa_complaints'},
  ratings: {file: NHTSA_RATINGS_FILE, env: 'NHTSA_RATINGS_DB', name: 'nhtsa_ratings'},
};

/**
 * Days after NHTSA's file date (ratings: after the crawl) when a dataset counts as stale and the live API is asked
 * first. NHTSA republishes the recall and complaint files every day and the refresh runs daily, so a week means the
 * refresh has failed for days; ratings are crawled weekly (recent model years) and quarterly (all).
 */
export const STALE_DAYS = {recalls: 7, complaints: 7, ratings: 45};

/** The file a dataset is read from, or null when local data is switched off. `opts.file` (tests) wins. */
export function datasetFile(kind, opts = {}) {
  if (opts && 'file' in opts) return opts.file;
  if (process.env.NHTSA_LOCAL_DB === 'off') return null;
  return process.env[DATASETS[kind].env] || DATASETS[kind].file;
}

const handles = new Map();
const RECHECK_MS = 60_000;
function fileId(file) { try { const st = statSync(file); return `${st.ino}:${st.size}:${st.mtimeMs}`; } catch { return null; } }

function open(kind, file) {
  let h = handles.get(file);
  if (h) {
    // The refresh writes a new file and renames it over the old one: reopen when the file changed.
    if (Date.now() - h.checkedAt < RECHECK_MS) return h;
    h.checkedAt = Date.now();
    if (fileId(file) === h.fileId) return h;
    try { h.db.close(); } catch { /* already closed */ }
    handles.delete(file);
    h = null;
  }
  if (!existsSync(file)) return null;
  const db = new Database(file, {readonly: true, fileMustExist: true});
  db.pragma('mmap_size = 268435456');
  const meta = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='source'").get().value);
  if (meta.dataset !== DATASETS[kind].name || meta.schema !== 1) { db.close(); throw new Error(`${file}: not a ${DATASETS[kind].name} schema 1 file`); }
  h = {db, meta, fileId: fileId(file), checkedAt: Date.now(), q: {}};
  handles.set(file, h);
  return h;
}

/** Close cached handles (tests). */
export function closeNhtsaLocal() { for (const h of handles.values()) { try { h.db.close(); } catch { /* closed */ } } handles.clear(); }

/** Upper case, trimmed, inner whitespace collapsed: the importers' key form (NHTSA's API ignores case). */
export const keyText = v => String(v ?? '').toUpperCase().split(/\s+/).filter(Boolean).join(' ');
const yearKey = v => { const n = Number(v); return Number.isInteger(n) ? n : null; };

/** Dataset facts for the answer's data_source block, or null when the file is missing or unreadable. */
export function datasetInfo(kind, opts = {}) {
  const file = datasetFile(kind, opts);
  if (!file) return null;
  try {
    const h = open(kind, file);
    if (!h) return null;
    const m = h.meta;
    return {file_date: m.source_last_modified ?? m.last_crawl_finished_at ?? null, built_at: m.built_at ?? null,
      ...(m.latest_report_date ? {latest_report_date: m.latest_report_date} : {}),
      ...(m.latest_received_date ? {latest_received_date: m.latest_received_date} : {}),
      ...(m.last_crawl_finished_at ? {last_crawl_finished_at: m.last_crawl_finished_at} : {})};
  } catch { return null; }
}

/**
 * Why the live API answers instead of the local copy, or null when the local copy answers.
 *   local_data_off | dataset_not_installed | dataset_unreadable | <lookup reason> | dataset_stale
 */
export function localDataFallbackReason(kind, local, now = new Date()) {
  if (!local) return 'dataset_not_installed';
  if (!local.available) return local.reason || 'dataset_unreadable';
  const date = Date.parse(local.info?.file_date || '');
  if (!Number.isFinite(date)) return 'dataset_date_unknown';
  if (now.getTime() - date > STALE_DAYS[kind] * 86_400_000) return 'dataset_stale';
  return null;
}

function lookup(kind, opts, fn) {
  const file = datasetFile(kind, opts);
  if (!file) return {available: false, reason: 'local_data_off'};
  let h;
  try {
    h = open(kind, file);
  } catch (err) {
    console.error(`[nhtsa-local] ${kind} open error:`, err.message);
    return {available: false, reason: 'dataset_unreadable'};
  }
  if (!h) return {available: false, reason: 'dataset_not_installed'};
  try {
    const out = fn(h);
    return out.available === false ? out : {available: true, ...out, info: datasetInfo(kind, {file})};
  } catch (err) {
    console.error(`[nhtsa-local] ${kind} lookup error:`, err.message);
    return {available: false, reason: 'dataset_unreadable'};
  }
}

const dayFirst = iso => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : null; // 2024-10-03 -> 03/10/2024
const monthFirst = ymd => ymd ? `${ymd.slice(4, 6)}/${ymd.slice(6, 8)}/${ymd.slice(0, 4)}` : null; // 20241003 -> 10/03/2024

/**
 * Recall campaigns for a make, model and model year as recallsByVehicle rows, from data/nhtsa-recalls.db.
 * Measured against live answers (docs/nhtsa-local-data.md):
 *  - the API matches make and model ignoring case, nothing else (F150 does not find F-150);
 *  - one row per campaign; the API names ONE component per campaign (the same for every vehicle), picked by no rule
 *    visible in the flat files: the crawled campaign answer gives it (api_component / api_components), else the
 *    first recalled component in file order; `components` lists every component the flat files recall for this
 *    vehicle when there are several;
 *  - the API's campaign order follows no rule visible in the flat files either; local rows are newest report first;
 *  - ReportReceivedDate is the crawled API date when there is one (a day after the flat file's on ~6% of campaigns),
 *    else the flat file's report received date (RCDATE), day first;
 *  - parkIt / parkOutSide are the flat file's consumer advisories, present only for vehicle campaigns (equipment
 *    campaigns carry neither in the API); overTheAirUpdate comes only from the crawl and is absent (unknown) without it.
 */
export function localRecallRows(make, model, year, opts = {}) {
  return lookup('recalls', opts, h => {
    h.q.recalls ??= h.db.prepare(`SELECT v.campaign, v.component, v.first_record, a.component AS vehicle_api_component, c.*
      FROM vehicles v JOIN campaigns c ON c.campaign = v.campaign
      LEFT JOIN api_components a ON a.campaign = v.campaign AND a.make = v.make AND a.model = v.model AND a.year = v.year
      WHERE v.make = ? AND v.model = ? AND v.year = ? ORDER BY c.report_received DESC, v.campaign DESC, v.first_record`);
    const y = yearKey(year);
    const rows = y === null ? [] : h.q.recalls.all(keyText(make), keyText(model), y);
    const byCampaign = new Map();
    for (const r of rows) {
      let c = byCampaign.get(r.campaign);
      if (!c) byCampaign.set(r.campaign, c = {...r, components: []});
      c.components.push([r.first_record, r.component]);
    }
    const results = [...byCampaign.values()].map(c => {
      const components = c.components.sort((a, b) => a[0] - b[0]).map(x => x[1]);
      const row = {Manufacturer: c.manufacturer, NHTSACampaignNumber: c.campaign,
        ...(c.type === 'V' ? {parkIt: c.do_not_drive === 1, parkOutSide: c.park_outside === 1} : {}),
        ...(c.ota === null || c.ota === undefined ? {} : {overTheAirUpdate: c.ota === 1}),
        ReportReceivedDate: dayFirst(c.api_report_received || c.report_received),
        Component: c.vehicle_api_component || c.api_component || components[0], Summary: c.summary,
        Consequence: c.consequence, Remedy: c.remedy, Notes: c.notes, ModelYear: String(y), Make: keyText(make), Model: keyText(model)};
      if (components.length > 1) row.components = components;
      return row;
    });
    return {results};
  });
}

/** Model labels NHTSA files recall campaigns under for these makes and year (same answer shape as lookupRecallLabels). */
export function localRecallLabels({makes, year, names = []}, opts = {}) {
  return lookup('recalls', opts, h => {
    const ms = [...new Set(makes.map(keyText).filter(Boolean))];
    if (!ms.length) return {available: false, reason: 'no_make'};
    const marks = ms.map(() => '?').join(',');
    const labels = h.db.prepare(`SELECT make, model, COUNT(DISTINCT campaign) AS campaigns, GROUP_CONCAT(DISTINCT campaign) AS list FROM vehicles
      WHERE year = ? AND make IN (${marks}) GROUP BY make, model ORDER BY make, model`).all(yearKey(year), ...ms)
      .map(({list, ...l}) => ({...l, campaign_numbers: String(list || '').split(',').filter(Boolean).sort()}));
    const wanted = new Set(names.filter(Boolean));
    const used = new Set();
    if (wanted.size) {
      for (const r of h.db.prepare(`SELECT DISTINCT model FROM vehicles WHERE make IN (${marks})`).all(...ms)) {
        const c = r.model.replace(/[^A-Z0-9]/g, '');
        if (wanted.has(c)) used.add(c);
      }
    }
    return {labels, used_names: used, source: {provider: 'NHTSA recall flat files (mcp.vin local copy)', latest_report_date: h.meta.latest_report_date ?? null, indexed_at: h.meta.built_at ?? null}};
  });
}

/**
 * Owner complaints for a make, model and model year as complaintsByVehicle rows, from data/nhtsa-complaints.db.
 * Measured against live answers: newest date received first, complaints received the same day by complaint number;
 * components are the top-level component names (the part before the first ':') of every product the complaint
 * names, joined with ','; the incident date is null when the flat file has none.
 */
export function localComplaintRows(make, model, year, opts = {}) {
  return lookup('complaints', opts, h => {
    h.q.complaints ??= h.db.prepare(`SELECT odi, crash, fire, injured, deaths, incident, received, components, summary FROM complaints
      WHERE make = ? AND model = ? AND year = ? ORDER BY received DESC, odi, first_row`);
    const y = yearKey(year);
    const rows = y === null ? [] : h.q.complaints.all(keyText(make), keyText(model), y);
    const results = rows.map(r => {
      const top = [];
      for (const c of JSON.parse(r.components)) {
        const t = c.split(':')[0].trim();
        if (t && !top.includes(t)) top.push(t);
      }
      return {odiNumber: r.odi, crash: r.crash === 1, fire: r.fire === 1, numberOfInjuries: r.injured, numberOfDeaths: r.deaths,
        dateOfIncident: monthFirst(r.incident), dateComplaintFiled: monthFirst(r.received), components: top.join(','), summary: r.summary};
    });
    return {results};
  });
}

/**
 * 5-Star Safety Ratings variants for a make, model and model year, from data/nhtsa-ratings.db: the variants the
 * SafetyRatings list call returns (in its order) with each one's VehicleId answer. The API matches make and model
 * ignoring case. When the crawl did not finish cleanly for this make, model or a variant, the answer is not
 * available here (reason not_crawled) and the live API is asked.
 */
export function localSafetyRatings(make, model, year, opts = {}) {
  return lookup('ratings', opts, h => {
    h.q.year ??= h.db.prepare('SELECT makes_ok FROM years WHERE year = ?');
    h.q.make ??= h.db.prepare('SELECT models_ok FROM makes WHERE year = ? AND make_key = ?');
    h.q.model ??= h.db.prepare('SELECT variants_ok FROM models WHERE year = ? AND make_key = ? AND model_key = ?');
    h.q.variants ??= h.db.prepare(`SELECT v.vehicle_id, v.description, r.body FROM variants v LEFT JOIN ratings r ON r.vehicle_id = v.vehicle_id
      WHERE v.year = ? AND v.make_key = ? AND v.model_key = ? ORDER BY v.ord`);
    const y = yearKey(year), mk = keyText(make), md = keyText(model);
    if (y === null) return {variants: []};
    if (!h.meta.years_ok) return {available: false, reason: 'not_crawled'};
    const yr = h.q.year.get(y);
    if (!yr) return {variants: []};                       // NHTSA lists no ratings for this model year
    if (!yr.makes_ok) return {available: false, reason: 'not_crawled'};
    const m = h.q.make.get(y, mk);
    if (!m) return {variants: []};
    if (!m.models_ok) return {available: false, reason: 'not_crawled'};
    const md0 = h.q.model.get(y, mk, md);
    if (!md0) return {variants: []};
    if (!md0.variants_ok) return {available: false, reason: 'not_crawled'};
    const variants = [];
    for (const v of h.q.variants.all(y, mk, md)) {
      if (v.body === null) return {available: false, reason: 'not_crawled'};
      variants.push({VehicleId: v.vehicle_id, VehicleDescription: v.description, detail: JSON.parse(v.body)});
    }
    return {variants};
  });
}

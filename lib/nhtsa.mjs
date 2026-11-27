/**
 * NHTSA (National Highway Traffic Safety Administration) API integration.
 * All endpoints are free and require no API key.
 * Docs: https://vpic.nhtsa.dot.gov/api/
 *
 * VIN decoding runs locally first: lib/vpic-local.mjs is NHTSA's own decode algorithm over the monthly vPIC
 * standalone database (data/vpic.db, scripts/import-vpic.py), whose rule tables carry mcp.vin's reviewed rule fixes
 * (data-src/vpic-rule-fixes.jsonl). The live vPIC API is the fallback (see localFallbackReason). Every decode carries
 * `decode_source` (which one was used, the vPIC release and whether rule fixes were applied) and, when a rule fix
 * changed a value for this VIN, `vpic_rule_fixes`: each changed field with NHTSA's official value, the fix, its reason
 * and evidence. `raw` holds the values of the decode used (fixed rules locally, NHTSA's own on the live API).
 *
 * Recalls, complaints and 5-Star Safety Ratings also answer from local copies of NHTSA's data first
 * (lib/nhtsa-local.mjs: the recall and complaint flat files, a crawl of the ratings API), shaped like the API's rows
 * and mapped by the same code below; the live api.nhtsa.gov call is the fallback. Every answer carries `data_source`.
 */

import { compactName, lookupRecallLabels } from './recall-labels.mjs';
import { localRecallRows, localRecallLabels, localComplaintRows, localSafetyRatings, localDataFallbackReason } from './nhtsa-local.mjs';
import { decodeLocal, VPIC_DB_FILE } from './vpic-local.mjs';
import { clean, num, parseDecodedResult } from './vpic-parse.mjs';

const VPIC_BASE = 'https://vpic.nhtsa.dot.gov/api/vehicles';
const RECALLS_BASE = 'https://api.nhtsa.gov/recalls/recallsByVehicle';
const COMPLAINTS_BASE = 'https://api.nhtsa.gov/complaints/complaintsByVehicle';
const SAFETY_BASE = 'https://api.nhtsa.gov/SafetyRatings';

const FETCH_TIMEOUT = 10_000;

/**
 * Create an AbortSignal that times out after the specified ms.
 */
function timeoutSignal(ms = FETCH_TIMEOUT) {
  return AbortSignal.timeout(ms);
}

export const DECODE_SOURCE_LOCAL = 'mcp_vin_vpic_local';
export const DECODE_SOURCE_LIVE = 'nhtsa_vpic_api';

/** The local dataset file: VPIC_LOCAL_DB=off turns the local decoder off (tests), a path replaces data/vpic.db. */
function localFile(opts) {
  if (opts && 'vpicFile' in opts) return opts.vpicFile;
  const env = process.env.VPIC_LOCAL_DB;
  if (env === 'off') return null;
  return env || VPIC_DB_FILE;
}

function localDecode(vin, opts = {}) {
  const file = localFile(opts);
  if (!file) return { available: false, reason: 'local_decoder_off' };
  try {
    return decodeLocal(vin, { file, ...(opts.now ? { now: opts.now } : {}) });
  } catch (err) {
    return { available: false, reason: 'decode_failed', error: err.message };
  }
}

/**
 * Why the live API decodes this VIN instead of the local copy, or null when the local decode is used:
 *   the dataset is missing or unreadable, or the local decode failed;
 *   wmi_unknown            the WMI is not in the release (error 7): a manufacturer registered since;
 *   no_model               nothing decoded the model: the patterns may have been submitted since the release;
 *   model_year_newer_than_release
 *                          the model year is later than the release's year (2027+ for release 2026_11). Patterns
 *                          of a model year still being submitted change most between releases: in release 2026_11,
 *                          9.9% of the patterns of schemas starting with model year 2027 (93% for 2028) changed in
 *                          the 30 days before the dump, against 2.8% for 2026 and under 1% for 2025 and older.
 */
export function localFallbackReason(local) {
  if (!local) return 'dataset_not_indexed';
  if (!local.available) return local.reason || 'decode_failed';
  const v = local.values || {};
  const codes = String(v.ErrorCode ?? '').split(',').map(c => c.trim());
  if (codes.includes('7')) return 'wmi_unknown';
  if (!v.Model) return 'no_model';
  const releaseYear = Number(String(local.release || '').slice(0, 4));
  const year = Number(v.ModelYear);
  if (!Number.isInteger(releaseYear) || releaseYear < 2000) return 'release_unknown';
  if (Number.isInteger(year) && year > releaseYear) return 'model_year_newer_than_release';
  return null;
}

function localSource(local, extra = {}) {
  const fixes = local.rule_fixes_in_dataset ?? 0;
  return { source: DECODE_SOURCE_LOCAL, label: 'mcp.vin decoder: NHTSA\'s vPIC decode run on NHTSA\'s monthly vPIC database', vpic_release: local.release ?? null,
    vpic_release_name: local.release_name ?? null, dataset_built_at: local.built_at ?? null,
    rules: fixes ? 'nhtsa_with_mcp_vin_rule_fixes' : 'nhtsa', rule_fixes_in_dataset: fixes,
    rule_fixes_changed_this_vin: !!local.rule_fixes, fallback_reason: null, ...extra };
}
function liveSource(reason, local) {
  return { source: DECODE_SOURCE_LIVE, label: 'NHTSA vPIC API (DecodeVinValues), live', vpic_release: 'live', rules: 'nhtsa',
    rule_fixes_in_dataset: 0, rule_fixes_changed_this_vin: false, fallback_reason: reason,
    local_vpic_release: local?.available ? local.release ?? null : null,
    note: 'Decoded by NHTSA\'s live API: mcp.vin\'s rule fixes apply to the local decoder only.' };
}

/** A parsed decode with its source and, when a rule fix changed a value for this VIN, what NHTSA's own rules give. */
function finishDecode(raw, source, ruleFixes = null) {
  const parsed = parseDecodedResult(raw);
  parsed.decode_source = source;
  if (ruleFixes) parsed.vpic_rule_fixes = ruleFixes;
  return parsed;
}

async function liveDecodeRaw(vin, fetchImpl) {
  try {
    const url = `${VPIC_BASE}/DecodeVinValues/${encodeURIComponent(vin)}?format=json`;
    const res = await fetchImpl(url, { signal: timeoutSignal() });

    if (!res.ok) {
      console.error(`[nhtsa] decodeVin HTTP ${res.status} for ${vin}`);
      return null;
    }

    const data = await res.json();
    const results = data?.Results;
    if (!Array.isArray(results) || results.length === 0 || !results[0] || typeof results[0] !== 'object') {
      console.error(`[nhtsa] decodeVin no results for ${vin}`);
      return null;
    }
    return results[0];
  } catch (err) {
    console.error(`[nhtsa] decodeVin error for ${vin}:`, err.message);
    return null;
  }
}

/** The answer for one VIN given its local decode and (when it was needed) the live API's raw result. */
function chooseDecode(vin, local, reason, liveRaw) {
  if (!reason) return finishDecode(local.values, localSource(local), local.rule_fixes);
  if (liveRaw) return finishDecode(liveRaw, liveSource(reason, local));
  if (local?.available) {
    return finishDecode(local.values, localSource(local, { fallback_reason: reason, live_api: 'failed',
      note: 'The live vPIC API was asked because of the fallback reason and did not answer; this is the local decode.' }), local.rule_fixes);
  }
  return null;
}

/**
 * Decode a single VIN: locally (data/vpic.db) when the dataset is there, else or on a fallback reason with the live
 * NHTSA vPIC API. Options (tests): {vpicFile, fetch, now}.
 * @param {string} vin - 17-character VIN
 * @returns {object|null} Parsed vehicle data or null on error
 */
export async function decodeVin(vin, opts = {}) {
  const local = localDecode(vin, opts);
  const reason = localFallbackReason(local);
  const liveRaw = reason ? await liveDecodeRaw(vin, opts.fetch || globalThis.fetch) : null;
  return chooseDecode(vin, local, reason, liveRaw);
}

async function liveBatchRaw(vins, fetchImpl) {
  try {
    const url = `${VPIC_BASE}/DecodeVINValuesBatch/`;
    // Format: "vin1,;vin2,;vin3,"
    const body = new URLSearchParams({ DATA: vins.map(v => `${v},`).join(';'), format: 'json' }).toString();

    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: timeoutSignal(),
    });

    if (!res.ok) {
      console.error(`[nhtsa] batchDecode HTTP ${res.status}`);
      return vins.map(() => null);
    }

    const data = await res.json();
    const results = data?.Results;
    if (!Array.isArray(results) || results.length === 0) {
      console.error(`[nhtsa] batchDecode no results`);
      return vins.map(() => null);
    }
    // Match each answer to its VIN; fall back to position only when the API omits the VIN and the counts agree.
    const byVin = new Map(results.filter(r => r && typeof r === 'object' && r.VIN).map(r => [String(r.VIN).trim().toUpperCase(), r]));
    return vins.map((v, i) => byVin.get(String(v).trim().toUpperCase()) ?? (results.length === vins.length && results[i] && typeof results[i] === 'object' && !results[i].VIN ? results[i] : null));
  } catch (err) {
    console.error(`[nhtsa] batchDecode error:`, err.message);
    return vins.map(() => null);
  }
}

/**
 * Batch decode up to 50 VINs: each locally when it can be, the rest in one live batch request.
 * @param {string[]} vins - Array of VINs (max 50)
 * @returns {object[]} Array of parsed results (null entries for failures)
 */
export async function batchDecode(vins, opts = {}) {
  if (!Array.isArray(vins) || vins.length === 0) return [];

  const batch = vins.slice(0, 50);
  const locals = batch.map(v => localDecode(v, opts));
  const reasons = locals.map(localFallbackReason);
  const needLive = batch.filter((_, i) => reasons[i]);
  const liveRaws = needLive.length ? await liveBatchRaw(needLive, opts.fetch || globalThis.fetch) : [];
  let j = 0;
  return batch.map((vin, i) => {
    try {
      return chooseDecode(vin, locals[i], reasons[i], reasons[i] ? liveRaws[j++] : null);
    } catch {
      return null;
    }
  });
}

/**
 * recallsByVehicle returns ReportReceivedDate day-first (DD/MM/YYYY), e.g.
 * "15/10/2024" and "29/03/2018" (checked against NHTSA's flat-file RCDATE
 * 2026-11-16). Return ISO YYYY-MM-DD, or null for anything else.
 */
export function nhtsaDayFirstDate(value) {
  const m = typeof value === 'string' && value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`, d = new Date(iso + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === iso && iso > '1966-01-01' ? iso : null;
}

/** NHTSA consumer advisories. Absent or non-boolean values stay unknown (null), never false. */
function flag(value) {
  return typeof value === 'boolean' ? value : null;
}

export const NHTSA_SOURCE_LOCAL = 'mcp_vin_nhtsa_local';
export const NHTSA_SOURCE_LIVE = 'nhtsa_api';
const LOCAL_LABELS = {
  recalls: 'mcp.vin copy of NHTSA\'s recall flat files (FLAT_RCL) and campaign records',
  complaints: 'mcp.vin copy of NHTSA\'s complaint flat file (FLAT_CMPL)',
  ratings: 'mcp.vin copy of NHTSA\'s 5-Star Safety Ratings (crawl of the SafetyRatings API)',
};
const LIVE_LABELS = {
  recalls: 'NHTSA recalls API (recallsByVehicle), live',
  complaints: 'NHTSA complaints API (complaintsByVehicle), live',
  ratings: 'NHTSA 5-Star Safety Ratings API (SafetyRatings), live',
};
/** Where an answer came from: the local copy (with its NHTSA file date) or the live API (with the reason). */
function localDataSource(kind, local, extra = {}) {
  return { source: NHTSA_SOURCE_LOCAL, label: LOCAL_LABELS[kind], ...(local?.info || {}), fallback_reason: null, ...extra };
}
function liveDataSource(kind, reason, local) {
  return { source: NHTSA_SOURCE_LIVE, label: LIVE_LABELS[kind], fallback_reason: reason,
    local_file_date: local?.available ? local.info?.file_date ?? null : null };
}
const LIVE_FAILED_NOTE = 'The live NHTSA API was asked because of the fallback reason and did not answer; this is the local copy.';
const LIVE_FIRST_FAILED_NOTE = 'The live NHTSA API is asked first for this kind and did not answer; this is the local copy.';

/**
 * Local first (lib/nhtsa-local.mjs), live API on a fallback reason; the local copy again, marked, when the live API
 * fails. `answer(rows, source)` builds the result; `live()` returns NHTSA's rows or null.
 */
async function localFirst(kind, local, now, live, answer, unavailable) {
  const reason = localDataFallbackReason(kind, local, now);
  if (!reason) return answer(local, localDataSource(kind, local));
  const rows = await live();
  if (rows) return answer(rows, liveDataSource(kind, reason, local));
  if (local?.available) return answer(local, localDataSource(kind, local, { fallback_reason: reason, live_api: 'failed', note: LIVE_FAILED_NOTE }));
  return { ...unavailable, data_source: liveDataSource(kind, reason, local) };
}

/**
 * The live API first and the local copy when it fails: NHTSA_COMPLAINTS_FIRST=live for complaints. The complaint
 * flat file lacks the model NHTSA's API files some complaints under (docs/nhtsa-local-data.md), so this mode keeps
 * the live answer's exact list while the API works and still answers when it does not.
 */
async function liveFirst(kind, local, now, live, answer, unavailable) {
  const rows = await live();
  if (rows) return answer(rows, liveDataSource(kind, 'live_first', local));
  if (local?.available) return answer(local, localDataSource(kind, local, { fallback_reason: localDataFallbackReason(kind, local, now), mode: 'live_first', live_api: 'failed', note: LIVE_FIRST_FAILED_NOTE }));
  return { ...unavailable, data_source: liveDataSource(kind, 'live_first', local) };
}

/** recallsByVehicle rows (live or local) as the report's recall list. */
function recallList(results) {
  return results.map(r => ({
    campaign_number: clean(r.NHTSACampaignNumber),
    component: clean(r.Component),
    // Local rows only: every component a multi-component campaign recalls (the API names one of them).
    ...(Array.isArray(r.components) && r.components.length > 1 ? { components: r.components.map(clean).filter(Boolean) } : {}),
    summary: clean(r.Summary),
    consequence: clean(r.Consequence),
    remedy: clean(r.Remedy),
    report_date: clean(r.ReportReceivedDate),
    // Same date as report_date, unambiguous. report_date keeps NHTSA's original day-first text.
    report_received_date: nhtsaDayFirstDate(r.ReportReceivedDate),
    manufacturer: clean(r.Manufacturer),
    // NHTSA consumer advisories for the whole campaign, not this VIN's repair status.
    park_it: flag(r.parkIt),
    park_outside: flag(r.parkOutSide),
    over_the_air_update: flag(r.overTheAirUpdate),
  }));
}

async function liveRecallRows(make, model, year, fetchImpl) {
  try {
    const params = new URLSearchParams({
      make: String(make),
      model: String(model),
      modelYear: String(year),
    });
    const url = `${RECALLS_BASE}?${params}`;
    const res = await fetchImpl(url, { signal: timeoutSignal() });

    // Live 2026-11-16: a make/model/year with no campaigns returns HTTP 400 with
    // {"Count":0,"Message":"Results returned successfully","results":[]}.
    // Accept exactly that body as zero campaigns; any other non-200 stays unavailable.
    let data = null;
    if (!res.ok) {
      if (res.status === 400) { try { data = await res.json(); } catch { data = null; } }
      const emptySuccess = data && data.Count === 0 && Array.isArray(data.results) && data.results.length === 0 && data.Message === 'Results returned successfully';
      if (!emptySuccess) {
        console.error(`[nhtsa] getRecalls HTTP ${res.status}`);
        return null;
      }
    } else {
      data = await res.json();
    }
    const results = data?.results;
    if (!Array.isArray(results)) throw new Error('Invalid recalls response');
    return results;
  } catch (err) {
    console.error(`[nhtsa] getRecalls error:`, err.message);
    return null;
  }
}

/**
 * Get recall data for a specific vehicle: NHTSA's model-year campaigns from the local copy of the recall flat files,
 * the live recallsByVehicle API as the fallback. Options (tests): {file, fetch, now}.
 * @param {string} make
 * @param {string} model
 * @param {number|string} year
 * @returns {object} { count, recalls, data_source }
 */
export async function getRecalls(make, model, year, opts = {}) {
  const local = localRecallRows(make, model, year, opts);
  return localFirst('recalls', local, opts.now, () => liveRecallRows(make, model, year, opts.fetch || globalThis.fetch),
    (rows, data_source) => {
      const recalls = recallList(Array.isArray(rows) ? rows : rows.results);
      return { available: true, count: recalls.length, recalls,
        scope: 'make_model_year', vin_specific: false,
        note: 'Campaigns for this make, model and year; applicability and repair status for this VIN are not determined.',
        verification_url: 'https://www.nhtsa.gov/recalls', data_source };
    },
    { available: false, count: null, recalls: [], error: 'Recall lookup unavailable' });
}

const RECALL_MODELS_BASE = 'https://api.nhtsa.gov/products/vehicle/models';
// Related labels looked up per report (one recallsByVehicle call each). Labels past the cap are
// listed in unchecked_labels, never dropped silently.
export const MAX_RELATED_LABELS = 8;

const upperWords = v => String(v ?? '').toUpperCase().split(/\s+/).filter(Boolean).join(' ');
const nameTokens = v => upperWords(v).match(/[A-Z0-9]+/g) || [];
/** Compact forms of each proper leading run of tokens: [F,150,X] -> F, F150. */
const leadingJoins = t => new Set(t.slice(0, -1).map((_, k) => t.slice(0, k + 1).join('')));
const startsWithTokens = (t, prefix) => prefix.length > 0 && prefix.every((p, i) => t[i] === p);
// Words vPIC adds to a model family name that NHTSA labels leave out (Mercedes-Benz "C-Class", "EQS-Class Sedan").
const FAMILY_WORDS = new Set(['CLASS', 'SERIES', 'SEDAN', 'COUPE', 'CABRIOLET', 'CONVERTIBLE', 'WAGON', 'ROADSTER', 'HATCHBACK']);
const parentheticalParts = model => {
  const m = String(model ?? '').match(/^(.*?)\s*\(([^()]*)\)\s*(.*)$/);
  return m ? [m[1] + ' ' + m[3], m[2]].filter(p => compactName(p)) : [];
};
/** Compact forms of the decoded name that count as "NHTSA files under this name". */
export function decodedNameForms(model) {
  return [...new Set([compactName(model), ...parentheticalParts(model).map(compactName)].filter(Boolean))];
}
const MATCH_ORDER = ['longer_name', 'spelling', 'parenthetical', 'family_name', 'make_name', 'shorter_name', 'trailing_name'];

/**
 * How an NHTSA recall model label relates to the vPIC model name, or null. Measured 2026-11-16
 * against NHTSA's recall flat files (30 makes, model years 2012-2025):
 *  longer_name   label adds words or a model number: CR-V -> CR-V HYBRID, ES -> ES350
 *  spelling      same letters and digits: Mustang Mach-E -> MUSTANG MACH E, F 800 GS -> F800 GS
 *  parenthetical vPIC adds a parenthetical: Prius Prime (PHEV) -> PRIUS PRIME
 *  family_name   vPIC family name: C-Class -> C 300, AMG C63; EQS-Class Sedan -> EQS 450
 *  make_name     label adds or drops the make: Nissan Z -> Z
 *  shorter_name / trailing_name  label is the start or end of the vPIC name (Expedition MAX -> EXPEDITION,
 *                Golf GTI -> GTI); used only when NHTSA has never filed under the decoded name itself
 *                (decodedNameUsed false), because otherwise the shorter label is usually another vehicle
 *                (Transit Connect -> TRANSIT).
 * Every match only means "may or may not apply".
 */
export function modelLabelMatch(model, label, { make = '', decodedNameUsed = true } = {}) {
  const uv = upperWords(model), ul = upperWords(label), tv = nameTokens(model), tl = nameTokens(label);
  const cv = tv.join(''), cl = tl.join('');
  if (!cv || !cl || ul.length > 80) return null;
  if (uv === ul) return 'exact';
  if (ul.startsWith(uv + ' ') || leadingJoins(tl).has(cv)
    || (tl[0].startsWith(cv) && cl.length > cv.length && /\d/.test(cl[cv.length]) && !/\d$/.test(cv))) return 'longer_name';
  if (cv === cl) return 'spelling';
  if (parentheticalParts(model).some(p => { const cp = compactName(p); return cp === cl || leadingJoins(tl).has(cp) || ul.startsWith(upperWords(p) + ' '); })) return 'parenthetical';
  const family = tv.filter(t => !FAMILY_WORDS.has(t));
  // A sedan family name is not an SUV label (EQE-Class Sedan vs AMG EQE SUV 53).
  if (family.length && family.length !== tv.length && !(tl.includes('SUV') && !tv.includes('SUV'))) {
    const g = family.join(''), ta = tl.filter(t => t !== 'AMG').length ? tl.filter(t => t !== 'AMG') : tl;
    if (g === cl || leadingJoins(tl).has(g) || leadingJoins(family).has(cl) || g === ta.join('') || leadingJoins(ta).has(g)
      || (ta[0].startsWith(g) && ta[0].length > g.length && /\d/.test(ta[0][g.length]))) return 'family_name';
  }
  const mw = nameTokens(make);
  if ((startsWithTokens(tl, mw) && tl.length > mw.length && tl.slice(mw.length).join('') === cv)
    || (startsWithTokens(tv, mw) && tv.length > mw.length && tv.slice(mw.length).join('') === cl)) return 'make_name';
  if (!decodedNameUsed) {
    if (leadingJoins(tv).has(cl)) return 'shorter_name';
    if (tv.length > tl.length && cl.length >= 3 && !/^\d+$/.test(cl) && tv.slice(tv.length - tl.length).join(' ') === tl.join(' ')) return 'trailing_name';
  }
  return null;
}

/** Related labels (not the exact one), strongest kinds first, each as {label, match}. */
export function relatedModelMatches(model, labels, options = {}) {
  if (!String(model ?? '').trim() || !Array.isArray(labels)) return [];
  const found = new Map();
  for (const label of labels) {
    if (typeof label !== 'string') continue;
    const u = upperWords(label), match = modelLabelMatch(model, u, options);
    if (match && match !== 'exact' && !found.has(u)) found.set(u, match);
  }
  return [...found].map(([label, match]) => ({ label, match }))
    .sort((a, b) => MATCH_ORDER.indexOf(a.match) - MATCH_ORDER.indexOf(b.match) || a.label.localeCompare(b.label));
}

/**
 * NHTSA files some campaigns under another model label than vPIC decodes:
 * live 2026-11-16, a 2024 CR-V hybrid VIN decodes as "CR-V", while 24V763,
 * 26V366 and 26V663 are filed only under "CR-V HYBRID". Returns the related labels.
 */
export function relatedModelLabels(model, labels, options = {}) {
  return relatedModelMatches(model, labels, options).map(m => m.label);
}

const RELATED_NOTE = 'Campaigns NHTSA files for the same make and year under another model name that matches the decoded model (a longer name such as a hybrid or body-style label, a different spelling, or a family name). They may or may not apply to this vehicle; check the VIN with the manufacturer. Not VIN repair status.';

/** Run `fn` over `items`, at most `limit` at a time; results in input order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Related-name campaign lookups in flight at once when api.nhtsa.gov is asked (one recallsByVehicle call each; results
// cached 6 hours per make/model/year by lib/reports.mjs). Was one at a time; three keeps the same requests gentle and
// cuts the wait. Answers from the local recall copy make no request, so those all run at once.
const RELATED_CONCURRENCY = 3;

/**
 * Campaigns filed under related NHTSA model labels for the same make and year,
 * minus campaigns already in the exact-label list. These may or may not apply.
 * With the local recall copy (lib/nhtsa-local.mjs) the labels and their campaigns come from the same flat files and
 * nothing is asked live. Without it, labels come from NHTSA's /products/vehicle/models reply, which lists only part of
 * a make's labels (checked 2026-11-16), and from the local flat-file label index when it is installed, and each label's
 * campaigns from the live API. Options: {labelIndex, local: options for the local copy (tests: {file, now})}.
 * `exactRecalls`: the exact-name campaigns, or a promise of them (the label search then runs while the exact lookup
 * is still out); null (or a promise of null) when the exact lookup failed: no per-name lookup is made then.
 */
export async function getRelatedModelRecalls(make, model, year, exactRecalls = [], { labelIndex = lookupRecallLabels, local = {} } = {}) {
  const unavailable = { available: false, scope: 'make_related_model_year', vin_specific: false, count: null, models: [] };
  try {
    const localLabels = localRecallLabels({ makes: [make], year, names: decodedNameForms(model) }, local);
    const useLocal = !localDataFallbackReason('recalls', localLabels, local.now);
    const params = new URLSearchParams({ modelYear: String(year), make: String(make), issueType: 'r' });
    const [products, index] = await Promise.all([
      useLocal ? null : fetch(`${RECALL_MODELS_BASE}?${params}`, { signal: timeoutSignal() })
        .then(async res => { const data = res.ok ? await res.json() : null; return Array.isArray(data?.results) ? data.results.map(r => r?.model) : null; })
        .catch(() => null),
      useLocal ? localLabels : Promise.resolve().then(() => labelIndex({ makes: [make], year, names: decodedNameForms(model) })).catch(() => ({ available: false })),
    ]);
    if (!products && !index?.available) return unavailable;
    const labels = [...(products || []), ...(index?.available ? index.labels.map(l => l.model) : [])];
    // Without the index it is unknown whether NHTSA ever files under the decoded name, so the
    // shorter/trailing rules stay off rather than guessing.
    const decodedNameUsed = index?.available ? decodedNameForms(model).some(n => index.used_names.has(n)) : true;
    const matches = relatedModelMatches(model, labels, { make, decodedNameUsed });
    const checked = matches.slice(0, MAX_RELATED_LABELS), unchecked = matches.slice(MAX_RELATED_LABELS);
    const exact = await exactRecalls;
    if (!Array.isArray(exact)) return unavailable;
    const known = new Set(exact.map(r => r?.campaign_number).filter(Boolean));
    const results = await mapLimit(checked, useLocal ? checked.length : RELATED_CONCURRENCY, m => getRecalls(make, m.label, year, local));
    if (results.some(r => r.available === false)) return unavailable;
    const models = [], seen = new Set();
    checked.forEach((m, i) => {
      const extra = results[i].recalls.filter(c => c.campaign_number && !known.has(c.campaign_number) && !seen.has(c.campaign_number));
      extra.forEach(c => seen.add(c.campaign_number));
      models.push({ nhtsa_model: m.label, match: m.match, count: extra.length, recalls: extra });
    });
    // The live API files some campaigns under other text than the flat file (live 2026-11-16:
    // GLE 350 vs GLE350, DODGE RAM 1500 vs RAM 1500). Campaigns the index lists under the exact or a
    // checked related name that no live answer returned are listed by number, not dropped. With the local copy
    // every answer comes from the flat files, so there is no such list.
    let flatOnly = null;
    if (index?.available && !useLocal) {
      const byLabel = new Map(index.labels.filter(l => upperWords(l.make) === upperWords(make)).map(l => [upperWords(l.model), l.campaign_numbers || []]));
      const live = new Set([...known, ...seen]), listed = new Set(), campaigns = [];
      for (const m of [{ label: upperWords(model), match: 'exact' }, ...checked]) {
        for (const c of byLabel.get(m.label) || []) {
          if (live.has(c) || listed.has(c)) continue;
          listed.add(c);
          campaigns.push({ campaign_number: c, nhtsa_model: m.label, match: m.match });
        }
      }
      flatOnly = { count: campaigns.length, campaigns, snapshot_latest_report_date: index.source?.latest_report_date ?? null,
        note: 'Listed in NHTSA\'s recall flat file under the exact or a related model name for this make and year, but not returned by NHTSA\'s live recall lookup for that name (NHTSA sometimes files the same campaign under other text, such as GLE350 for GLE 350). Details are not loaded; look the campaign number up at NHTSA. They may or may not apply to this vehicle.' };
    }
    const decodedNameInData = index?.available ? decodedNameUsed : null;
    return { available: true, scope: 'make_related_model_year', vin_specific: false, count: seen.size,
      models: models.filter(m => m.count > 0), flat_file_only: flatOnly,
      checked_labels: checked.map(m => m.label), unchecked_labels: unchecked.map(m => m.label),
      decoded_name_in_recall_data: decodedNameInData,
      label_sources: { products_api: useLocal ? 'not_asked' : products ? 'partial_list' : 'unavailable',
        flat_file_index: index?.available ? { latest_report_date: index.source?.latest_report_date ?? null, ...(useLocal ? { local_copy: true } : {}) } : 'not_installed' },
      note: RELATED_NOTE + (unchecked.length ? ` ${unchecked.length} more related model name${unchecked.length === 1 ? ' was' : 's were'} not checked (unchecked_labels).` : '')
        + (index?.available ? '' : ' The related-name list is partial: NHTSA\'s model list for this make and year is incomplete and the local label index is not installed.') };
  } catch (err) {
    console.error(`[nhtsa] getRelatedModelRecalls error:`, err.message);
    return unavailable;
  }
}

/** complaintsByVehicle rows (live or local) as the report's complaint block. */
function complaintAnswer(results, data_source) {
  let crashes = 0;
  let fires = 0;
  let injuries = 0;
  let deaths = 0;

  const complaints = results.map(r => {
    const crash = r.crash === 'YES' || r.crash === true;
    const fire = r.fire === 'YES' || r.fire === true;
    const injuryCount = num(r.numberOfInjuries) || 0;
    const deathCount = num(r.numberOfDeaths) || 0;

    if (crash) crashes++;
    if (fire) fires++;
    injuries += injuryCount;
    deaths += deathCount;

    return {
      odi_number: clean(r.odiNumber),
      date_of_incident: clean(r.dateOfIncident),
      date_complaint_filed: clean(r.dateComplaintFiled),
      component: clean(r.components),
      summary: clean(r.summary),
      crash,
      fire,
      injuries: injuryCount,
      deaths: deathCount,
    };
  });

  return {
    available: true,
    scope: 'make_model_year',
    count: complaints.length,
    complaints,
    summary: { crashes, fires, injuries, deaths },
    data_source,
  };
}

async function liveComplaintRows(make, model, year, fetchImpl, timeoutMs) {
  try {
    const params = new URLSearchParams({
      make: String(make),
      model: String(model),
      modelYear: String(year),
    });
    const url = `${COMPLAINTS_BASE}?${params}`;
    const res = await fetchImpl(url, { signal: timeoutSignal(timeoutMs) });

    if (!res.ok) {
      console.error(`[nhtsa] getComplaints HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const results = data?.results;
    if (!Array.isArray(results)) throw new Error('Invalid complaints response');
    return results;
  } catch (err) {
    console.error(`[nhtsa] getComplaints error:`, err.message);
    return null;
  }
}

/**
 * Get complaint data for a specific vehicle: NHTSA owner complaints from the local copy of the complaint flat file,
 * the live complaintsByVehicle API as the fallback. Options: {timeoutMs} for the live call (tests also {file, fetch,
 * now, first}). NHTSA can take 5-17 s to send a common model's list (1-2 MB); reports ask through modelYearComplaints
 * (lib/reports.mjs) with COMPLAINTS_TIMEOUT_MS. A local answer needs no wait.
 * @param {string} make
 * @param {string} model
 * @param {number|string} year
 * @param {{timeoutMs?: number}} [opts]
 * @returns {object} { count, complaints, summary, data_source }
 */
export const COMPLAINTS_TIMEOUT_MS = 30_000;
export async function getComplaints(make, model, year, opts = {}) {
  const { timeoutMs = FETCH_TIMEOUT } = opts;
  const local = localComplaintRows(make, model, year, opts);
  const order = (opts.first ?? process.env.NHTSA_COMPLAINTS_FIRST) === 'live' ? liveFirst : localFirst;
  return order('complaints', local, opts.now, () => liveComplaintRows(make, model, year, opts.fetch || globalThis.fetch, timeoutMs),
    (rows, data_source) => complaintAnswer(Array.isArray(rows) ? rows : rows.results, data_source),
    { available: false, count: null, complaints: [], summary: null, error: 'Complaint lookup unavailable' });
}

const NO_RATINGS = {
  rated: false,
  overall: null,
  frontal_driver: null,
  frontal_passenger: null,
  side_driver: null,
  side_passenger: null,
  rollover: null,
  side_pole: null,
  variants: [],
};

/** SafetyRatings variants ({VehicleId, detail: VehicleId answer's Results[0]}, in the list's order) as the report's block. */
function ratingsAnswer(variants, data_source) {
  const detailedVariants = variants.filter(v => v.detail).map(({ VehicleId: vehicleId, detail: r }) => ({
    vehicle_id: vehicleId,
    description: clean(r.VehicleDescription),
    overall: num(r.OverallRating),
    frontal_driver: num(r.FrontCrashDriversideRating),
    frontal_passenger: num(r.FrontCrashPassengersideRating),
    side_driver: num(r.SideCrashDriversideRating),
    side_passenger: num(r.SideCrashPassengersideRating),
    rollover: num(r.RolloverRating),
    side_pole: num(r.SidePoleCrashRating),
  }));

  if (detailedVariants.length === 0) {
    return { ...NO_RATINGS, data_source };
  }

  // Use the first variant's ratings as the primary result
  const primary = detailedVariants[0];

  return {
    rated: true,
    overall: primary.overall,
    frontal_driver: primary.frontal_driver,
    frontal_passenger: primary.frontal_passenger,
    side_driver: primary.side_driver,
    side_passenger: primary.side_passenger,
    rollover: primary.rollover,
    side_pole: primary.side_pole,
    variants: detailedVariants,
    data_source,
  };
}

/** The live list + detail calls; null when the list call failed (a failed detail call skips that variant, as before). */
async function liveRatingVariants(make, model, year, fetchImpl) {
  try {
    // Step 1: Find vehicle variants
    const listUrl = `${SAFETY_BASE}/modelyear/${encodeURIComponent(year)}/make/${encodeURIComponent(make)}/model/${encodeURIComponent(model)}?format=json`;
    const listRes = await fetchImpl(listUrl, { signal: timeoutSignal() });

    if (!listRes.ok) {
      console.error(`[nhtsa] getSafetyRatings list HTTP ${listRes.status}`);
      return null;
    }

    const listData = await listRes.json();
    const variants = listData?.Results || [];

    // Step 2: Fetch details for each variant, three at a time (was one after another), kept in NHTSA's order
    const details = await mapLimit(variants, 3, async variant => {
      const vehicleId = variant.VehicleId;
      if (!vehicleId) return null;

      try {
        const detailUrl = `${SAFETY_BASE}/VehicleId/${vehicleId}?format=json`;
        const detailRes = await fetchImpl(detailUrl, { signal: timeoutSignal() });

        if (!detailRes.ok) return null;

        const detailData = await detailRes.json();
        const r = detailData?.Results?.[0];
        if (!r) return null;
        return { VehicleId: vehicleId, detail: r };
      } catch (innerErr) {
        console.error(`[nhtsa] getSafetyRatings detail error for ${vehicleId}:`, innerErr.message);
        return null;
      }
    });
    return details.filter(Boolean);
  } catch (err) {
    console.error(`[nhtsa] getSafetyRatings error:`, err.message);
    return null;
  }
}

/**
 * Get NCAP safety ratings for a specific vehicle: from the local copy of NHTSA's 5-Star Safety Ratings, the live
 * SafetyRatings API (list, then one detail call per variant) as the fallback. Options (tests): {file, fetch, now}.
 * @param {string} make
 * @param {string} model
 * @param {number|string} year
 * @returns {object} Safety ratings
 */
export async function getSafetyRatings(make, model, year, opts = {}) {
  const local = localSafetyRatings(make, model, year, opts);
  return localFirst('ratings', local, opts.now, () => liveRatingVariants(make, model, year, opts.fetch || globalThis.fetch),
    (rows, data_source) => ratingsAnswer(Array.isArray(rows) ? rows : rows.variants, data_source),
    { ...NO_RATINGS });
}

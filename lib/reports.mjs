/** Shared vehicle reports for REST, MCP and comparisons. */
import { validateVin, normalizeVin } from './validate.mjs';
import { decodeVin as nhtsaDecode, getRecalls, getComplaints, getSafetyRatings, getRelatedModelRecalls, COMPLAINTS_TIMEOUT_MS } from './nhtsa.mjs';
import { getFuelEconomy } from './epa.mjs';
import { vinCache, recallCache, ratingCache, fuelCache, complaintCache } from './cache.mjs';
import { recallStatusFor } from './recall-links.mjs';
import { InputError } from './research.mjs';
import { withBuildDates } from './recall-build-dates.mjs';
import { extraReportBlocks, compactExtraBlocks } from './more-sources.mjs';
import { fuelForOtherBlocks } from './transmission-choice.mjs';
import { lookupTestVehicleData, vinProfile } from './tire-placards.mjs';
import { decodeChecksFor, checkedDecode, fixTestVehicleRow, officialDecode } from './decode-checks.mjs';
import { compactDecodeChecks } from './decode-report.mjs';

/**
 * NHTSA model-year campaigns for the exact decoded make/model/year (`count`, `recalls`), plus
 * campaigns filed under related NHTSA model names in `related_models`, kept separate. When related
 * names carry campaigns, or could not be checked, `count_note` says the exact count may understate.
 * Used by full reports, /api/vin/{vin}/recalls and the MCP lookup_recalls tool.
 */
export async function modelYearRecalls(make, model, year) {
  const cacheKey = `${make}|${model}|${year}`;
  const exact = recallCache.has(cacheKey) ? Promise.resolve(recallCache.get(cacheKey))
    : getRecalls(make, model, year).then(r => { if (r?.available !== false) recallCache.set(cacheKey, r); return r; });
  if (!make || !model || !year) return exact;
  const relatedKey = cacheKey + '|related';
  // The related-name search starts beside the exact lookup: it needs the exact campaigns only before its per-name
  // lookups (to skip them when the exact lookup failed) and to drop duplicates. It never rejects.
  const cachedRelated = recallCache.get(relatedKey);
  const relatedTask = cachedRelated ? null
    : getRelatedModelRecalls(make, model, year, exact.then(r => (!r || r.available === false ? null : r.recalls)));
  const recalls = await exact;
  if (!recalls || recalls.available === false) return recalls;
  let related = cachedRelated;
  if (!related) {
    related = await relatedTask;
    if (related.available) recallCache.set(relatedKey, related);
  }
  return withBuildDates(withRelatedRecalls(recalls, related), make, model, year);
}

/**
 * NHTSA's owner complaints for a make, model and year: one request per model at a time, shared by every caller
 * (reports, /api/vin/{vin}/complaints), and successful answers cached 6 hours. NHTSA can take 5-17 s to send a
 * common model's list (1-2 MB of JSON; a 2020 Ford Escape took 17 s from the web server on 2026-11-18), so the
 * request may run COMPLAINTS_TIMEOUT_MS (30 s); reports wait for it only up to their budget (fullReport). Never rejects.
 */
const complaintLookups = new Map();
export function modelYearComplaints(make, model, year) {
  const key = `${make}|${model}|${year}`;
  if (complaintCache.has(key)) return Promise.resolve(complaintCache.get(key));
  if (complaintLookups.has(key)) return complaintLookups.get(key);
  const lookup = Promise.resolve()
    .then(() => getComplaints(make, model, year, { timeoutMs: COMPLAINTS_TIMEOUT_MS }))
    .catch(err => { console.error('[reports] complaint lookup failed:', err?.message || err); return null; })
    .then(c => c || { available: false, count: null, complaints: [], summary: null, error: 'Complaint lookup unavailable' })
    .then(c => { if (c.available !== false) complaintCache.set(key, c); return c; })
    .finally(() => complaintLookups.delete(key));
  complaintLookups.set(key, lookup);
  return lookup;
}

/**
 * complaints while NHTSA's list is still arriving: unknown, never zero (count null, available false), with where
 * to get it.
 */
export function pendingComplaints(vin) {
  return { available: false, pending: true, reason: 'lookup_in_progress', scope: 'make_model_year', count: null, complaints: [], summary: null,
    status_url: `/api/vin/${vin}/complaints`,
    note: 'NHTSA had not sent its owner-complaint list for this make, model and year when this report was sent (a common model\'s list is 1-2 MB and can take 15 s or more), so the count is unknown here; it is not zero. The request keeps running: GET status_url waits for it, and the next report includes it.' };
}

/** Attach related-label campaigns without changing the exact-label count. */
export function withRelatedRecalls(recalls, related) {
  const flatOnly = related?.flat_file_only?.count || 0;
  const found = related?.available === true && typeof related.count === 'number' ? related.count > 0 || flatOnly > 0 : null;
  const n = related?.count, c = recalls.count;
  const exact = c === 0 ? 'No campaigns are' : `${c} campaign${c === 1 ? ' is' : 's are'}`;
  const parts = [];
  if (found === true) {
    parts.push(`${exact} filed under the exact decoded model name.`);
    if (n) parts.push(`NHTSA files ${n} more campaign${n === 1 ? '' : 's'} for this make and year under related model names (related_models).`);
    if (flatOnly) parts.push(`NHTSA's recall flat file lists ${flatOnly} more under this or related model names that its live lookup did not return (related_models.flat_file_only).`);
    parts.push('They may or may not apply to this vehicle.');
  } else if (found === null) {
    parts.push('Related NHTSA model names could not be checked, so campaigns filed under another model name may be missing from this count.');
  } else if (related?.decoded_name_in_recall_data === false) {
    parts.push('NHTSA\'s recall data has no campaign filed under this exact model name for this make in any model year, so campaigns for this vehicle may be filed under another model name that was not matched.');
  }
  return { ...recalls, related_models: related, related_campaigns_found: found, count_note: parts.length ? parts.join(' ') : null };
}

/**
 * How long a report waits for NHTSA's owner-complaint list (modelYearComplaints), counted from the request's start.
 *   report: the website and REST /api/vin/{vin}; mcp: MCP decode_vin (agents rarely come back for a second call).
 * Past it, `complaints` is pending (pendingComplaints) and the request keeps running; the next report includes it.
 */
export const COMPLAINTS_WAIT_MS = Object.freeze({ report: 2000, mcp: 6000 });

/**
 * The VIN recall block for a VIN (REST /api/vin/{vin}/recall-status, MCP vin_recall_status): links to the maker's and
 * NHTSA's recall pages (lib/recall-links.mjs). mcp.vin never asks a manufacturer about a VIN. The make comes from the
 * cached report, else the decode (local vPIC, or NHTSA's vPIC API as fallback); with no make, the WMI alone or NHTSA's
 * page only. Throws InputError for an invalid VIN.
 */
export async function vinRecallStatusFor(input) {
  const vin = normalizeVin(input);
  if (!validateVin(vin).valid) return recallStatusFor(vin); // its own InputError
  let make = vinCache.get(vin)?.vehicle?.make || '';
  if (!make) { try { make = (await nhtsaDecode(vin))?.vehicle?.make || ''; } catch { make = ''; } }
  return recallStatusFor(vin, make);
}

const WAITED = Symbol('waited');
/** The promise's value if it settles within `ms`, else WAITED. Infinity waits for it. */
function within(promise, ms) {
  if (ms === Infinity) return promise;
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, ms), WAITED); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The full report: the base report (decode, NHTSA, EPA, local indexes, the VIN recall links) with NHTSA's complaints
 * if they arrive within `complaintsWaitMs` of their request's start (COMPLAINTS_WAIT_MS); else complaints pending.
 */
export async function fullReport(vin, {complaintsWaitMs = COMPLAINTS_WAIT_MS.report} = {}) {
  const base = await reportEntry(vin).report;
  if (!base.vehicle) return base;
  return withComplaints(base, complaintsWaitMs);
}

// A report assembled before NHTSA's complaints arrived (complaints pending) → {at, promise}: the request's start
// and the complete report it becomes (the same object for every caller; null if it could not be built).
const completions = new WeakMap();
/** `report` with NHTSA's complaints if they arrive within `ms` of their request's start; else as given (pending). */
async function withComplaints(report, ms) {
  const completion = completions.get(report);
  if (!completion) return report;
  const complete = await within(completion.promise, completion.at + ms - Date.now());
  return complete === WAITED || !complete ? report : complete;
}

const pendingReports = new Map();
/**
 * The report without waiting for NHTSA's complaints; shares the cache with fullReport: when they had not arrived with
 * the rest, `complaints` is pending (pendingComplaints).
 */
export function baseReport(vin) { return reportEntry(vin).report; }
/** One assembly per VIN at a time, shared by concurrent callers. */
function reportEntry(vin) {
  const key = normalizeVin(vin);
  if (pendingReports.has(key)) return pendingReports.get(key);
  const report = assembleReport(key).finally(() => { pendingReports.delete(key); });
  const entry = { vin: key, report };
  pendingReports.set(key, entry);
  return entry;
}

async function assembleReport(vin) {
  vin = normalizeVin(vin);
  const cached = vinCache.get(vin);
  if (cached) return cached;

  const validation = validateVin(vin);
  if (!validation.valid) {
    return { valid: false, vin, validation, vehicle: null, engine: null, recalls: null, complaints: null, safety_ratings: null, fuel_economy: null, photos: null };
  }

  const decoded = await nhtsaDecode(vin);
  if (!decoded) {
    return { valid: true, vin, validation, vehicle: null, engine: null, error: 'NHTSA decode failed', recalls: null, complaints: null, safety_ratings: null, fuel_economy: null, photos: null };
  }
  const { year, make, model } = decoded.vehicle;
  const cacheKey = `${make}|${model}|${year}`;
  // Checks on the decode (lib/decode-checks.mjs): the matchers below use the checked values; the report keeps vPIC's.
  const decodeChecks = decodeChecksFor(vin, decoded);
  const used = decodeChecks ? checkedDecode(decoded, decodeChecks) : decoded;
  const raw = used.raw || {};
  const fuelKey = `${cacheKey}|${JSON.stringify([used.engine, used.transmission, used.vehicle, used.dimensions?.gvwr, raw.Series, raw.Series2, raw.Trim2, raw.Doors, raw.BatteryKWh, raw.BatteryKWh_to, raw.FuelTypeSecondary])}`;

  // NHTSA's complaints can take much longer than the rest (modelYearComplaints): the report is assembled without
  // waiting for them, and completes when they arrive (completions).
  const complaintsAt = Date.now(), complaintsTask = modelYearComplaints(make, model, year);
  const [recalls, ratings, fuel, testVehicle] = await Promise.all([
    modelYearRecalls(make, model, year),
    ratingCache.has(cacheKey) ? ratingCache.get(cacheKey) : getSafetyRatings(make, model, year).then(r => { if (r) ratingCache.set(cacheKey, r); return r; }),
    fuelCache.has(fuelKey) ? fuelCache.get(fuelKey) : getFuelEconomy(year, make, model, used).then(r => { if (r?.available || (r?.match === 'multiple_configurations' && !r.incomplete)) fuelCache.set(fuelKey, r); return r; }),
    // Local index of NHTSA's crash-test vehicles: closest match, never this VIN's own values (lib/tire-placards.mjs).
    // Async only for the Transport Canada generation check when a nearest-model-year match is in play.
    lookupTestVehicleData(vinProfile(used), {fixRow: fixTestVehicleRow}),
  ]);
  const recallBlock = recalls;

  const report = {
    valid: true, vin, validation,
    vehicle: decoded.vehicle, engine: decoded.engine, transmission: decoded.transmission,
    dimensions: decoded.dimensions, plant: decoded.plant, safety_equipment: decoded.safety,
    recalls: recallBlock || { count: 0, recalls: [] },
    complaints: null, // set below (complete) or pending
    safety_ratings: ratings || { rated: false },
    fuel_economy: fuel || { available: false },
    tire_placard: testVehicle.tire_placard,
    test_vehicle_specs: testVehicle.test_vehicle_specs,
    // raw_nhtsa: NHTSA's official decode (what NHTSA's own rules give); the blocks above carry any mcp.vin rule fix,
    // listed in vpic_rule_fixes with the official value and marked field by field in decode_checks.
    // NHTSA's photos of its own test car (lib/test-photos.mjs): null when no tested vehicle matches.
    photos: testVehicle.photos ?? null, raw_nhtsa: officialDecode(decoded).raw,
    decode_source: decoded.decode_source ?? null,
    ...(decoded.vpic_rule_fixes ? { vpic_rule_fixes: decoded.vpic_rule_fixes } : {}),
    ...extraReportBlocks(used, fuelForOtherBlocks(fuel)), // the transmission assumption stays in fuel_economy
    decode_checks: decodeChecks || { available: false, reason: 'check_failed', note: 'The decode checks could not run; the official decode is shown unchecked.' },
    // Links only (lib/recall-links.mjs): mcp.vin never asks a manufacturer about a VIN.
    recall_status: recallStatusFor(vin, decoded.vehicle.make),
    provenance: { assembled_at: new Date().toISOString(), specifications: specificationsProvenance(decoded), recalls: 'NHTSA make/model/year campaigns, not VIN repair status', recall_status: 'Links to the manufacturer\'s and NHTSA\'s VIN recall pages; mcp.vin does not check a VIN\'s recall repairs with anyone', complaints: 'NHTSA owner reports; not confirmed defects or incidence rates', fuel: 'FuelEconomy.gov configuration: exact, closest (with what differs) or the range across the configurations the VIN fits', decode_checks: 'Field-by-field checks on the official decode: mcp.vin\'s reviewed fixes of NHTSA\'s vPIC rules, NHTSA lab records of test vehicles with the same VIN pattern, and EPA\'s configurations for the model year; vPIC\'s value is kept beside any correction', tire_placard: 'Door-placard values of a vehicle NHTSA tested in a crash or compliance test (closest match by model year and version, stated per vehicle), not this VIN', test_vehicle_specs: 'Capacities and weights (and an FMVSS 135 stopping distance when indexed) of a vehicle NHTSA tested in a crash or compliance test (closest match, stated per vehicle; a fuel tank from another year or version is a best guess), not this VIN', photos: 'Photos of a vehicle NHTSA tested, taken by its test lab (NHTSA vehicle crash-test database), served by mcp.vin; closest match like test_vehicle_specs, never another body style, cab or generation; not this vehicle' },
  };

  const transientFuelFailure = ['upstream_error', 'invalid_response'].includes(fuel?.reason) || fuel?.incomplete === true;
  const complete = complaints => {
    const done = { ...report, complaints: complaints || { count: 0, complaints: [], summary: { crashes: 0, fires: 0, injuries: 0, deaths: 0 } } };
    if (recalls?.available !== false && complaints?.available !== false && !transientFuelFailure) vinCache.set(vin, done);
    return done;
  };
  const arrived = await within(complaintsTask, 0);
  if (arrived !== WAITED) return complete(arrived);
  // Still arriving: a report with complaints pending now; the complete one is built (and cached) when they arrive.
  const partial = { ...report, complaints: pendingComplaints(vin) };
  completions.set(partial, { at: complaintsAt, promise: complaintsTask.then(complete).catch(err => {
    console.error('[reports] completing report with complaints failed:', err?.message || err); return null; }) });
  return partial;
}

/**
 * The photos block for a VIN (GET /api/vin/{vin}/photo): the cached report's, else the decode and the local test-vehicle
 * index only (no recall, complaint or rating lookups). null when no tested vehicle matches; throws InputError for an
 * invalid VIN.
 */
export async function vinPhotos(input) {
  const vin = normalizeVin(input);
  if (!validateVin(vin).valid) throw new InputError('Invalid VIN');
  const cached = vinCache.get(vin);
  if (cached) return cached.photos ?? null;
  const decoded = await nhtsaDecode(vin);
  if (!decoded?.vehicle) return null;
  const checks = decodeChecksFor(vin, decoded);
  const used = checks ? checkedDecode(decoded, checks) : decoded;
  return (await lookupTestVehicleData(vinProfile(used), {fixRow: fixTestVehicleRow})).photos ?? null;
}

/** Where the specifications came from: the local decoder (vPIC release, rule fixes) or NHTSA's live API. */
export function specificationsProvenance(decoded) {
  const src = decoded?.decode_source;
  if (src?.source === 'mcp_vin_vpic_local') {
    const fixes = src.rule_fixes_in_dataset ? `, with ${src.rule_fixes_in_dataset} reviewed mcp.vin fixes of NHTSA's rules (a value a fix changed is marked in decode_checks and listed in vpic_rule_fixes with NHTSA's official value)` : '';
    return `NHTSA vPIC manufacturer-submitted VIN data, decoded by mcp.vin's copy of NHTSA's vPIC decoder on NHTSA's vPIC database release ${src.vpic_release}${fixes}`;
  }
  if (src?.source === 'nhtsa_vpic_api') return 'NHTSA vPIC manufacturer-submitted VIN data, decoded by NHTSA\'s live vPIC API';
  return 'NHTSA vPIC manufacturer-submitted VIN data';
}

// ---- MCP output ----
// MCP clients put tool results straight into a model's context. A common car
// can have thousands of NHTSA complaints (2,013 for a 2003 Accord, about 1.8 MB
// of JSON), far past what clients accept, so the tools return complaint counts
// and the most recent complaints, and leave out the raw NHTSA fields. The REST
// API returns the 25 most recent by default (see restReport below).

const MCP_RECENT_COMPLAINTS = 10;
const MCP_SUMMARY_CHARS = 500;

function filedDate(c) {
  const [m, d, y] = String(c.date_complaint_filed || '').split('/');
  return y ? `${y}-${m}-${d}` : '';
}

function compactComplaints(complaints) {
  const list = complaints?.complaints || [];
  const byComponent = new Map();
  for (const c of list) {
    for (const part of String(c.component || 'UNKNOWN').split(',')) {
      const name = part.trim() || 'UNKNOWN';
      byComponent.set(name, (byComponent.get(name) || 0) + 1);
    }
  }
  const recent = [...list]
    .sort((a, b) => filedDate(b).localeCompare(filedDate(a)))
    .slice(0, MCP_RECENT_COMPLAINTS)
    .map(c => ({
      ...c,
      summary: c.summary && c.summary.length > MCP_SUMMARY_CHARS ? c.summary.slice(0, MCP_SUMMARY_CHARS) + '...' : c.summary,
    }));
  if (complaints?.pending) return { ...complaints, complaints: undefined, recent: [], top_components: [],
    note: 'NHTSA had not sent its owner-complaint list for this make, model and year in time (a common model\'s list can take 15 s or more), so the count is unknown here, not zero. The request keeps running; call decode_vin again in a minute for the list (cached once it arrives).' };
  return {
    ...complaints,
    complaints: undefined,
    count: complaints?.available === false ? null : list.length,
    summary: complaints?.summary,
    top_components: [...byComponent].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([component, count]) => ({ component, count })),
    recent,
    ...(list.length > recent.length && {
      note: `Showing the ${recent.length} most recent of ${list.length} complaints. The REST endpoint /api/vin/{vin}/complaints returns all of them.`,
    }),
  };
}

// ---- REST output ----
// The REST report keeps its shape, but a common car has thousands of complaints
// (about 1.5 MB of JSON), which scripts and AI agents rarely want. By default it
// carries the most recent ones and says so; ?complaints=all returns every one.
const REST_RECENT_COMPLAINTS = 25;

export function restReport(report, { allComplaints = false } = {}) {
  const list = report?.complaints?.complaints;
  if (allComplaints || !Array.isArray(list) || list.length <= REST_RECENT_COMPLAINTS) return report;
  const { top_components } = compactComplaints(report.complaints);
  const recent = [...list].sort((a, b) => filedDate(b).localeCompare(filedDate(a))).slice(0, REST_RECENT_COMPLAINTS);
  return { ...report, complaints: {
    ...report.complaints,
    complaints: recent,
    returned: recent.length,
    truncated: true,
    top_components,
    note: `Showing the ${recent.length} most recent of ${list.length} complaints. Add ?complaints=all for every complaint, or use /api/vin/${report.vin}/complaints.`,
  } };
}

export function mcpReport(report) {
  if (!report?.vehicle) return report;
  const { raw_nhtsa, ...rest } = report;
  return { ...rest, ...compactExtraBlocks(rest), complaints: compactComplaints(report.complaints), ...(rest.decode_checks ? { decode_checks: compactDecodeChecks(rest.decode_checks) } : {}) };
}

export async function compareVehicles(vins) {
  if (!Array.isArray(vins) || vins.length < 2 || vins.length > 4 || vins.some(v => typeof v !== 'string' || !validateVin(v).valid)) throw new InputError('Provide 2–4 valid VINs');
  const normalized=vins.map(normalizeVin);
  if (new Set(normalized).size !== normalized.length) throw new InputError('Choose distinct VINs');
  const results=await Promise.all(normalized.map(async vin=>{
    // A comparison waits for NHTSA's complaints (no pending status): it is printed and exported as one table.
    try {return {vin,report:mcpReport(await fullReport(vin,{complaintsWaitMs:Infinity}))};}
    catch {return {vin,error:'Report unavailable; retry later'};}
  }));
  return {results,note:'Recall and complaint counts are model-year data, not a ranking of individual vehicle safety. mcp.vin does not check any VIN\'s recall repairs; each report links to the manufacturer\'s and NHTSA\'s VIN recall pages. Missing data is not zero.'};
}


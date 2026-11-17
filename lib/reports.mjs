/** Shared vehicle reports for REST, MCP and comparisons. */
import { validateVin, normalizeVin } from './validate.mjs';
import { decodeVin as nhtsaDecode, getRecalls, getComplaints, getSafetyRatings, getRelatedModelRecalls } from './nhtsa.mjs';
import { getFuelEconomy } from './epa.mjs';
import { getPhotoUrls } from './photo.mjs';
import { vinCache, recallCache, ratingCache, fuelCache } from './cache.mjs';
import { vinRecallStatus } from './recall-status.mjs';
import { InputError } from './research.mjs';
import { withBuildDates } from './recall-build-dates.mjs';
import { extraReportBlocks, compactExtraBlocks } from './more-sources.mjs';
import { fuelForOtherBlocks } from './transmission-choice.mjs';
import { lookupTestVehicleData, vinProfile } from './tire-placards.mjs';
import { decodeChecksFor, checkedDecode, fixTestVehicleRow } from './decode-checks.mjs';
import { withManufacturerRecord, compactDecodeChecks } from './decode-report.mjs';

/**
 * NHTSA model-year campaigns for the exact decoded make/model/year (`count`, `recalls`), plus
 * campaigns filed under related NHTSA model names in `related_models`, kept separate. When related
 * names carry campaigns, or could not be checked, `count_note` says the exact count may understate.
 * Used by full reports, /api/vin/{vin}/recalls and the MCP lookup_recalls tool.
 */
export async function modelYearRecalls(make, model, year) {
  const cacheKey = `${make}|${model}|${year}`;
  const recalls = recallCache.has(cacheKey) ? recallCache.get(cacheKey)
    : await getRecalls(make, model, year).then(r => { if (r?.available !== false) recallCache.set(cacheKey, r); return r; });
  if (!recalls || recalls.available === false || !make || !model || !year) return recalls;
  const relatedKey = cacheKey + '|related';
  let related = recallCache.get(relatedKey);
  if (!related) {
    related = await getRelatedModelRecalls(make, model, year, recalls.recalls);
    if (related.available) recallCache.set(relatedKey, related);
  }
  return withBuildDates(withRelatedRecalls(recalls, related), make, model, year);
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
 * The report with the manufacturer's VIN recall status. The decode checks then run again with the manufacturer's
 * own description of the VIN when its reply carries one (lib/decode-report.mjs). `owner`: values the reader states
 * about their own vehicle ({transmission: 'manual'}), the top tier of the decode checks.
 */
export async function fullReport(vin, {owner = null} = {}) {
  const report = await fullReportBase(vin);
  if (!report.vehicle) return report;
  return withManufacturerRecord({...report, recall_status: await vinRecallStatus(report.vin, report.vehicle.make)}, {owner});
}

const pendingReports = new Map();
/** The report without manufacturer VIN recall lookups; shares the cache with fullReport. */
export function baseReport(vin) { return fullReportBase(vin); }
function fullReportBase(vin) {
  const key = normalizeVin(vin);
  if (pendingReports.has(key)) return pendingReports.get(key);
  const pending = assembleReport(key).finally(() => pendingReports.delete(key));
  pendingReports.set(key, pending);
  return pending;
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

  const [recalls, complaints, ratings, fuel, testVehicle] = await Promise.all([
    modelYearRecalls(make, model, year),
    getComplaints(make, model, year),
    ratingCache.has(cacheKey) ? ratingCache.get(cacheKey) : getSafetyRatings(make, model, year).then(r => { if (r) ratingCache.set(cacheKey, r); return r; }),
    fuelCache.has(fuelKey) ? fuelCache.get(fuelKey) : getFuelEconomy(year, make, model, used).then(r => { if (r?.available || (r?.match === 'multiple_configurations' && !r.incomplete)) fuelCache.set(fuelKey, r); return r; }),
    // Local index of NHTSA's crash-test vehicles: closest match, never this VIN's own values (lib/tire-placards.mjs).
    // Async only for the Transport Canada generation check when a nearest-model-year match is in play.
    lookupTestVehicleData(vinProfile(used), {fixRow: fixTestVehicleRow}),
  ]);
  const recallBlock = recalls;

  const photos = make && model && year ? getPhotoUrls(make, model, year) : null;

  const report = {
    valid: true, vin, validation,
    vehicle: decoded.vehicle, engine: decoded.engine, transmission: decoded.transmission,
    dimensions: decoded.dimensions, plant: decoded.plant, safety_equipment: decoded.safety,
    recalls: recallBlock || { count: 0, recalls: [] },
    complaints: complaints || { count: 0, complaints: [], summary: { crashes: 0, fires: 0, injuries: 0, deaths: 0 } },
    safety_ratings: ratings || { rated: false },
    fuel_economy: fuel || { available: false },
    tire_placard: testVehicle.tire_placard,
    test_vehicle_specs: testVehicle.test_vehicle_specs,
    photos, raw_nhtsa: decoded.raw,
    ...extraReportBlocks(used, fuelForOtherBlocks(fuel)), // the transmission assumption stays in fuel_economy
    decode_checks: decodeChecks || { available: false, reason: 'check_failed', note: 'The decode checks could not run; the official decode is shown unchecked.' },
    provenance: { assembled_at: new Date().toISOString(), specifications: 'NHTSA vPIC manufacturer-submitted VIN data', recalls: 'NHTSA make/model/year campaigns, not VIN repair status', complaints: 'NHTSA owner reports; not confirmed defects or incidence rates', fuel: 'FuelEconomy.gov configuration: exact, closest (with what differs) or the range across the configurations the VIN fits', decode_checks: 'Field-by-field checks on the official decode: the manufacturer\'s description of this VIN (when its recall lookup returns one), NHTSA lab records of test vehicles with the same VIN pattern, and EPA\'s configurations for the model year; vPIC\'s value is kept beside any correction', tire_placard: 'Door-placard values of a vehicle NHTSA tested in a crash or compliance test (closest match by model year and version, stated per vehicle), not this VIN', test_vehicle_specs: 'Capacities and weights (and an FMVSS 135 stopping distance when indexed) of a vehicle NHTSA tested in a crash or compliance test (closest match, stated per vehicle; a fuel tank from another year or version is a best guess), not this VIN', photos: 'Representative stock imagery, not this exact vehicle' },
  };

  const transientFuelFailure = ['upstream_error', 'invalid_response'].includes(fuel?.reason) || fuel?.incomplete === true;
  if (recalls?.available !== false && complaints?.available !== false && !transientFuelFailure) vinCache.set(vin, report);
  return report;
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
    try {return {vin,report:mcpReport(await fullReport(vin))};}
    catch {return {vin,error:'Report unavailable; retry later'};}
  }));
  return {results,note:'Recall and complaint counts are model-year data, not a ranking of individual vehicle safety. Missing data is not zero.'};
}


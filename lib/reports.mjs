/** Shared vehicle reports for REST, MCP and comparisons. */
import { validateVin, normalizeVin } from './validate.mjs';
import { decodeVin as nhtsaDecode, getRecalls, getComplaints, getSafetyRatings } from './nhtsa.mjs';
import { getFuelEconomy } from './epa.mjs';
import { getPhotoUrls } from './photo.mjs';
import { vinCache, recallCache, ratingCache, fuelCache } from './cache.mjs';
import { vinRecallStatus } from './recall-status.mjs';
import { InputError } from './research.mjs';

export async function fullReport(vin) {
  const report = await fullReportBase(vin);
  return report.vehicle ? {...report, recall_status:await vinRecallStatus(report.vin, report.vehicle.make)} : report;
}

const pendingReports = new Map();
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
  const fuelKey = `${cacheKey}|${JSON.stringify([decoded.engine, decoded.transmission])}`;

  const [recalls, complaints, ratings, fuel] = await Promise.all([
    recallCache.has(cacheKey) ? recallCache.get(cacheKey) : getRecalls(make, model, year).then(r => { if (r?.available !== false) recallCache.set(cacheKey, r); return r; }),
    getComplaints(make, model, year),
    ratingCache.has(cacheKey) ? ratingCache.get(cacheKey) : getSafetyRatings(make, model, year).then(r => { if (r) ratingCache.set(cacheKey, r); return r; }),
    fuelCache.has(fuelKey) ? fuelCache.get(fuelKey) : getFuelEconomy(year, make, model, decoded).then(r => { if (r?.available) fuelCache.set(fuelKey, r); return r; }),
  ]);

  const photos = make && model && year ? getPhotoUrls(make, model, year) : null;

  const report = {
    valid: true, vin, validation,
    vehicle: decoded.vehicle, engine: decoded.engine, transmission: decoded.transmission,
    dimensions: decoded.dimensions, plant: decoded.plant, safety_equipment: decoded.safety,
    recalls: recalls || { count: 0, recalls: [] },
    complaints: complaints || { count: 0, complaints: [], summary: { crashes: 0, fires: 0, injuries: 0, deaths: 0 } },
    safety_ratings: ratings || { rated: false },
    fuel_economy: fuel || { available: false },
    photos, raw_nhtsa: decoded.raw,
    provenance: { assembled_at: new Date().toISOString(), specifications: 'NHTSA vPIC manufacturer-submitted VIN data', recalls: 'NHTSA make/model/year campaigns, not VIN repair status', complaints: 'NHTSA owner reports; not confirmed defects or incidence rates', fuel: 'EPA matched configuration when unambiguous', photos: 'Representative stock imagery, not this exact vehicle' },
  };

  const transientFuelFailure = ['upstream_error', 'invalid_response'].includes(fuel?.reason);
  if (recalls?.available !== false && complaints?.available !== false && !transientFuelFailure) vinCache.set(vin, report);
  return report;
}

// ---- MCP output ----
// MCP clients put tool results straight into a model's context. A common car
// can have thousands of NHTSA complaints (2,013 for a 2003 Accord, about 1.8 MB
// of JSON), far past what clients accept, so the tools return complaint counts
// and the most recent complaints, and leave out the raw NHTSA fields. The REST
// API still returns everything.

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

export function mcpReport(report) {
  if (!report?.vehicle) return report;
  const { raw_nhtsa, ...rest } = report;
  return { ...rest, complaints: compactComplaints(report.complaints) };
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


/**
 * Manufacturer VIN recall lookups added 2026-11-16: Subaru, Volkswagen, Audi
 * and Land Rover. Each parser reads the JSON the manufacturer's own public
 * recall page reads. Parse data only. A reply that does not confirm the VIN
 * returns null (status stays unknown); a reply in an unexpected shape throws.
 *
 * What was seen in real replies on 2026-11-16 (dealer-stock VINs):
 *   Subaru      two vehicles with completed safety and emissions records
 *   Volkswagen  three recognized vehicles, each with no records
 *   Audi        two recognized vehicles, each with no records
 *   Land Rover  three recognized vehicles, each with no records
 * For Volkswagen, Audi and Land Rover the record fields and status codes come
 * from the code of their recall pages, not from a reply that carried records.
 */
import { isoDate, text, records, summary, baseRecord } from './manufacturer-recalls.mjs';

export const SUBARU_LOOKUP = 'https://www.subaru.com/recalls.html';
export const SUBARU_API = 'https://www.subaru.com/services/vehicles/recalls?vin=';
export const VW_LOOKUP = 'https://www.vw.com/en/owners-and-services/about-my-vehicle/recalls.html';
export const VW_API = 'https://prod.vwservicesfa.svc.vwusa.io/recall?language=en&countryCode=US&currency=USD&vin=';
export const AUDI_LOOKUP = 'https://www.audiusa.com/en/recalls/';
export const AUDI_API = 'https://omnigraph.audi.com/graphql';
export const LAND_ROVER_LOOKUP = 'https://www.landroverusa.com/ownership/vin-recall.html';
export const LAND_ROVER_API = 'https://www.landroverusa.com/content/misc/lrdx/vinrecall.lrdx.html?market=en_US&vin=';

const modelYear = v => Number.isInteger(v) && v >= 1981 && v <= 2100;
const nhtsaNumber = v => { const t = text(v); return t && /^\d{2}[VE]-?\d{3,6}$/i.test(t) ? t : null; };
const datePart = v => typeof v === 'string' ? isoDate(v.slice(0, 10)) : null;

// A lookup that returned no completed records has not shown that none exist.
function noCompletedMeansUnknown(result) {
  if (result.completed_count === 0) result.completed_count = null;
  return result;
}

// ---- Subaru ----

export function parseSubaru(body, vin) {
  if (!body || typeof body !== 'object' || body.vin !== vin) throw Error('Subaru VIN mismatch');
  // An unrecognized VIN comes back as modelYear 0 and modelName null with an empty list.
  if (!modelYear(body.modelYear) || !text(body.modelName)) return null;
  const safety = [], other = [];
  for (const r of records(body.recalls)) {
    if (!r || typeof r !== 'object') throw Error('Invalid Subaru record');
    const status = text(r.status);
    const state = status === 'Completed' ? 'completed' : status === 'Incomplete' ? 'open' : 'unknown';
    const type = text(r.type);
    const kind = type === 'Safety' ? 'safety_recall' : type === 'Emissions' ? 'emissions_recall' : 'manufacturer_recall';
    const raw = r.date?.rawDate;
    const row = {
      ...baseRecord(r.code, status || 'Unknown', state, kind),
      nhtsa_campaign_number: nhtsaNumber(r.nhtsaRecallNumber),
      source_type: type,
      recall_date: Number.isFinite(raw) ? isoDate(new Date(raw).toISOString().slice(0, 10)) : null,
      title: text(r.shortDescription), summary: text(r.description),
      remedy: text(r.remedyDescription), safety_risk: text(r.safetyRiskDescription),
    };
    (kind === 'safety_recall' ? safety : other).push(row);
  }
  return summary(safety, other,
    'Official Subaru U.S. VIN recall lookup: safety recalls with completed or incomplete status for this vehicle. Emissions recalls and service campaigns are listed separately. Recall date is not repair date. Reporting delays apply.',
    { market: 'United States', model: `${body.modelYear} ${text(body.modelName)}` });
}

// ---- Volkswagen ----

// Codes the Volkswagen page shows as "not a Volkswagen U.S. vehicle" messages.
const VW_NOT_THIS_VEHICLE = new Set([62, 64, 72, 74, 91]);

export function parseVw(body, vin) {
  if (!body || typeof body !== 'object' || body.vin !== vin) throw Error('Volkswagen VIN mismatch');
  if (body.status !== true) {
    if (body.status === false && VW_NOT_THIS_VEHICLE.has(body.errorCode)) return null;
    throw Error('Volkswagen lookup error');
  }
  if (!modelYear(body.year) || !text(body.model) || !Number.isInteger(body.numberOfRecalls)) throw Error('Volkswagen schema changed');
  const list = body.recalls === undefined && body.numberOfRecalls === 0 ? [] : records(body.recalls);
  if (list.length !== body.numberOfRecalls) throw Error('Volkswagen record count mismatch');
  const safety = [], other = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') throw Error('Invalid Volkswagen record');
    const [label, state] = r.mfrRecallStatus === 11 ? ['Repair needed', 'open']
      : r.mfrRecallStatus === 12 ? ['Repair not yet available', 'open']
      : r.mfrRecallStatus === 13 ? ['Recall complete', 'completed'] : ['Unknown', 'unknown'];
    const kind = r.vwgoaActionType === 'SAFETY' ? 'safety_recall' : 'manufacturer_recall';
    const row = {
      ...baseRecord(r.mfrRecallNumber, label, state, kind),
      nhtsa_campaign_number: nhtsaNumber(r.nhtsaRecallNumber), source_type: text(r.vwgoaActionType),
      remedy_available: r.mfrRecallStatus === 12 ? false : null,
      recall_date: datePart(r.recallDate), summary: text(r.recallDescription),
      remedy: text(r.remedyDescription), safety_risk: text(r.safetyRiskDescription),
    };
    (kind === 'safety_recall' ? safety : other).push(row);
  }
  return noCompletedMeansUnknown(summary(safety, other,
    'Official Volkswagen U.S. VIN recall lookup: recalls Volkswagen reports for this vehicle, with service campaigns listed separately. When no completed record is returned, completed repairs remain unknown. Recall date is not repair date. Reporting delays apply.',
    { market: 'United States', completed_history: false, model: `${body.year} ${text(body.model)}`, source_updated_at: text(body.refreshDate) }));
}

// ---- Audi ----

const AUDI_QUERY = 'query VehicleRecalls($input: VehicleRecallsInput!) { vehicleRecalls(input: $input) { brand model modelYear refreshDate recalls { manufacturerNotes manufacturerRecallNumber manufacturerRecallStatus recallNumber recallDate recallDescription refreshDate remedyDescription safetyRiskDescription actionTitle actionType repairCompletionStatus } } }';

// The same request the public Audi recall page sends, including its client name headers.
export function audiRequest(vin) {
  return {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'apollographql-client-name': 'fa-nar-vehicle-recall', 'apollographql-client-version': '4.5.4' },
    body: JSON.stringify({ operationName: 'VehicleRecalls', query: AUDI_QUERY, variables: { input: { vin, market: 'US', language: 'en' } } }),
  };
}

export function parseAudi(body) {
  if (!body || typeof body !== 'object') throw Error('Invalid Audi response');
  if (Array.isArray(body.errors) && body.errors.length) {
    // Same backend codes as Volkswagen, carried in the error text.
    const codes = body.errors.map(e => String(e?.extensions?.message || '').match(/error code: (\d+)\b/)?.[1]);
    if (codes.every(c => c && VW_NOT_THIS_VEHICLE.has(Number(c)))) return null;
    throw Error('Audi lookup error');
  }
  const v = body.data?.vehicleRecalls;
  if (!v || v.brand !== 'AUDI' || !modelYear(v.modelYear) || !text(v.model)) throw Error('Audi schema changed');
  const safety = [], other = [];
  for (const r of records(v.recalls)) {
    if (!r || typeof r !== 'object') throw Error('Invalid Audi record');
    const s = r.repairCompletionStatus;
    const [label, state] = s === 'COMPLETE' ? ['Recall complete', 'completed']
      : s === 'INCOMPLETE' ? ['Repair needed', 'open']
      : s === 'INCOMPLETE_NO_REMEDY' ? ['Repair not yet available', 'open'] : ['Unknown', 'unknown'];
    const kind = r.actionType === 'SAFETY' ? 'safety_recall' : r.actionType === 'ENVIRONMENTAL' ? 'emissions_recall' : 'manufacturer_recall';
    const row = {
      ...baseRecord(r.manufacturerRecallNumber, label, state, kind),
      nhtsa_campaign_number: nhtsaNumber(r.recallNumber), source_type: text(r.actionType),
      remedy_available: s === 'INCOMPLETE_NO_REMEDY' ? false : null,
      recall_date: datePart(r.recallDate), title: text(r.actionTitle), summary: text(r.recallDescription),
      remedy: text(r.remedyDescription), safety_risk: text(r.safetyRiskDescription),
    };
    (kind === 'safety_recall' ? safety : other).push(row);
  }
  return noCompletedMeansUnknown(summary(safety, other,
    'Official Audi U.S. VIN recall lookup: recalls Audi reports for this vehicle, with environmental and other campaigns listed separately. When no completed record is returned, completed repairs remain unknown. Recall date is not repair date. Reporting delays apply.',
    { market: 'United States', completed_history: false, model: `${v.modelYear} ${text(v.model)}`, source_updated_at: text(v.refreshDate) }));
}

// ---- Land Rover ----

export function parseLandRover(body, vin) {
  if (!body || typeof body !== 'object') throw Error('Invalid Land Rover response');
  let list;
  if (body.error === 204) {
    // "No recalls found for" this vehicle: the VIN and the vehicle name are echoed back.
    if (body.vin !== vin || !text(body.vehicle)) return null;
    list = [];
  } else {
    if (body.vehicleIdentificationNumber !== vin || !text(body.vehicleName)) throw Error('Land Rover VIN mismatch');
    list = records(body.recalls);
  }
  const rows = list.map(r => {
    if (!r || typeof r !== 'object') throw Error('Invalid Land Rover record');
    const c = r.mfrRecallStatus;
    const [label, state] = [-1, 0, 11].includes(c) ? ['Recall Incomplete', 'open']
      : c === 12 ? ['Recall Incomplete, remedy not yet available', 'open']
      : c === 14 ? ['Recall Completed', 'completed'] : ['Unknown', 'unknown'];
    return {
      ...baseRecord(r.mfrRecallNumber, label, state, 'safety_recall'),
      nhtsa_campaign_number: nhtsaNumber(r.nhtsaRecallNumber), remedy_available: c === 12 ? false : null,
      recall_date: datePart(r.recallDate), summary: text(r.recallDescription),
      remedy: text(r.remedyDescription), safety_risk: text(r.safetyRiskDescription),
    };
  });
  return noCompletedMeansUnknown(summary(rows, [],
    'Official Land Rover U.S. VIN recall search: recalls issued in the last 15 years for vehicles from model year 1995. When no completed record is returned, completed repairs remain unknown. Recall date is not repair date. Reporting delays apply.',
    { market: 'United States', completed_history: false, lookback_calendar_years: 15 }));
}

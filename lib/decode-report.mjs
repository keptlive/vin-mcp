/**
 * The decode checks in a report (lib/decode-checks.mjs). The report is assembled before the manufacturer's recall
 * lookup replies (the VIN page never waits for it), so the checks run twice:
 *   1. assembleReport (lib/reports.mjs): NHTSA test-vehicle pattern evidence and EPA cross-checks; the manufacturer
 *      record is "not_checked".
 *   2. fullReport: when the recall lookup reply carries the manufacturer's description of this VIN, the checks run
 *      again with it (it outranks the pattern evidence), and the fuel-economy, EPA test-car and test-vehicle tire
 *      blocks are matched again only if the values the matchers use changed. No extra request is made: the reply is
 *      the one the recall status already fetched (cached 15 minutes per VIN).
 * The original `vehicle`, `engine` and `transmission` blocks are never changed.
 */
import {decodeChecksFor, checkedDecode, matcherSignature, fixTestVehicleRow} from './decode-checks.mjs';
import {getFuelEconomy} from './epa.mjs';
import {lookupTestVehicleData, vinProfile} from './tire-placards.mjs';
import {extraReportBlocks} from './more-sources.mjs';
import {fuelForOtherBlocks} from './transmission-choice.mjs';

/**
 * The decode checks for MCP decode_vin: per field the status, official and checked values, why, and up to two NHTSA
 * report links; fields with no value anywhere are left out. REST returns the full block.
 */
export function compactDecodeChecks(dc) {
  if (!dc || !Array.isArray(dc.fields)) return dc;
  const fields = dc.fields.filter(f => f.status !== 'unknown').map(f => ({
    field: f.field, status: f.status, official: f.original ?? null,
    ...(f.shown_value !== f.original_value || ['corrected', 'filled'].includes(f.status) ? {checked: f.shown} : {}),
    basis: f.basis, ...(f.rule ? {rule: f.rule} : {}), ...(f.note ? {note: f.note} : {}),
    ...(f.status === 'doubtful' ? {candidates: (f.candidates || []).map(c => ({tier: c.tier, value: c.value_label}))} : {}),
    ...(f.matching ? {matching: f.matching} : {}),
    ...((f.evidence?.test_vehicles || []).length ? {test_reports: f.evidence.test_vehicles.slice(0, 2).map(t => t.report_url).filter(Boolean)} : {}),
  }));
  return {pattern: dc.pattern, summary: dc.summary, counts: dc.counts, fields,
    sources: {manufacturer_record: dc.sources?.manufacturer_record?.status ?? null, test_vehicles: dc.sources?.test_vehicle_pattern?.vehicles ?? 0, epa: dc.sources?.epa?.status ?? null},
    precedence: dc.precedence, ...(dc.rematched ? {rematched: true} : {}), note: dc.note};
}

/** The decode as lib/nhtsa.mjs returned it, rebuilt from a report. */
export function decodedFromReport(report) {
  return {vehicle: report.vehicle, engine: report.engine, transmission: report.transmission, dimensions: report.dimensions,
    plant: report.plant, safety: report.safety_equipment, raw: report.raw_nhtsa || {}};
}

/** What the manufacturer record status is, from a recall-status result. */
export function manufacturerRecordOf(recallStatus) {
  if (!recallStatus) return null;
  if (recallStatus.manufacturer_description) return recallStatus.manufacturer_description;
  if (recallStatus.reason === 'manufacturer_not_supported') return {available: false, reason: 'manufacturer_not_supported'};
  if (recallStatus.available === false) return {available: false, reason: recallStatus.reason || 'lookup_unavailable'};
  return {available: false, reason: 'not_supplied_by_manufacturer'};
}

/**
 * Re-run the checks with the manufacturer's record (and owner-stated values, when the caller has them) and
 * re-match what depends on the checked values. Never throws: on failure the report is returned unchanged.
 */
export async function withManufacturerRecord(report, {owner = null} = {}) {
  if (!report?.vehicle || !report.decode_checks) return report;
  try {
    const manufacturer = manufacturerRecordOf(report.recall_status);
    const decoded = decodedFromReport(report);
    const checks = decodeChecksFor(report.vin, decoded, {manufacturer, owner});
    if (!checks) return report;
    const was = matcherSignature(checkedDecode(decoded, report.decode_checks));
    const used = checkedDecode(decoded, checks);
    if (matcherSignature(used) === was) return {...report, decode_checks: checks};
    const {year, make, model} = decoded.vehicle;
    const [fuel, testVehicle] = await Promise.all([
      getFuelEconomy(year, make, model, used),
      lookupTestVehicleData(vinProfile(used), {fixRow: fixTestVehicleRow}),
    ]);
    return {...report, decode_checks: {...checks, rematched: true},
      fuel_economy: fuel || {available: false}, tire_placard: testVehicle.tire_placard, test_vehicle_specs: testVehicle.test_vehicle_specs,
      ...extraReportBlocks(used, fuelForOtherBlocks(fuel))};
  } catch (err) {
    console.error('[decode-report] manufacturer re-check failed:', err.message);
    return report;
  }
}

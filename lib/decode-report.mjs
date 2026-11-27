/**
 * The decode checks in a report (lib/decode-checks.mjs), as MCP clients get them, and the decode rebuilt from a report.
 * The checks run once, when the report is assembled (lib/reports.mjs); no manufacturer record is read.
 *
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
    ...(f.evidence?.rule_fix ? {rule_fixes: (f.evidence.rule_fix.fixes || []).map(x => x.id),
      fix_reports: (f.evidence.rule_fix.fixes || []).flatMap(x => (x.evidence || []).map(e => e.url)).filter(Boolean).slice(0, 2)} : {}),
  }));
  return {pattern: dc.pattern, summary: dc.summary, counts: dc.counts, fields,
    sources: {rule_fixes: dc.sources?.rule_fixes?.status ?? null,
      test_vehicles: dc.sources?.test_vehicle_pattern?.vehicles ?? 0, epa: dc.sources?.epa?.status ?? null},
    precedence: dc.precedence, note: dc.note};
}

/**
 * The decode as lib/nhtsa.mjs returned it, rebuilt from a report: raw_nhtsa is NHTSA's official decode, so the values
 * an mcp.vin rule fix changed (vpic_rule_fixes) are put back, and the fixes stay listed for the checks.
 */
export function decodedFromReport(report) {
  const raw = {...(report.raw_nhtsa || {})};
  for (const c of report.vpic_rule_fixes?.changed || []) if (c && typeof c.field === 'string') raw[c.field] = c.value ?? '';
  return {vehicle: report.vehicle, engine: report.engine, transmission: report.transmission, dimensions: report.dimensions,
    plant: report.plant, safety: report.safety_equipment, raw, decode_source: report.decode_source ?? null,
    ...(report.vpic_rule_fixes ? {vpic_rule_fixes: report.vpic_rule_fixes} : {})};
}

#!/usr/bin/env node
// Known answers for a freshly built NHTSA-derived data file, asked through the site's own lookup code (lib/*.mjs),
// so a file the deployed code cannot read, or one that lost well-known rows, never replaces the live copy.
// Used by scripts/nhtsa_datasets.py gate (on the build server and again on the web server before a swap).
//
//   node scripts/nhtsa-known-answers.mjs DATASET FILE      DATASET: see CHECKS below; prints JSON, exit 0 = all pass
//
// The answers are long-settled facts (old model years, closed investigations) so a correct refresh never changes
// them; counts are floors well below today's values (taken 2026-11-27), because these files only grow.
import {localRecallRows, localComplaintRows, localSafetyRatings, closeNhtsaLocal} from '../lib/nhtsa-local.mjs';
import {lookupRecallLabels} from '../lib/recall-labels.mjs';
import {investigations} from '../lib/investigations.mjs';
import {communications} from '../lib/communications.mjs';
import {decodeLocal, closeVpicLocal} from '../lib/vpic-local.mjs';

const campaigns = r => new Set((r?.results || []).map(x => x.NHTSACampaignNumber));
const vpicValue = (d, name) => d?.values?.[name] ?? d?.Results?.[0]?.[name] ?? null;

export const CHECKS = {
  'nhtsa-recalls': file => {
    const accord = localRecallRows('HONDA', 'ACCORD', 2003, {file});
    const cobalt = localRecallRows('CHEVROLET', 'COBALT', 2005, {file});
    return [
      ['2003 Honda Accord has 20+ recalls, incl. 15V320000 (Takata inflator)', accord.results?.length >= 20 && campaigns(accord).has('15V320000'), accord.results?.length ?? accord],
      ['2005 Chevrolet Cobalt includes 14V047000 (ignition switch)', campaigns(cobalt).has('14V047000'), cobalt.results?.length ?? cobalt],
      ['recall rows carry the live API fields', ['Component', 'Summary', 'Remedy', 'ReportReceivedDate', 'Manufacturer'].every(k => accord.results?.[0]?.[k]), Object.keys(accord.results?.[0] || {})],
    ];
  },
  'nhtsa-complaints': file => {
    const r = localComplaintRows('HONDA', 'ACCORD', 2003, {file});
    const first = r.results?.[0] || {};
    return [
      ['2003 Honda Accord has at least 1,800 complaints', r.results?.length >= 1800, r.results?.length ?? r],
      ['complaint rows carry the live API fields', ['odiNumber', 'dateComplaintFiled', 'components', 'summary'].every(k => first[k] !== undefined), Object.keys(first)],
    ];
  },
  'nhtsa-ratings': file => {
    const r = localSafetyRatings('TOYOTA', 'CAMRY', 2020, {file});
    const overall = (r.variants || []).map(v => v.ratings?.OverallRating ?? v.OverallRating ?? v.detail?.OverallRating);
    return [
      ['2020 Toyota Camry has rated variants with a 5-star overall rating', overall.includes('5'), overall],
    ];
  },
  'recall-labels': file => {
    const r = lookupRecallLabels({makes: ['TOYOTA'], year: 2012, names: ['CAMRY']}, file);
    const camry = (r.labels || []).find(l => l.model === 'CAMRY');
    return [
      ['TOYOTA 2012 labels include CAMRY with 2+ campaigns', r.available === true && camry?.campaigns >= 2, camry || r],
      ['CAMRY is a used name', r.used_names?.has?.('CAMRY') === true, r.used_names ? [...r.used_names] : null],
    ];
  },
  'investigations': file => {
    const r = investigations({make: 'DODGE', model: 'DURANGO', year: 2011}, {file});
    const total = investigations({make: 'CHEVROLET', model: 'IMPALA', year: 2008}, {file});
    return [
      ['2011 Dodge Durango includes EA14001', r.available === true && (r.data || []).some(d => d.id === 'EA14001'), (r.data || []).map(d => d.id)],
      ['2008 Chevrolet Impala includes DP14001', (total.data || []).some(d => d.id === 'DP14001'), (total.data || []).map(d => d.id)],
    ];
  },
  'communications': file => {
    const r = communications({make: 'FORD', model: 'F-150', year: 2015}, {file});
    return [
      ['2015 Ford F-150 has at least 200 manufacturer communications', r.available === true && r.total >= 200, r.total ?? r],
      ['communication rows carry their fields', ['id', 'bulletin', 'received', 'summary', 'components'].every(k => r.data?.[0]?.[k] !== undefined), Object.keys(r.data?.[0] || {})],
    ];
  },
  'vpic': file => {
    const d = decodeLocal('1HGCM82633A004352', {file});
    return [
      ['1HGCM82633A004352 decodes to a 2003 Honda Accord', String(vpicValue(d, 'Make')).toUpperCase() === 'HONDA' && /ACCORD/i.test(String(vpicValue(d, 'Model'))) && String(vpicValue(d, 'ModelYear')) === '2003',
        {Make: vpicValue(d, 'Make'), Model: vpicValue(d, 'Model'), ModelYear: vpicValue(d, 'ModelYear'), reason: d?.reason, error: d?.error}],
    ];
  },
};

export function runChecks(dataset, file) {
  const fn = CHECKS[dataset];
  if (!fn) return {dataset, ok: false, checks: [], error: `unknown dataset ${dataset}`};
  let checks;
  try {
    checks = fn(file).map(([name, ok, got]) => ({name, ok: Boolean(ok), ...(ok ? {} : {got})}));
  } catch (err) {
    return {dataset, ok: false, checks: [], error: err.message};
  } finally {
    closeNhtsaLocal();
    closeVpicLocal();
  }
  return {dataset, ok: checks.length > 0 && checks.every(c => c.ok), checks};
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dataset, file] = process.argv.slice(2);
  if (!dataset || !file) { console.error('usage: nhtsa-known-answers.mjs DATASET FILE'); process.exit(2); }
  const r = runChecks(dataset, file);
  console.log(JSON.stringify(r, (k, v) => (typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '...' : v)));
  process.exit(r.ok ? 0 : 1);
}

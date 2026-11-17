/**
 * NHTSA Part 583 (American Automobile Labeling Act) reports: per carline and model year, the share of
 * US/Canadian parts content, the other major source countries, final assembly countries and the
 * countries of origin of the engine and transmission, as manufacturers report them.
 * Built by scripts/import-aala.py into data/aala.db (model years 2020-2027).
 *
 * Lookup: same model year and make, then the carline name (drive and body words aside), then narrowed by
 * the decoded plant country and drive when some rows fit. Every remaining row is returned, labelled.
 * Country codes are decoded only with the legend printed in the same year's file.
 */
import Database from 'better-sqlite3';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const AALA_FILE = fileURLToPath(new URL('../data/aala.db', import.meta.url));
export const AALA_NOTE = 'Figures for the whole carline as the manufacturer reported them to NHTSA for the model year (49 CFR Part 583, the parts-content label on new cars), not for this car. US/Canadian content is the share of the value of the parts.';

export const compact = v => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const DRIVE_WORDS = {AWD: 'all', '4WD': 'all', '4X4': 'all', '4MOTION': 'all', QUATTRO: 'all', XDRIVE: 'all', '4MATIC': 'all', FWD: 'front', RWD: 'rear', '2WD': 'two', '4X2': 'two'};
// Drive, body and hybrid words do not name the carline; drive and hybrid narrow the rows afterwards.
const NOISE = new Set([...Object.keys(DRIVE_WORDS), 'SEDAN', 'COUPE', 'HATCHBACK', 'WAGON', 'SUV', 'VAN', 'PICKUP', 'CONVERTIBLE', 'NEW', 'HYBRID', 'HEV', 'PHEV']);
const HYBRID = /\b(HYBRID|HEV|PHEV|PLUG-IN|E-HYBRID)\b/i;
const words = v => String(v ?? '').toUpperCase().replace(/[()/,]/g, ' ').split(/\s+/).map(compact).filter(Boolean);

/** 3 = same name apart from drive/body words, 2 = the model name starts the carline (or the reverse), 0 = no. */
export function carlineTier(model, carline) {
  const want = words(model).filter(w => !NOISE.has(w)), have = words(carline), core = have.filter(w => !NOISE.has(w));
  if (!want.length || !core.length) return 0;
  if (want.join(' ') === core.join(' ')) return 3;
  if (want.every((w, i) => have[i] === w) || core.every((w, i) => want[i] === w)) return 2;
  return 0;
}

const drive = d => /4wd|4-wheel|4x4|awd|all-wheel/i.test(d || '') ? 'all' : /fwd|front/i.test(d || '') ? 'front' : /rwd|rear/i.test(d || '') ? 'rear' : null;
const carlineDrive = c => { for (const w of words(c)) if (DRIVE_WORDS[w]) return DRIVE_WORDS[w]; return null; };
const driveFits = (row, want) => { const d = carlineDrive(row.carline); return !d || d === want || (d === 'two' && want !== 'all'); };

// vPIC prints "UNITED STATES (USA)", "KOREA (SOUTH)", "UNITED KINGDOM (UK)"; the reports print codes or names.
const COUNTRY_ALIASES = {UNITEDSTATES: ['US', 'USA', 'UNITEDSTATES'], CANADA: ['CANADA', 'CAN'], UNITEDKINGDOM: ['UK', 'GREATBRITAIN', 'UNITEDKINGDOM'], KOREA: ['KOREA', 'KR'], MEXICO: ['MEXICO', 'MX'], JAPAN: ['JAPAN', 'JP'], GERMANY: ['GERMANY'], SPAIN: ['SPAIN', 'ESP']};
function countryKeys(vpicCountry) {
  const base = compact(String(vpicCountry || '').replace(/\(.*\)/, ''));
  return base ? new Set(COUNTRY_ALIASES[base] || [base]) : null;
}

/** "G (3.3), A (3.4)" -> "Germany (3.3), A (3.4)": legend codes become names, anything else stays as printed. */
export function decode(text, legend) {
  if (!text) return null;
  return String(text).replace(/\b[A-Z]{1,3}\b/g, code => legend[code] || code);
}
const countriesIn = (text, legend) => new Set(String(text || '').split(/[\s,;/()]+/).filter(Boolean).flatMap(t => [compact(t), compact(legend[t] || '')]).filter(Boolean));

/**
 * Parts content and origin for a report ({vehicle, transmission, engine, plant}).
 * {available:false, reason} when the index is missing, the model year is not covered or nothing matches.
 */
export function lookupAala(report, file = AALA_FILE) {
  const v = report?.vehicle || {};
  if (!v.year || !v.make || !v.model) return {available: false, reason: 'missing_vehicle'};
  if (!existsSync(file)) return {available: false, reason: 'dataset_not_indexed'};
  let db;
  try {
    db = new Database(file, {readonly: true, fileMustExist: true});
    const meta = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='source'").get().value);
    const year = Number(v.year);
    const src = (meta.sources || []).find(s => s.model_year === year);
    if (!src) return {available: false, reason: 'model_year_not_covered', model_years_covered: (meta.sources || []).map(s => s.model_year)};
    const legend = Object.fromEntries(db.prepare('SELECT code, country FROM legends WHERE model_year=?').all(year).map(r => [r.code, r.country]));
    const all = db.prepare('SELECT * FROM aala WHERE model_year=? AND make_compact=?').all(year, compact(v.make));
    let list = all.map(r => [r, carlineTier(v.model, r.carline)]).filter(([, t]) => t > 0);
    if (!list.length) return {available: false, reason: 'carline_not_listed', model_year: year};
    const best = Math.max(...list.map(([, t]) => t));
    let rows = list.filter(([, t]) => t === best).map(([r]) => r);
    const basis = [];
    if (best < 3) {
      // "Outlander" is not "Outlander Sport": prefer carlines whose extra words are the VIN's trim or series words.
      const own = new Set([...words(v.trim), ...words(v.series), ...NOISE, 'HYBRID', 'HEV', 'PHEV']);
      const extra = r => words(r.carline).filter(w => !words(v.model).includes(w));
      const fit = rows.filter(r => extra(r).every(w => own.has(w) || /^\d(\.\d)?L?$/.test(w)));
      if (fit.length && fit.length < rows.length) { rows = fit; basis.push(`carline words match the VIN's trim or series (${[v.trim, v.series].filter(Boolean).join(', ')})`); }
    }
    // Soft narrowing: applied only when some rows fit, and said aloud either way.
    const narrow = (keep, yes, no) => { const fit = rows.filter(keep); if (fit.length && fit.length < rows.length) { rows = fit; basis.push(yes); } else if (!fit.length) basis.push(no); };
    const hybrid = /hybrid|hev|phev/i.test(report.engine?.ev_type || '') && !/BEV/i.test(report.engine?.ev_type || '');
    if (rows.some(r => HYBRID.test(r.carline))) narrow(r => HYBRID.test(r.carline) === hybrid, hybrid ? 'hybrid carline' : 'non-hybrid carline', 'hybrid or not: no listed carline fits');
    const wantDrive = drive(report.transmission?.drive_type);
    if (wantDrive) narrow(r => driveFits(r, wantDrive), wantDrive === 'all' ? 'four/all-wheel drive' : `${wantDrive}-wheel drive`, 'drive: no listed carline fits');
    const plant = countryKeys(report.plant?.country);
    if (plant) narrow(r => [...countriesIn(r.final_assembly, legend)].some(k => plant.has(k)), `final assembly in the VIN's plant country (${report.plant.country})`, `the VIN's plant country (${report.plant.country}) is not among the listed final assembly countries`);
    basis.unshift(best === 3 ? 'same model year, make and carline name' : `same model year and make; no carline named ${v.model}, closest listed names: ${[...new Set(rows.map(r => r.carline))].slice(0, 6).join(', ')}`);
    // Identical printed rows (variants the report lists separately with the same figures) are shown once.
    const seen = new Map();
    for (const r of rows) {
      const key = JSON.stringify([r.carline, r.us_canada_pct, r.foreign_sources, r.final_assembly, r.final_assembly_additional, r.engine, r.engine_additional, r.transmission, r.transmission_additional, r.notes]);
      if (seen.has(key)) seen.get(key).listed_times++;
      else seen.set(key, {r, listed_times: 1});
    }
    const origin = (printed, add) => printed || add ? {printed: [printed, add].filter(Boolean).join('; '), countries: decode([printed, add].filter(Boolean).join('; '), legend)} : null;
    const out = [...seen.values()].map(({r, listed_times}) => {
      const flags = JSON.parse(r.flags || '[]');
      const unreadable = flags.filter(f => f.startsWith('unreadable_')).map(f => f.slice(11)).filter(f => !['manufacturer', 'make'].includes(f));
      return {
        make: r.make, carline: r.carline, vehicle_type: r.vehicle_type, us_canada_parts_pct: r.us_canada_pct,
        other_major_sources: JSON.parse(r.foreign_sources).map(f => ({pct: f.pct, printed: f.code, country: legend[f.code] || null})),
        final_assembly: origin(r.final_assembly, r.final_assembly_additional),
        engine_origin: origin(r.engine, r.engine_additional),
        transmission_origin: origin(r.transmission, r.transmission_additional),
        ...(r.notes ? {notes: r.notes} : {}),
        ...(unreadable.length ? {unreadable: unreadable.map(c => ({final: 'final_assembly', final_add: 'final_assembly', engine: 'engine_origin', engine_add: 'engine_origin', trans: 'transmission_origin', trans_add: 'transmission_origin'})[c] || c).filter((c, i, a) => a.indexOf(c) === i)} : {}),
        listed_times, page: r.page,
      };
    });
    return {
      available: true, vin_specific: false, model_year: year, match: best === 3 ? 'carline' : 'closest_carline', match_basis: basis,
      rows: out,
      ...(out.length > 1 ? {rows_note: `${out.length} listed versions fit; the report does not say which applies to this car.`} : {}),
      source: {provider: 'NHTSA Part 583 (AALA) report', file: src.file, url: src.url, indexed_at: meta.indexed_at ?? null},
      note: AALA_NOTE + ' Country codes are decoded with the country list printed in the same file; codes it does not list are shown as printed.' +
        (out.some(r => r.unreadable) ? ' "unreadable" marks columns whose printed cells could not be placed reliably; they are left out, not guessed.' : '') +
        (best < 3 ? ' Closest carline name: matched by ' + basis.join('; ') + '.' : ''),
    };
  } catch (err) {
    console.error('[aala] lookup error:', err.message);
    return {available: false, reason: 'index_unreadable'};
  } finally {
    db?.close();
  }
}

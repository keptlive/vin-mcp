/**
 * NHTSA final theft rates (49 CFR Part 541) with each vehicle line's production, from the "Final Theft
 * Data" notices in the Federal Register. Built by scripts/import-theft-rates.py into data/theft-rates.db.
 * Model years 1998-2010 and 2012 (the MY2011, 2013 and 2014 notices print no table).
 *
 * Lookup: same model year; the line must carry the vehicle's make (as a prefix such as "LEXUS ES", or
 * through the reporting manufacturer such as HONDA for "ACCORD"); then the line name. Every alias step
 * (a body word dropped, one name of a slash pair, a BMW series, a Mercedes class) is listed in match_basis.
 * These are figures for the whole vehicle line and model year, never for this car.
 */
import Database from 'better-sqlite3';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const THEFT_RATES_FILE = fileURLToPath(new URL('../data/theft-rates.db', import.meta.url));
export const THEFT_NOTE = 'Historical figures for the whole vehicle line and model year, not for this car: thefts of that model year reported to the FBI\'s National Crime Information Center during the same calendar year, divided by the line\'s production for the model year as reported to the EPA (NHTSA final theft data, 49 CFR Part 541).';

export const compact = v => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const words = v => String(v ?? '').toUpperCase().replace(/[()]/g, ' ').split(/[\s]+/).map(compact).filter(Boolean);
// Marque words that open a line name; a line opening with another marque belongs to that marque.
const MARQUES = new Set(['ACURA', 'LEXUS', 'INFINITI', 'SCION', 'LINCOLN', 'MERCURY', 'FORD', 'BUICK', 'CADILLAC', 'CHEVROLET', 'GMC', 'PONTIAC',
  'OLDSMOBILE', 'SATURN', 'HUMMER', 'DODGE', 'JEEP', 'CHRYSLER', 'PLYMOUTH', 'RAM', 'MINI', 'SMART', 'MAYBACH', 'SAAB', 'EAGLE', 'GEO', 'ISUZU']);
// Words that name the body or the drive, not the line: dropped from both sides, disclosed.
const BODY = new Set(['PICKUP', 'VAN', 'WAGON', 'CONVERTIBLE', 'COUPE', 'SEDAN', 'HATCHBACK', '2WD', '4WD', 'AWD', 'FWD', 'RWD', '4X2', '4X4']);
const MANUFACTURER_MAKES = {GENERALMOTORS: ['CHEVROLET', 'GMC', 'BUICK', 'CADILLAC', 'PONTIAC', 'OLDSMOBILE', 'SATURN', 'HUMMER'],
  FORDMOTOR: ['FORD', 'LINCOLN', 'MERCURY'], CHRYSLER: ['CHRYSLER', 'DODGE', 'JEEP', 'RAM', 'PLYMOUTH'], DAIMLERCHRYSLER: ['CHRYSLER', 'DODGE', 'JEEP', 'MERCEDESBENZ', 'SMART'],
  TOYOTA: ['TOYOTA', 'LEXUS', 'SCION'], HONDA: ['HONDA', 'ACURA'], NISSAN: ['NISSAN', 'INFINITI'], BMW: ['BMW', 'MINI'], FUJIHEAVY: ['SUBARU'],
  MERCEDESBENZ: ['MERCEDESBENZ', 'SMART', 'MAYBACH'], VOLKSWAGEN: ['VOLKSWAGEN', 'AUDI'], HYUNDAI: ['HYUNDAI'], KIA: ['KIA']};

/** The line name without the make prefix, or null when the row is another make's line. */
function lineForMake(row, make) {
  const m = compact(make), w = words(row.line);
  if (!w.length) return null;
  // "MERCEDES-BENZ" prints as one word; "ALFA ROMEO" or "LAND ROVER" as two.
  for (let n = 1; n <= Math.min(3, w.length - 1); n++) if (w.slice(0, n).join('') === m) return row.line.toUpperCase().replace(/[()]/g, ' ').split(/\s+/).filter(Boolean).slice(n).join(' ');
  if (MARQUES.has(w[0]) && w[0] !== m) return null;
  const mfr = row.manufacturer_compact || '';
  const own = mfr.includes(m) || Object.entries(MANUFACTURER_MAKES).some(([g, makes]) => mfr.includes(g) && makes.includes(m));
  return own ? row.line : null;
}

/** Names the vehicle's model may go by in the theft report, with the alias said aloud. */
function modelNames(make, model) {
  const m = compact(make), name = String(model || '').toUpperCase();
  const out = [{w: words(name), how: null}];
  const series = name.match(/^([1-8])(\d\d[A-Z]*|[-\s]?SERIES)\b/);
  if (m === 'BMW' && series) out.push({w: [series[1]], how: `BMW ${model} counted in NHTSA's line "${series[1]}" (${series[1]} Series)`});
  const cls = name.match(/^([A-Z]{1,3})[-\s]?(\d{2,3}[A-Z]*|CLASS)\b/);
  if (m === 'MERCEDESBENZ' && cls) out.push({w: [cls[1] + 'CLASS'], how: `Mercedes-Benz ${model} counted in the ${cls[1]}-Class line`});
  return out;
}

/** 4 = same name, 3 = same after an alias step (disclosed), 2 = one name starts the other (disclosed), 0 = no match. */
function tier(names, line) {
  let best = {tier: 0, how: null};
  const better = (t, how) => { if (t > best.tier) best = {tier: t, how}; };
  const raw = String(line || '').toUpperCase();
  // "203 (C-CLASS)": the parenthesis holds the class name.
  const alternatives = raw.replace(/\(([^)]*)\)/g, '/$1').split('/').map(a => a.trim().split(/\s+/).filter(Boolean)).filter(a => a.length);
  const slash = alternatives.length > 1;
  for (const {w: want, how} of names) {
    if (!want.length) continue;
    const core = want.filter(x => !BODY.has(x));
    for (const tokens of alternatives) {
      const alt = tokens.map(compact).filter(Boolean);
      // "ACURA 3.2 TL": an engine size inside the line name is not part of the name.
      const altCore = tokens.filter(x => !/^\d\.\d+L?$/.test(x)).map(compact).filter(x => x && !BODY.has(x));
      const say = steps => [how, ...steps].filter(Boolean).join('; ') || null;
      if (!slash && alt.join('') === want.join('')) better(how ? 3 : 4, say([]));
      else if (altCore.join('') === core.join('') && core.length) better(3, say([slash ? `NHTSA's line ${raw} covers more than one name` : null, alt.join(' ') !== altCore.join(' ') || want.join(' ') !== core.join(' ') ? `line ${raw} matched without body, drive or engine-size words` : null]));
      else if (core.length && altCore.length && (core.every((x, i) => altCore[i] === x) || altCore.every((x, i) => core[i] === x))) better(2, say([`closest line name: ${raw}`]));
    }
  }
  return best;
}

/**
 * Production and theft figures for a report's vehicle line ({vehicle}).
 * {available:false, reason} when the index is missing, the model year has no table, or no line matches.
 */
export function lookupTheftRates(report, file = THEFT_RATES_FILE) {
  const v = report?.vehicle || {};
  if (!v.year || !v.make || !v.model) return {available: false, reason: 'missing_vehicle'};
  if (!existsSync(file)) return {available: false, reason: 'dataset_not_indexed'};
  let db;
  try {
    db = new Database(file, {readonly: true, fileMustExist: true});
    const meta = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='source'").get().value);
    const year = Number(v.year);
    if (!(meta.model_years || []).includes(year)) return {available: false, reason: 'model_year_not_published', model_years_covered: meta.model_years};
    const names = modelNames(v.make, v.model);
    const scored = db.prepare('SELECT * FROM theft_rates WHERE model_year=?').all(year)
      .map(r => ({r, line: lineForMake(r, v.make)})).filter(x => x.line !== null)
      .map(x => ({...x, ...tier(names, x.line)})).filter(x => x.tier > 0);
    if (!scored.length) return {available: false, reason: 'line_not_in_theft_report', model_year: year, note: 'NHTSA\'s final theft report for this model year has no line matching this make and model.'};
    const best = Math.max(...scored.map(x => x.tier));
    const rows = scored.filter(x => x.tier === best);
    const first = rows[0].r;
    const basis = ['same model year and make', ...new Set(rows.map(x => x.how).filter(Boolean))];
    return {
      available: true, vin_specific: false, model_year: year, calendar_year: first.calendar_year,
      match: best === 4 ? 'line_name' : 'closest_line_name', match_basis: basis,
      lines: rows.map(({r}) => ({
        manufacturer: r.manufacturer, line: r.line, production: r.production, thefts: r.thefts, thefts_per_1000_produced: r.rate,
        rank: r.rank, lines_ranked: r.lines_in_table,
        ...(r.rate_check !== 'ok' ? {rate_check: 'printed_rate_differs', rate_note: 'The printed rate does not equal thefts / production x 1,000; shown as printed.'} : {}),
      })),
      all_lines: meta.printed_totals?.[String(year)] ?? null,
      source: {provider: 'NHTSA final theft data (Federal Register)', document_number: first.document_number, publication_date: first.publication_date, url: first.source_url},
      note: THEFT_NOTE + ' Rank 1 is the highest theft rate.' + (best < 4 ? ' Closest line name: matched by ' + basis.join('; ') + '.' : ''),
    };
  } catch (err) {
    console.error('[theft-rates] lookup error:', err.message);
    return {available: false, reason: 'index_unreadable'};
  } finally {
    db?.close();
  }
}

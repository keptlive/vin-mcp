/**
 * EPA Test Car List: the vehicles manufacturers tested for fuel economy certification
 * (rated horsepower, transmission, drive, axle ratio, test weight, test group).
 * Built by scripts/import-epa-test-cars.py into data/epa-test-cars.db.
 *
 * Match order:
 *  1. the EPA test group (efid) of the FuelEconomy.gov configuration the report matched;
 *  2. otherwise the closest test configuration: same model year, make, model name, engine size,
 *     then transmission and drive where the VIN decode gives them. Always labelled as closest.
 * These are the manufacturer's test vehicles for the engine family, not this car.
 */
import Database from 'better-sqlite3';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const EPA_TEST_CARS_FILE = fileURLToPath(new URL('../data/epa-test-cars.db', import.meta.url));
export const EPA_TEST_NOTE = 'The manufacturer\'s EPA certification test vehicles for this engine family (EPA Test Car List), not necessarily this car\'s configuration.';

export const compact = v => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// Before 2010 the list names the manufacturer, not the make.
const GROUPS = {
  GENERALMOTORS: ['CHEVROLET', 'GMC', 'BUICK', 'CADILLAC', 'PONTIAC', 'OLDSMOBILE', 'SATURN', 'HUMMER'],
  FORDMOTOR: ['FORD', 'LINCOLN', 'MERCURY'], CHRYSLER: ['CHRYSLER', 'DODGE', 'JEEP', 'PLYMOUTH', 'RAM'],
  TOYOTA: ['TOYOTA', 'LEXUS', 'SCION'], HONDA: ['HONDA', 'ACURA'], NISSAN: ['NISSAN', 'INFINITI'],
  FUJIHEAVY: ['SUBARU'], MERCEDESBENZ: ['MERCEDESBENZ', 'SMART', 'MAYBACH'], BMW: ['BMW', 'MINI'],
  NEWUNITEDMOTOR: ['TOYOTA', 'PONTIAC', 'CHEVROLET'],
};
const NOISE = new Set(['2WD', '4WD', 'AWD', 'FWD', 'RWD', '4X2', '4X4', '2X4', 'PICKUP', 'FFV']);

function makeMatches(row, make) {
  const m = compact(make);
  if (row.make_compact) return row.make_compact === m;
  const mfr = row.manufacturer_compact || '';
  return mfr.includes(m) || Object.entries(GROUPS).some(([g, makes]) => mfr.includes(g) && makes.includes(m));
}

/** 3 = same name apart from drive/body words, 2 = the model name starts the carline, 1 = contained, 0 = no. */
export function carlineTier(model, carline) {
  const want = String(model || '').toUpperCase().split(/\s+/).map(compact).filter(Boolean);
  if (!want.length) return 0;
  let best = 0;
  for (const alt of String(carline || '').split('/')) {
    const words = alt.toUpperCase().split(/\s+/).map(compact).filter(Boolean);
    const core = words.filter(w => !NOISE.has(w));
    if (core.join(' ') === want.join(' ')) return 3;
    if (want.every((w, i) => words[i] === w)) best = Math.max(best, 2);
    else if (words.some((_, i) => want.every((w, j) => words[i + j] === w))) best = Math.max(best, 1);
  }
  return best;
}

const kind = t => /manual/i.test(t || '') ? 'manual' : /cvt|variable|automatic|auto|dct|dual.clutch|direct drive/i.test(t || '') ? 'automatic' : null;
const axle = d => /front/i.test(d || '') && !/4|all/i.test(d || '') ? 'front' : /rear/i.test(d || '') && !/4|all/i.test(d || '') ? 'rear' : /4|all|awd/i.test(d || '') ? 'all' : null;
// EPA's drive field describes the test (AWD models are often listed as 2-wheel drive), so a drive word
// in the carline name (CR-V AWD, F150 4X4) wins; 'two' means a 2WD/4X2 name that does not say which axle.
const rowDrive = r => { const w = String(r.carline || '').toUpperCase().split(/[\s/]+/); return w.some(x => ['AWD', '4WD', '4X4', '4MOTION', 'QUATTRO', 'XDRIVE'].includes(x)) ? 'all' : w.includes('FWD') ? 'front' : w.includes('RWD') ? 'rear' : w.some(x => ['2WD', '4X2'].includes(x)) ? 'two' : axle(r.drive); };
const driveOk = (r, want) => { const d = rowDrive(r); return d === want || (d === 'two' && want !== 'all'); };
const transText = r => { const type = String(r.trans_type || r.trans_code || '').replace(/\s*\(e\.g\.[^)]*\)/i, '').toLowerCase(); return /continuously variable/.test(type) || !r.gears ? type : `${r.gears}-speed ${type}`; };
const isEv = report => /electric/i.test(report?.engine?.fuel_type || '') && !/hybrid|phev|plug/i.test(report?.engine?.ev_type || '') || /BEV/.test(report?.engine?.ev_type || '');
const range = values => { const v = values.filter(x => typeof x === 'number'); return v.length ? {min: Math.min(...v), max: Math.max(...v)} : null; };
const narrow = (rows, keep) => { const kept = rows.filter(keep); return kept.length ? kept : rows; };

/**
 * Test vehicles for a report ({vehicle, engine, transmission, fuel_economy}).
 * {available:false, reason} when the index is missing or nothing matches.
 */
export function lookupEpaTestCars(report, file = EPA_TEST_CARS_FILE) {
  const v = report?.vehicle || {};
  if (!v.year || !v.make || !v.model) return {available: false, reason: 'missing_vehicle'};
  if (!existsSync(file)) return {available: false, reason: 'dataset_not_indexed'};
  let db;
  try {
    db = new Database(file, {readonly: true, fileMustExist: true});
    const source = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='source'").get().value);
    const year = Number(v.year);
    const efids = (report.fuel_economy?.available && Array.isArray(report.fuel_economy.efids) ? report.fuel_economy.efids : []).map(e => String(e).toUpperCase());
    const e = report.engine || {}, t = report.transmission || {};
    const basis = [];
    let rows = [], match;
    const want = kind(t.type), speeds = Number(t.speeds) > 0 ? Number(t.speeds) : null, driveWant = axle(t.drive_type);
    // Soft filters: applied only when some candidates fit, and the basis says which were applied.
    const refine = list => {
      if (want) { const fit = list.filter(([r]) => kind(r.trans_type) === want); if (fit.length) { list = fit; basis.push(`${want} transmission`); } else basis.push(`${want} transmission not among the test vehicles`); }
      else if (match !== 'epa_test_group') basis.push('transmission not checked (not in the VIN decode)');
      if (want && speeds) { const fit = list.filter(([r]) => r.gears === speeds); if (fit.length) { list = fit; basis.push(`${speeds} speeds`); } }
      if (driveWant) { const fit = list.filter(([r]) => driveOk(r, driveWant)); const label = driveWant === 'all' ? 'four/all-wheel drive' : driveWant + '-wheel drive'; if (fit.length) { list = fit; basis.push(label); } else basis.push(`${label} not among the test vehicles (EPA lists ${[...new Set(list.map(([r]) => r.drive).filter(Boolean))].join(', ') || 'no drive'})`); }
      else if (match !== 'epa_test_group') basis.push('drive not checked (not in the VIN decode)');
      return list;
    };
    if (efids.length) {
      const marks = efids.map(() => '?').join(',');
      rows = db.prepare(`SELECT * FROM test_cars WHERE model_year=? AND test_group IN (${marks})`).all(year, ...efids);
      let carried = null;
      if (!rows.length) { // carried-over certification: the same test group tested for an earlier model year
        const prior = db.prepare(`SELECT max(model_year) AS y FROM test_cars WHERE model_year<? AND test_group IN (${marks})`).get(year, ...efids).y;
        if (prior) { carried = prior; rows = db.prepare(`SELECT * FROM test_cars WHERE model_year=? AND test_group IN (${marks})`).all(prior, ...efids); }
      }
      if (rows.length) {
        match = 'epa_test_group';
        basis.push(`EPA test group ${[...new Set(rows.map(r => r.test_group))].join(', ')} of the matched FuelEconomy.gov configuration${carried ? `, tested for model year ${carried} and carried over` : ''}`);
        const named = rows.filter(r => makeMatches(r, v.make) && carlineTier(v.model, r.carline) > 0);
        rows = refine((named.length ? named : rows).map(r => [r, 1])).map(([r]) => r);
      }
    }
    if (!rows.length) {
      match = 'closest_test_configuration';
      const all = db.prepare('SELECT * FROM test_cars WHERE model_year=?').all(year).filter(r => makeMatches(r, v.make));
      let list = all.map(r => [r, carlineTier(v.model, r.carline)]).filter(([, tier]) => tier > 0);
      let nameNote = 'model name';
      if (!list.length) { // "Bolt EV" is "BOLT" in some years: one retry with the first word, disclosed
        const first = String(v.model).split(/\s+/)[0];
        list = all.map(r => [r, carlineTier(first, r.carline)]).filter(([, tier]) => tier > 0);
        nameNote = `first word of the model name (${first})`;
      }
      const displ = Number(e.displacement_l);
      if (isEv(report)) { list = list.filter(([r]) => r.displacement_l === null); basis.push('electric (no engine)'); }
      else if (displ > 0) { list = list.filter(([r]) => r.displacement_l !== null && Math.abs(r.displacement_l - displ) <= 0.11); basis.push(`${displ.toFixed(1)} L engine`); }
      else basis.push('engine size not checked (not in the VIN decode)');
      if (list.length) list = refine(list);
      const best = Math.max(0, ...list.map(([, tier]) => tier));
      rows = list.filter(([, tier]) => tier === best).map(([r]) => r);
      if (rows.length) basis.unshift(`same model year, make and ${nameNote}${best < 3 ? ' (EPA carline ' + [...new Set(rows.map(r => r.carline))].slice(0, 4).join(', ') + ')' : ''}`);
    }
    if (!rows.length) return {available: false, reason: 'no_matching_test_vehicle', model_year: year};
    const uniq = list => [...new Set(list.filter(x => x !== null && x !== undefined && x !== ''))];
    const sourceFiles = uniq(rows.map(r => r.source_file));
    return {
      available: true, match, vin_specific: false, model_year: year, tested_model_years: uniq(rows.map(r => r.model_year)), match_basis: basis,
      rated_hp: range(rows.map(r => r.rated_hp)),
      transmissions: uniq(rows.map(transText)),
      drives_as_tested: uniq(rows.map(r => r.drive)), // EPA's test drive field; AWD models are often listed as 2-wheel drive
      axle_ratios: uniq(rows.map(r => r.axle_ratio)).sort((a, b) => a - b),
      test_weight_lb: range(rows.map(r => r.etw_lb)),
      test_groups: uniq(rows.map(r => r.test_group)).slice(0, 8),
      carlines: uniq(rows.map(r => [r.make, r.carline].filter(Boolean).join(' '))).slice(0, 8),
      configurations: rows.length,
      source: {provider: 'EPA Test Car List', page: source.page, files: sourceFiles, url: (source.sources || []).find(s => sourceFiles.includes(s.file))?.url ?? null, indexed_at: source.indexed_at ?? null},
      note: EPA_TEST_NOTE + (match === 'closest_test_configuration' ? ' Closest EPA test configuration: matched by ' + basis.join('; ') + '.' : ''),
    };
  } catch (err) {
    console.error('[epa-test-cars] lookup error:', err.message);
    return {available: false, reason: 'index_unreadable'};
  } finally {
    db?.close();
  }
}

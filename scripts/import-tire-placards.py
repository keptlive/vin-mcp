#!/usr/bin/env python3
"""Index the tire placard values printed in NHTSA crash-test reports, per tested vehicle.

NHTSA's crash-test reports (NCAP and FMVSS compliance tests, nrd-static.nhtsa.dot.gov) carry a data
sheet for the vehicle NHTSA bought and crashed: its VIN, the recommended tire size with load index
and speed symbol, and the front and rear cold inflation pressures copied from its door placard
(FMVSS No. 110). The cleaned values live in data-src/tire-placards.jsonl (built offline from the
report PDFs by the research pipeline; the server never downloads the PDFs). Each row is keyed by the
vPIC make, model and model year of the test vehicle's own VIN, so a report can match it exactly
against the VIN it decodes, plus its powertrain class from vPIC (battery_electric, not_battery_electric
or unknown): vPIC gives gasoline and battery-electric versions one model name (2025 'Silverado'
includes the Silverado EV), and the site never shows a test vehicle whose known class differs from
the decoded VIN's.

The same database also holds the test vehicles' capacities and weights (table specs) from
data-src/test-vehicle-specs.jsonl: usable standard (and optional) fuel tank, vehicle capacity weight
(payload), seating, GVWR and GAWR as printed on the certification label (unit kept), the weight as
delivered per axle, and the measured wheelbase (used only for the generation check).

One command rebuilds it from the branch files:  npm run import:test-vehicles
(= python3 scripts/import-tire-placards.py). It builds data/tire-placards.db atomically; a failure
leaves the previous file in place."""
from pathlib import Path
import datetime, hashlib, json, os, re, sqlite3, sys

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'data-src/tire-placards.jsonl'
SOURCE_META = ROOT / 'data-src/tire-placards.meta.json'
SPECS = ROOT / 'data-src/test-vehicle-specs.jsonl'
SPECS_META = ROOT / 'data-src/test-vehicle-specs.meta.json'
TARGET = ROOT / 'data/tire-placards.db'
KPA_PER_PSI = 6.894757
# Crash-test reports live on nrd-static; Office of Vehicle Safety Compliance test reports on static.nhtsa.gov/odi/ctr/.
REPORT_HOSTS = {'nhtsa_crash_test': 'https://nrd-static.nhtsa.dot.gov/', 'nhtsa_compliance_test': 'https://static.nhtsa.gov/odi/ctr/'}
POWERTRAINS = ('battery_electric', 'not_battery_electric', 'unknown')
# load range letter (B-F) as printed on LT and commercial sizes: LT265/70R18E 124/121R, 235/65R16C 121/119R
SIZE = re.compile(r'^(LT|P|T|HL)?\s?\d{3}/\d{2}\s?(ZR|RF|R)\s?\d{2}(\.\d)?(\s?(LT|XL)|[B-F])?(\s\d{2,3}(/\d{2,3})?\s?\(?[A-Z]{0,2}\)?)?$')


def key(text):
    """Upper case, trimmed, inner spaces collapsed. Must match keyName() in lib/tire-placards.mjs.
    vPIC spells a model the same way for every VIN, so no other folding is done: 'F-150' and
    'F150' stay different, and only an exact make, model and year match is ever shown."""
    return ' '.join(str(text or '').split()).upper()


def check_report(r, bad, what='report'):
    """A crash-test report has a positive test_no and an nrd-static URL; a compliance test report has no test_no,
    a numeric report_number and a static.nhtsa.gov/odi/ctr/ URL."""
    source = r.get('source') or 'nhtsa_crash_test'
    if source not in REPORT_HOSTS:
        bad(f'{what} source')
    if source == 'nhtsa_crash_test' and (not isinstance(r.get('test_no'), int) or r['test_no'] <= 0):
        bad(f'{what} test_no')
    if source == 'nhtsa_compliance_test' and (r.get('test_no') is not None or not re.fullmatch(r'\d{3,9}|\d{3}-\d{5,9}-TEST', str(r.get('report_number') or ''))):
        bad(f'{what} report_number')
    if not str(r.get('report_url') or '').startswith(REPORT_HOSTS[source]):
        bad(f'{what} report_url host')
    return source


def check(row, n):
    """Validate one dataset row; raise ValueError naming the line."""
    def bad(why):
        raise ValueError(f'line {n}: {why}')
    for f in ('make', 'model', 'tested_as', 'report_url', 'confidence'):
        if not isinstance(row.get(f), str) or not row[f].strip():
            bad(f'missing {f}')
    year = row.get('model_year')
    if not isinstance(year, int) or not 1990 <= year <= 2100:
        bad('model_year')
    check_report(row, bad)
    if row['confidence'] not in ('high', 'normal'):
        bad('confidence')
    if row.get('powertrain') not in POWERTRAINS:
        bad('powertrain')
    for side in ('front', 'rear'):
        tire = (row.get('tires') or {}).get(side)
        if not isinstance(tire, str) or not SIZE.match(tire.strip()):
            bad(f'tire {side}')
        kpa = (row.get('cold_pressure_kpa') or {}).get(side)
        psi = (row.get('cold_pressure_psi') or {}).get(side)
        if not isinstance(kpa, (int, float)) or not 150 <= kpa <= 700:
            bad(f'kPa {side}')
        if not isinstance(psi, int) or abs(psi - kpa / KPA_PER_PSI) > 0.5 + 1e-9:
            bad(f'psi {side} does not match kPa')
    for other in row.get('other_reports') or []:
        check_report(other, bad, 'other_reports')
    if row['confidence'] == 'high' and not row.get('other_reports'):
        bad('high confidence needs a second report')
    for f in ('vpic_series', 'fuel_type', 'ev_type'):
        if row.get(f) is not None and not isinstance(row[f], str):
            bad(f)
    row['_corrections'] = corrections(row, bad)


EXTRA_FIELDS = {'displacement_l': (int, float), 'cylinders': int, 'gvwr_class': str, 'cab': str, 'doors': int, 'plant': str}

# Confirmed corrections of report misprints (research pipeline scripts/corrections.py, owner 2026-11-17: correct when
# verifiable): a clear mechanical cause plus an independent check. Each keeps what the report printed and why.
CORRECTION_RULES = ('psi_under_kpa_heading', 'sidewall_maximum_in_pressure_row', 'pressure_digit_dropped', 'size_digit_glitch',
                    'front_rear_swapped', 'gallons_under_litres_heading', 'pounds_labelled_kg', 'kg_labelled_pounds')
CORRECTION_CHECKS = ('same_report', 'same_test_vehicle', 'same_generation_version', 'plausibility', 'vpic_gvwr_class')


def check_correction(c, bad, where):
    """One correction record: rule, field, printed and corrected values, a plain-words note and at least one independent
    check (a supporting vPIC GVWR class alone is not enough). Report links must be NHTSA report URLs."""
    if not isinstance(c, dict) or set(c) - {'field', 'rule', 'printed', 'corrected', 'note', 'confirmed_by', 'report', 'report_url'} or c.get('rule') not in CORRECTION_RULES:
        bad(f'{where} correction')
    if c.get('report_url') is not None and not any(str(c['report_url']).startswith(h) for h in REPORT_HOSTS.values()):
        bad(f'{where} correction report_url host')
    if not isinstance(c.get('note'), str) or not 20 <= len(c['note']) <= 500 or not isinstance(c.get('printed'), dict) or not isinstance(c.get('corrected'), dict):
        bad(f'{where} correction note or values')
    conf = c.get('confirmed_by')
    if not isinstance(conf, list) or not conf or not any(isinstance(x, dict) and x.get('check') in CORRECTION_CHECKS[:4] for x in conf):
        bad(f'{where} correction without an independent check')
    for x in conf:
        if not isinstance(x, dict) or x.get('check') not in CORRECTION_CHECKS or not isinstance(x.get('detail'), str) \
                or (x.get('report_url') is not None and not any(str(x['report_url']).startswith(h) for h in REPORT_HOSTS.values())):
            bad(f'{where} correction check')


def corrections(row, bad):
    """The row's confirmed corrections as JSON (None without any). A correction names the report it corrects (the shown one or a
    second report of the row); its corrected values must be the shown ones (pressures to the psi: 248 and 250 kPa are both 36 psi)."""
    cs = row.get('corrections')
    if cs is None:
        return None
    if not isinstance(cs, list) or not cs:
        bad('corrections')
    for c in cs:
        check_correction(c, bad, 'tire')
        v = c['corrected'].get('value')
        if c['field'] == 'cold_pressure':
            kpa = c['corrected'].get('kpa') or (v if c['corrected'].get('unit') == 'kPa' else None)
            if not isinstance(kpa, dict) or any(not isinstance(kpa.get(s), (int, float)) or round(kpa[s] / KPA_PER_PSI) != row['cold_pressure_psi'][s] for s in ('front', 'rear')):
                bad('corrected pressure is not the one shown')
        elif c['field'] == 'tire_size':
            if c['corrected'].get('axle') not in ('front', 'rear') or not isinstance(v, str) or re.sub(r'^P|\s', '', v) not in re.sub(r'^P|\s', '', row['tires'][c['corrected']['axle']]):
                bad('corrected size is not the one shown')
        else:
            bad('correction field')
    return json.dumps(cs, ensure_ascii=False, separators=(',', ':'))


def extra(row):
    """The test vehicle's own vPIC matching features (engine, GVWR class, cab, doors, plant) as JSON, or None."""
    x = row.get('vpic_extra')
    if not x:
        return None
    if not isinstance(x, dict) or any(k not in EXTRA_FIELDS or not isinstance(v, EXTRA_FIELDS[k]) or isinstance(v, bool) for k, v in x.items()):
        raise ValueError(f'bad vpic_extra {x!r}')
    return json.dumps(x, separators=(',', ':'), sort_keys=True)


def number(v, lo, hi):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and lo <= v <= hi


def check_specs(row, n):
    """Validate one test-vehicle specs row; raise ValueError naming the line."""
    def bad(why):
        raise ValueError(f'specs line {n}: {why}')
    for f in ('make', 'model', 'tested_as', 'report_url'):
        if not isinstance(row.get(f), str) or not row[f].strip():
            bad(f'missing {f}')
    if not isinstance(row.get('model_year'), int) or not 1990 <= row['model_year'] <= 2100:
        bad('model_year')
    check_report(row, bad)
    if row.get('powertrain') not in POWERTRAINS:
        bad('powertrain')
    shown = 0
    for name in ('fuel_tank_standard', 'fuel_tank_optional'):
        t = row.get(name)
        if t is None:
            continue
        if row['powertrain'] == 'battery_electric':
            bad(f'{name} on a battery-electric vehicle')
        if not number(t.get('litres'), 15, 250) or t.get('unit_printed') not in ('L', 'gal') or not number(t.get('printed'), 4, 250):
            bad(name)
        unit = t['unit_printed']
        if t.get('correction') is not None or t.get('unit') is not None:  # a confirmed unit correction: the printed number in its real unit
            check_correction(t.get('correction'), bad, name)
            if t.get('unit') not in ('L', 'gal') or t['unit'] == unit or t['correction']['rule'] != 'gallons_under_litres_heading':
                bad(f'{name} corrected unit')
            unit = t['unit']
        litres = t['printed'] * (3.785411784 if unit == 'gal' else 1)
        if abs(litres - t['litres']) > 0.2:
            bad(f'{name} litres do not match the printed value')
        shown += name == 'fuel_tank_standard'
    if row.get('vehicle_capacity_weight_kg') is not None:
        if not number(row['vehicle_capacity_weight_kg'], 100, 2500):
            bad('vehicle_capacity_weight_kg')
        shown += 1
    s = row.get('seating')
    if s is not None:
        # by row (crash reports), or the total alone (compliance reports print the placard's total)
        parts = [s.get(k) for k in ('front', 'rear', 'third') if k in s]
        if not isinstance(s.get('total'), int) or not 1 <= s['total'] <= 15 or not all(isinstance(x, int) and 0 <= x <= 9 for x in parts) \
                or (parts and sum(parts) != s['total']):
            bad('seating')
        shown += 1
    for name, lo, hi in (('gvwr', 700, 6400), ('gawr_front', 300, 4000), ('gawr_rear', 300, 4000)):
        w = row.get(name)
        if w is None:
            continue
        unit = w.get('unit_printed')
        if unit not in ('kg', 'lb', None) or (unit is None and w.get('unit_assumed') != 'kg'):
            bad(f'{name} unit')
        if w.get('correction') is not None or w.get('unit') is not None:  # a confirmed unit correction (pounds labelled kg or the reverse)
            check_correction(w.get('correction'), bad, name)
            if w.get('unit') not in ('kg', 'lb') or w['unit'] == unit or w['correction']['rule'] not in ('pounds_labelled_kg', 'kg_labelled_pounds'):
                bad(f'{name} corrected unit')
            unit = w['unit']
        kg = w.get('value') * 0.45359237 if unit == 'lb' and number(w.get('value'), 0, 1e5) else w.get('value')
        if not number(kg, lo, hi):
            bad(name)
        shown += 1
    c = row.get('curb_weight_kg')
    if c is not None:
        if not all(number(c.get(k), 100, 6000) for k in ('front', 'rear', 'total')) or abs(c['front'] + c['rear'] - c['total']) > 1:
            bad('curb_weight_kg')
        shown += 1
    if row.get('wheelbase_mm') is not None and not number(row['wheelbase_mm'], 1500, 5000):
        bad('wheelbase_mm')
    b = row.get('braking')
    if b is not None:  # FMVSS 135 cold-effectiveness stop from 100 km/h (limit 70 m)
        if not b or set(b) - {'stop_100kmh_lightly_loaded_m', 'stop_100kmh_fully_loaded_m'} or not all(number(v, 25, 75) for v in b.values()):
            bad('braking')
        shown += 1
    if row.get('max_speed_kmh') is not None and not number(row['max_speed_kmh'], 80, 350):
        bad('max_speed_kmh')
    # several compliance reports of one test vehicle (one VIN) form one row; field_reports names each value's report(s)
    for other in row.get('other_reports') or []:
        check_report(other, bad, 'other_reports')
    fr = row.get('field_reports')
    if fr is not None:
        numbers = {row.get('report_number')} | {o.get('report_number') for o in row.get('other_reports') or []}
        if not isinstance(fr, dict) or any(k not in SPEC_FIELDS or row.get(k) is None or not isinstance(v, list) or not v or not set(v) <= numbers
                                           for k, v in fr.items()):
            bad('field_reports')
    if not shown:
        bad('no shown field')


def build(source, target, meta_path=None, specs_path=None, specs_meta_path=None):
    """Build target from the JSON Lines dataset(s); returns the metadata written. Without specs_path the
    database has no specs table (the site then reports the specs block as not indexed)."""
    target = Path(target)
    temp = target.with_name('tire-placards-build-' + str(os.getpid()) + '.db')
    payload = Path(source).read_bytes()
    meta_in = json.loads(Path(meta_path).read_text()) if meta_path and Path(meta_path).exists() else {}
    db = sqlite3.connect(temp)
    try:
        db.executescript('''CREATE TABLE placards(id INTEGER PRIMARY KEY, make_key TEXT NOT NULL, model_key TEXT NOT NULL,
            year INTEGER NOT NULL, make TEXT NOT NULL, model TEXT NOT NULL, tested_as TEXT NOT NULL, vpic_trim TEXT,
            vpic_series TEXT, body_class TEXT, drive_type TEXT, fuel_type TEXT, ev_type TEXT, powertrain TEXT NOT NULL,
            tire_front TEXT NOT NULL, tire_rear TEXT NOT NULL,
            kpa_front REAL NOT NULL, kpa_rear REAL NOT NULL, psi_front INTEGER NOT NULL, psi_rear INTEGER NOT NULL,
            test_no INTEGER, report_url TEXT NOT NULL, test_type TEXT, other_reports TEXT NOT NULL,
            confidence TEXT NOT NULL, source TEXT NOT NULL, report_number TEXT, fmvss TEXT, vpic_extra TEXT, corrections TEXT);
            CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT);''')
        rows, seen = [], set()
        for n, line in enumerate(payload.decode('utf-8').splitlines(), 1):
            if not line.strip():
                continue
            row = json.loads(line)
            check(row, n)
            # one row per tested variant and values: two versions of one model year (4x2 and AWD) may share a tire size
            ident = (key(row['make']), key(row['model']), row['model_year'], row['powertrain'], key(row['tires']['front']), key(row['tires']['rear']),
                     row['cold_pressure_kpa']['front'], row['cold_pressure_kpa']['rear'],
                     *(key(row.get(f)) for f in ('vpic_trim', 'vpic_series', 'body_class', 'drive_type', 'fuel_type', 'ev_type')))
            if ident in seen:
                raise ValueError(f'line {n}: duplicate make/model/year/variant/tires/pressures')
            seen.add(ident)
            rows.append((key(row['make']), key(row['model']), row['model_year'], row['make'].strip(), row['model'].strip(),
                         row['tested_as'].strip(), row.get('vpic_trim'), row.get('vpic_series'), row.get('body_class'), row.get('drive_type'),
                         row.get('fuel_type'), row.get('ev_type'), row['powertrain'],
                         row['tires']['front'].strip(), row['tires']['rear'].strip(),
                         float(row['cold_pressure_kpa']['front']), float(row['cold_pressure_kpa']['rear']),
                         row['cold_pressure_psi']['front'], row['cold_pressure_psi']['rear'],
                         row.get('test_no'), row['report_url'], row.get('test_type'),
                         json.dumps([{'source': o.get('source') or 'nhtsa_crash_test', 'test_no': o.get('test_no'),
                                      **({'report_number': o['report_number']} if o.get('report_number') else {}), 'report_url': o['report_url']}
                                     for o in row.get('other_reports') or []]),
                         row['confidence'], row.get('source') or 'nhtsa_crash_test', row.get('report_number'),
                         json.dumps(row['fmvss']) if row.get('fmvss') else None, extra(row), row['_corrections']))
        if not rows:
            raise ValueError('Empty tire placard dataset')
        db.executemany('INSERT INTO placards(make_key,model_key,year,make,model,tested_as,vpic_trim,vpic_series,body_class,drive_type,fuel_type,ev_type,'
                       'powertrain,tire_front,tire_rear,kpa_front,kpa_rear,psi_front,psi_rear,test_no,report_url,test_type,other_reports,confidence,'
                       'source,report_number,fmvss,vpic_extra,corrections) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', rows)
        db.execute('CREATE INDEX vehicle_key ON placards(make_key, model_key, year)')
        metadata = {'source': 'NHTSA vehicle crash-test reports (NCAP and FMVSS compliance data sheets), nrd-static.nhtsa.dot.gov; '
                              'NHTSA Office of Vehicle Safety Compliance test reports (FMVSS 110/138/537/135), static.nhtsa.gov/odi/ctr',
                    'sources': {k: sum(1 for r in rows if r[24] == k) for k in REPORT_HOSTS},
                    'dataset_file': str(Path(source).name), 'sha256': hashlib.sha256(payload).hexdigest(), 'rows': len(rows),
                    'keys': len({r[:3] for r in rows}), 'dataset_generated_at': meta_in.get('generated_at'),
                    'reports_used': meta_in.get('reports_used'), 'dataset_status': meta_in.get('status'), 'indexed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        db.execute('INSERT INTO metadata VALUES(?,?)', ('source', json.dumps(metadata)))
        if specs_path:
            metadata['specs'] = build_specs(db, Path(specs_path), specs_meta_path)
        db.commit()
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('Integrity failure')
        db.close()
        os.replace(temp, target)
        return metadata
    except BaseException:
        db.close()
        temp.unlink(missing_ok=True)
        raise


SPEC_FIELDS = ('fuel_tank_standard', 'fuel_tank_optional', 'vehicle_capacity_weight_kg', 'seating', 'gvwr', 'gawr_front', 'gawr_rear',
               'curb_weight_kg', 'wheelbase_mm', 'braking', 'max_speed_kmh')


def build_specs(db, path, meta_path):
    """Add the specs table (one row per test report) to an open build database; returns its metadata."""
    payload = path.read_bytes()
    meta_in = json.loads(Path(meta_path).read_text()) if meta_path and Path(meta_path).exists() else {}
    db.execute('''CREATE TABLE specs(id INTEGER PRIMARY KEY, make_key TEXT NOT NULL, model_key TEXT NOT NULL, year INTEGER NOT NULL,
        make TEXT NOT NULL, model TEXT NOT NULL, tested_as TEXT NOT NULL, vpic_trim TEXT, vpic_series TEXT, body_class TEXT,
        drive_type TEXT, fuel_type TEXT, ev_type TEXT, powertrain TEXT NOT NULL, test_no INTEGER UNIQUE,
        report_url TEXT NOT NULL, test_type TEXT, data TEXT NOT NULL, source TEXT NOT NULL, report_number TEXT UNIQUE, fmvss TEXT,
        other_reports TEXT NOT NULL, field_reports TEXT, vpic_extra TEXT)''')
    rows = []
    for n, line in enumerate(payload.decode('utf-8').splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        check_specs(row, n)
        rows.append((key(row['make']), key(row['model']), row['model_year'], row['make'].strip(), row['model'].strip(), row['tested_as'].strip(),
                     row.get('vpic_trim'), row.get('vpic_series'), row.get('body_class'), row.get('drive_type'), row.get('fuel_type'),
                     row.get('ev_type'), row['powertrain'], row.get('test_no'), row['report_url'], row.get('test_type'),
                     json.dumps({k: row[k] for k in SPEC_FIELDS if row.get(k) is not None}, separators=(',', ':')),
                     row.get('source') or 'nhtsa_crash_test', row.get('report_number'), json.dumps(row['fmvss']) if row.get('fmvss') else None,
                     json.dumps(row.get('other_reports') or []), json.dumps(row['field_reports']) if row.get('field_reports') else None, extra(row)))
    if not rows:
        raise ValueError('Empty test-vehicle specs dataset')
    try:
        db.executemany('INSERT INTO specs(make_key,model_key,year,make,model,tested_as,vpic_trim,vpic_series,body_class,drive_type,fuel_type,'
                       'ev_type,powertrain,test_no,report_url,test_type,data,source,report_number,fmvss,other_reports,field_reports,vpic_extra) '
                       'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', rows)
    except sqlite3.IntegrityError as err:
        raise ValueError(f'specs: duplicate test_no or report ({err})')
    db.execute('CREATE INDEX specs_key ON specs(make_key, model_key, year)')
    metadata = {'dataset_file': path.name, 'sha256': hashlib.sha256(payload).hexdigest(), 'rows': len(rows),
                'dataset_generated_at': meta_in.get('generated_at'), 'dataset_status': meta_in.get('status'),
                'indexed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    db.execute('INSERT INTO metadata VALUES(?,?)', ('specs_source', json.dumps(metadata)))
    return metadata


def main():
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else SOURCE
    specs = Path(sys.argv[2]) if len(sys.argv) > 2 else SPECS
    TARGET.parent.mkdir(exist_ok=True)
    print(json.dumps(build(source, TARGET, SOURCE_META, specs, SPECS_META), indent=2))


if __name__ == '__main__':
    main()

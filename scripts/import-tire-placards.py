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
REPORT_HOST = 'https://nrd-static.nhtsa.dot.gov/'
POWERTRAINS = ('battery_electric', 'not_battery_electric', 'unknown')
SIZE = re.compile(r'^(LT|P|T|HL)?\s?\d{3}/\d{2}\s?(ZR|RF|R)\s?\d{2}(\.\d)?(\s?(LT|XL))?(\s\d{2,3}(/\d{2,3})?\s?\(?[A-Z]{0,2}\)?)?$')


def key(text):
    """Upper case, trimmed, inner spaces collapsed. Must match keyName() in lib/tire-placards.mjs.
    vPIC spells a model the same way for every VIN, so no other folding is done: 'F-150' and
    'F150' stay different, and only an exact make, model and year match is ever shown."""
    return ' '.join(str(text or '').split()).upper()


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
    if not isinstance(row.get('test_no'), int) or row['test_no'] <= 0:
        bad('test_no')
    if not row['report_url'].startswith(REPORT_HOST):
        bad('report_url host')
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
        if not isinstance(other.get('test_no'), int) or not str(other.get('report_url', '')).startswith(REPORT_HOST):
            bad('other_reports')
    if row['confidence'] == 'high' and not row.get('other_reports'):
        bad('high confidence needs a second report')
    for f in ('vpic_series', 'fuel_type', 'ev_type'):
        if row.get(f) is not None and not isinstance(row[f], str):
            bad(f)


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
    if not isinstance(row.get('test_no'), int) or row['test_no'] <= 0:
        bad('test_no')
    if not row['report_url'].startswith(REPORT_HOST):
        bad('report_url host')
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
        litres = t['printed'] * (3.785411784 if t['unit_printed'] == 'gal' else 1)
        if abs(litres - t['litres']) > 0.2:
            bad(f'{name} litres do not match the printed value')
        shown += name == 'fuel_tank_standard'
    if row.get('vehicle_capacity_weight_kg') is not None:
        if not number(row['vehicle_capacity_weight_kg'], 100, 2500):
            bad('vehicle_capacity_weight_kg')
        shown += 1
    s = row.get('seating')
    if s is not None:
        parts = [s.get(k) or 0 for k in ('front', 'rear', 'third')]
        if not all(isinstance(x, int) and 0 <= x <= 9 for x in parts) or not isinstance(s.get('total'), int) or sum(parts) != s['total'] or not 1 <= s['total'] <= 15:
            bad('seating')
        shown += 1
    for name, lo, hi in (('gvwr', 700, 6400), ('gawr_front', 300, 4000), ('gawr_rear', 300, 4000)):
        w = row.get(name)
        if w is None:
            continue
        unit = w.get('unit_printed')
        if unit not in ('kg', 'lb', None) or (unit is None and w.get('unit_assumed') != 'kg'):
            bad(f'{name} unit')
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
            test_no INTEGER NOT NULL, report_url TEXT NOT NULL, test_type TEXT, other_reports TEXT NOT NULL,
            confidence TEXT NOT NULL);
            CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT);''')
        rows, seen = [], set()
        for n, line in enumerate(payload.decode('utf-8').splitlines(), 1):
            if not line.strip():
                continue
            row = json.loads(line)
            check(row, n)
            ident = (key(row['make']), key(row['model']), row['model_year'], row['powertrain'], key(row['tires']['front']), key(row['tires']['rear']))
            if ident in seen:
                raise ValueError(f'line {n}: duplicate make/model/year/tires')
            seen.add(ident)
            rows.append((key(row['make']), key(row['model']), row['model_year'], row['make'].strip(), row['model'].strip(),
                         row['tested_as'].strip(), row.get('vpic_trim'), row.get('vpic_series'), row.get('body_class'), row.get('drive_type'),
                         row.get('fuel_type'), row.get('ev_type'), row['powertrain'],
                         row['tires']['front'].strip(), row['tires']['rear'].strip(),
                         float(row['cold_pressure_kpa']['front']), float(row['cold_pressure_kpa']['rear']),
                         row['cold_pressure_psi']['front'], row['cold_pressure_psi']['rear'],
                         row['test_no'], row['report_url'], row.get('test_type'),
                         json.dumps([{'test_no': o['test_no'], 'report_url': o['report_url']} for o in row.get('other_reports') or []]),
                         row['confidence']))
        if not rows:
            raise ValueError('Empty tire placard dataset')
        db.executemany('INSERT INTO placards(make_key,model_key,year,make,model,tested_as,vpic_trim,vpic_series,body_class,drive_type,fuel_type,ev_type,'
                       'powertrain,tire_front,tire_rear,kpa_front,kpa_rear,psi_front,psi_rear,test_no,report_url,test_type,other_reports,confidence) '
                       'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', rows)
        db.execute('CREATE INDEX vehicle_key ON placards(make_key, model_key, year)')
        metadata = {'source': 'NHTSA vehicle crash-test reports (NCAP and FMVSS compliance data sheets), nrd-static.nhtsa.dot.gov',
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
               'curb_weight_kg', 'wheelbase_mm')


def build_specs(db, path, meta_path):
    """Add the specs table (one row per test report) to an open build database; returns its metadata."""
    payload = path.read_bytes()
    meta_in = json.loads(Path(meta_path).read_text()) if meta_path and Path(meta_path).exists() else {}
    db.execute('''CREATE TABLE specs(id INTEGER PRIMARY KEY, make_key TEXT NOT NULL, model_key TEXT NOT NULL, year INTEGER NOT NULL,
        make TEXT NOT NULL, model TEXT NOT NULL, tested_as TEXT NOT NULL, vpic_trim TEXT, vpic_series TEXT, body_class TEXT,
        drive_type TEXT, fuel_type TEXT, ev_type TEXT, powertrain TEXT NOT NULL, test_no INTEGER NOT NULL UNIQUE,
        report_url TEXT NOT NULL, test_type TEXT, data TEXT NOT NULL)''')
    rows = []
    for n, line in enumerate(payload.decode('utf-8').splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        check_specs(row, n)
        rows.append((key(row['make']), key(row['model']), row['model_year'], row['make'].strip(), row['model'].strip(), row['tested_as'].strip(),
                     row.get('vpic_trim'), row.get('vpic_series'), row.get('body_class'), row.get('drive_type'), row.get('fuel_type'),
                     row.get('ev_type'), row['powertrain'], row['test_no'], row['report_url'], row.get('test_type'),
                     json.dumps({k: row[k] for k in SPEC_FIELDS if row.get(k) is not None}, separators=(',', ':'))))
    if not rows:
        raise ValueError('Empty test-vehicle specs dataset')
    try:
        db.executemany('INSERT INTO specs(make_key,model_key,year,make,model,tested_as,vpic_trim,vpic_series,body_class,drive_type,fuel_type,'
                       'ev_type,powertrain,test_no,report_url,test_type,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', rows)
    except sqlite3.IntegrityError as err:
        raise ValueError(f'specs: duplicate test_no ({err})')
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

#!/usr/bin/env python3
"""Index the NHTSA test-vehicle evidence the VIN decode checks use (lib/decode-checks.mjs).

NHTSA buys vehicles and crash-tests them (or tests them for compliance); each test report carries a data sheet
recording the vehicle's VIN, final drive, engine displacement and cylinders, transmission type and speeds, seating
capacity, the GVWR on its certification label and its measured weight. The decode audit of 2026-11-17 compared
those records with vPIC's decode of each test vehicle's own VIN (2,454 vehicles); the cleaned per-vehicle values
live in data-src/decode-evidence.jsonl (built offline by the research pipeline; the server never downloads the
PDFs). Rows are keyed by VIN pattern: positions 1-8, 10 (model year) and 11 (plant), the part of the VIN that
vPIC decodes; vehicles that share a pattern share vPIC's decode, so their lab records are evidence for one
another and for any VIN with that pattern.

One command rebuilds it:  npm run import:decode-evidence  (= python3 scripts/import-decode-evidence.py).
It builds data/decode-evidence.db atomically; a failure leaves the previous file in place."""
from pathlib import Path
import json, os, re, sqlite3, sys

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'data-src/decode-evidence.jsonl'
SOURCE_META = ROOT / 'data-src/decode-evidence.meta.json'
TARGET = ROOT / 'data/decode-evidence.db'
PATTERN = re.compile(r'^[A-HJ-NPR-Z0-9]{8}\*[A-HJ-NPR-Z0-9]{2}$')
VIN = re.compile(r'^[A-HJ-NPR-Z0-9]{17}$')
REPORT_HOSTS = ('https://nrd-static.nhtsa.dot.gov/', 'https://static.nhtsa.gov/odi/ctr/')
FIELDS = {
    'drive': lambda v: v in ('front', 'rear', 'all', 'two'),
    'engine_size': lambda v: isinstance(v, (int, float)) and (v == 0 or 0.5 <= v <= 9.0),
    'cylinders': lambda v: isinstance(v, int) and 0 <= v <= 16,
    'powertrain': lambda v: v in ('ev', 'phev', 'hev', 'mhev', 'hybrid'),
    'transmission': lambda v: v in ('auto', 'manual', 'cvt', 'am', 'single'),
    'speeds': lambda v: isinstance(v, int) and 1 <= v <= 12,
    'seats': lambda v: isinstance(v, int) and 1 <= v <= 20,
    'gvwr_class': lambda v: isinstance(v, str) and re.fullmatch(r'[1-8][A-H]?', v) is not None,
    'curb_weight_kg': lambda v: isinstance(v, (int, float)) and 300 <= v <= 12000,
}


def pattern_of(vin):
    return vin[:8] + '*' + vin[9:11]


def check(row, n):
    def bad(what):
        raise ValueError(f'line {n}: {what}')
    if not VIN.match(row.get('vin') or ''):
        bad('vin')
    if row.get('pattern') != pattern_of(row['vin']) or not PATTERN.match(row['pattern']):
        bad('pattern')
    if not isinstance(row.get('model_year'), int) or not 1980 <= row['model_year'] <= 2100:
        bad('model_year')
    if not row.get('make') or not row.get('model'):
        bad('make/model')
    tests = row.get('tests') or []
    if not tests:
        bad('tests')
    for t in tests:
        if t.get('test_no') is not None and (not isinstance(t['test_no'], int) or t['test_no'] <= 0):
            bad('test_no')
        if t.get('report_url') is not None and not str(t['report_url']).startswith(REPORT_HOSTS):
            bad('report_url host')
    values = row.get('values') or {}
    if not values:
        bad('values')
    for k, v in values.items():
        if k not in FIELDS:
            bad(f'unknown field {k}')
        if not FIELDS[k](v.get('value')):
            bad(f'{k} value {v.get("value")!r}')
        if not isinstance(v.get('sources'), list):
            bad(f'{k} sources')
    for k, v in (row.get('own_decode_errors') or {}).items():
        if k not in FIELDS or not FIELDS[k](v.get('right')) or not v.get('reason'):
            bad(f'own_decode_errors {k}')


def main():
    rows = []
    with open(SOURCE) as f:
        for n, line in enumerate(f, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            check(row, n)
            rows.append(row)
    if len(rows) < 100:
        raise SystemExit(f'only {len(rows)} rows: refusing to replace the index')
    meta = json.loads(SOURCE_META.read_text()) if SOURCE_META.exists() else {}
    tmp = TARGET.with_suffix('.db.tmp')
    if tmp.exists():
        tmp.unlink()
    db = sqlite3.connect(tmp)
    db.executescript('''
      CREATE TABLE vehicles (id INTEGER PRIMARY KEY, pattern TEXT NOT NULL, vin TEXT NOT NULL UNIQUE, model_year INTEGER NOT NULL,
        make TEXT NOT NULL, model TEXT NOT NULL, title TEXT, tests TEXT NOT NULL, vals TEXT NOT NULL, withheld TEXT, own_decode_errors TEXT);
      CREATE INDEX idx_vehicles_pattern ON vehicles(pattern);
      CREATE TABLE test_numbers (test_no INTEGER NOT NULL, vehicle_id INTEGER NOT NULL);
      CREATE INDEX idx_test_numbers ON test_numbers(test_no);
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    ''')
    for row in rows:
        cur = db.execute('INSERT INTO vehicles (pattern, vin, model_year, make, model, title, tests, vals, withheld, own_decode_errors) VALUES (?,?,?,?,?,?,?,?,?,?)',
                         (row['pattern'], row['vin'], row['model_year'], row['make'], row['model'], row.get('title'), json.dumps(row['tests']),
                          json.dumps(row['values']), json.dumps(row['withheld']) if row.get('withheld') else None,
                          json.dumps(row['own_decode_errors']) if row.get('own_decode_errors') else None))
        for t in row['tests']:
            if t.get('test_no'):
                db.execute('INSERT INTO test_numbers VALUES (?, ?)', (t['test_no'], cur.lastrowid))
    db.execute('INSERT INTO metadata VALUES (?, ?)', ('source', json.dumps(meta)))
    db.commit()
    db.execute('VACUUM')
    db.close()
    os.replace(tmp, TARGET)
    shown = TARGET.relative_to(ROOT) if TARGET.is_relative_to(ROOT) else TARGET
    print(f'{shown}: {len(rows)} test vehicles, {len({r["pattern"] for r in rows})} VIN patterns')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, sqlite3.Error) as e:
        print('import failed:', e, file=sys.stderr)
        sys.exit(1)

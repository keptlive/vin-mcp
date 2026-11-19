#!/usr/bin/env python3
"""Index FuelEconomy.gov's vehicle table for local fuel-economy matching.

Source: https://www.fueleconomy.gov/feg/download.shtml (U.S. Government work, public domain)
  - vehicles.csv.zip: one row per EPA-rated configuration, model years 1984 on (2.2 MB zipped, 22 MB of CSV);
  - emissions.csv.zip: the EPA test groups (efid) of each configuration (0.3 MB zipped).
Column names are kept exactly as in the CSV, which are also the field names of the FuelEconomy.gov
web service's vehicle record (city08, comb08, trany, VClass, ...), so the matcher reads both alike.
Empty cells become NULL (unknown), never zero. Rows without a usable id, year, make or model are
rejected and counted.

usage: python3 scripts/import-fueleconomy.py [--refresh]
Builds data/fueleconomy.db atomically from files cached in operations/free-data/fueleconomy/."""
from pathlib import Path
from urllib.request import Request, urlopen
import csv, datetime, hashlib, io, json, os, re, sqlite3, sys, time, zipfile

ROOT = Path(__file__).resolve().parent.parent
PAGE = 'https://www.fueleconomy.gov/feg/download.shtml'
URLS = {
    'vehicles': 'https://www.fueleconomy.gov/feg/epadata/vehicles.csv.zip',
    'emissions': 'https://www.fueleconomy.gov/feg/epadata/emissions.csv.zip',
}
# Honest client name (no browser imitation): if a source refuses it, stop and report, never disguise the request.
UA = 'mcp.vin-importer/1.0 (+https://mcp.vin)'
MAX_BYTES = 20_000_000

# Columns kept (CSV names). Text columns stay text; the rest are numbers.
TEXT = ['make', 'model', 'baseModel', 'drive', 'trany', 'atvType', 'fuelType', 'fuelType1', 'fuelType2', 'eng_dscr',
        'trans_dscr', 'tCharger', 'sCharger', 'VClass', 'evMotor', 'startStop', 'mfrCode', 'guzzler', 'c240Dscr',
        'c240bDscr', 'createdOn', 'modifiedOn']
NUMBER = ['displ', 'cylinders', 'city08', 'highway08', 'comb08', 'cityA08', 'highwayA08', 'combA08', 'fuelCost08',
          'fuelCostA08', 'co2TailpipeGpm', 'co2TailpipeAGpm', 'range', 'rangeCity', 'rangeHwy', 'rangeA', 'charge120',
          'charge240', 'charge240b', 'cityE', 'highwayE', 'combE', 'phevCity', 'phevHwy', 'phevComb', 'feScore', 'ghgScore']
REQUIRED = ['id', 'year', 'make', 'model', 'trany', 'drive', 'comb08', 'displ', 'cylinders', 'atvType', 'VClass']


def compact(text):
    """Upper-case letters and digits only; the runtime uses the same rule (lib/fueleconomy-index.mjs)."""
    return re.sub(r'[^A-Z0-9]', '', str(text or '').upper())


def csv_rows(path, member):
    with zipfile.ZipFile(path) as z:
        with z.open(member) as f:
            yield from csv.DictReader(io.TextIOWrapper(f, encoding='utf-8', errors='replace', newline=''))


def number(value):
    text = str(value if value is not None else '').strip()
    if text == '':
        return None
    try:
        n = float(text)
    except ValueError:
        return None
    return int(n) if n.is_integer() else n


def text(value):
    t = str(value if value is not None else '').strip()
    return t or None


def build(vehicles_zip, emissions_zip, target, sources=None):
    """Builds target atomically from the two zipped CSVs; a failure keeps the old file."""
    temp = target.with_name('fueleconomy-build-' + str(os.getpid()) + '.db')
    db = sqlite3.connect(temp)
    try:
        cols = ', '.join([f'"{c}" TEXT' for c in TEXT] + [f'"{c}" REAL' for c in NUMBER])
        db.executescript(f'''CREATE TABLE vehicles(id INTEGER PRIMARY KEY, year INTEGER NOT NULL, make_key TEXT NOT NULL, {cols});
            CREATE TABLE emissions(id INTEGER NOT NULL, efid TEXT NOT NULL, salesArea TEXT, standard TEXT, stdText TEXT, PRIMARY KEY(id, efid));
            CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT);''')
        rejected, read, kept = {}, 0, 0
        header_checked = False
        insert = f'INSERT OR REPLACE INTO vehicles VALUES({",".join("?" * (3 + len(TEXT) + len(NUMBER)))})'
        batch = []
        for raw in csv_rows(vehicles_zip, 'vehicles.csv'):
            if not header_checked:
                missing = [c for c in REQUIRED if c not in raw]
                if missing:
                    raise ValueError('vehicles.csv lacks columns: ' + ', '.join(missing))
                header_checked = True
            read += 1
            vid, year = number(raw.get('id')), number(raw.get('year'))
            if not isinstance(vid, int) or not isinstance(year, int) or not (1984 <= year <= 2100) or not text(raw.get('make')) or not text(raw.get('model')):
                rejected['missing_id_year_make_or_model'] = rejected.get('missing_id_year_make_or_model', 0) + 1
                continue
            batch.append((vid, year, compact(raw['make']), *[text(raw.get(c)) for c in TEXT], *[number(raw.get(c)) for c in NUMBER]))
            kept += 1
        if not read:
            raise ValueError('vehicles.csv is empty')
        db.executemany(insert, batch)
        efids, e_read = 0, 0
        known = {r[0] for r in batch}
        e_batch = []
        for raw in csv_rows(emissions_zip, 'emissions.csv'):
            e_read += 1
            vid, efid = number(raw.get('id')), text(raw.get('efid'))
            if not isinstance(vid, int) or not efid or vid not in known:
                rejected['emissions_row_without_vehicle'] = rejected.get('emissions_row_without_vehicle', 0) + 1
                continue
            e_batch.append((vid, efid.upper(), text(raw.get('salesArea')), text(raw.get('standard')), text(raw.get('stdText'))))
        db.executemany('INSERT OR IGNORE INTO emissions VALUES(?,?,?,?,?)', e_batch)
        efids = db.execute('SELECT count(*) FROM emissions').fetchone()[0]
        db.executescript('CREATE INDEX by_year_make ON vehicles(year, make_key);')
        years = db.execute('SELECT min(year), max(year) FROM vehicles').fetchone()
        metadata = {'page': PAGE, 'sources': sources or [], 'model_years': list(years), 'vehicle_rows_read': read,
                    'configurations': kept, 'emissions_rows_read': e_read, 'test_group_links': efids, 'rejected': rejected,
                    'indexed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        db.execute('INSERT INTO metadata VALUES(?,?)', ('source', json.dumps(metadata)))
        db.commit()
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('Integrity failure')
        db.execute('VACUUM')
        db.close()
        os.replace(temp, target)
        return metadata
    except BaseException:
        db.close()
        temp.unlink(missing_ok=True)
        raise


def main():
    cache = ROOT / 'operations/free-data/fueleconomy'
    cache.mkdir(parents=True, exist_ok=True)
    sources, paths = [], {}
    for name, url in URLS.items():
        path = cache / url.rsplit('/', 1)[-1]
        last_modified = None
        if not path.exists() or '--refresh' in sys.argv:
            time.sleep(3)  # gentle on fueleconomy.gov
            with urlopen(Request(url, headers={'User-Agent': UA}), timeout=120) as r:
                payload = r.read(MAX_BYTES + 1)
                last_modified = r.headers.get('Last-Modified')
            if len(payload) > MAX_BYTES:
                raise ValueError('Download size limit: ' + url)
            staged = path.with_suffix(path.suffix + '.download')
            staged.write_bytes(payload)
            os.replace(staged, path)
            if last_modified:
                (cache / (path.name + '.last-modified')).write_text(last_modified)
        lm_file = cache / (path.name + '.last-modified')
        payload = path.read_bytes()
        sources.append({'file': path.name, 'url': url, 'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest(),
                        'last_modified': lm_file.read_text().strip() if lm_file.exists() else None})
        paths[name] = path
    target = ROOT / 'data/fueleconomy.db'
    target.parent.mkdir(exist_ok=True)
    print(json.dumps(build(paths['vehicles'], paths['emissions'], target, sources), indent=2))


if __name__ == '__main__':
    main()

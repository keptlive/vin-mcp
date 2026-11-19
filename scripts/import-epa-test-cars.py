#!/usr/bin/env python3
"""Index EPA's Test Car List: the vehicles manufacturers tested for fuel economy certification.

Source: https://www.epa.gov/compliance-and-fuel-economy-data/data-cars-used-testing-fuel-economy
One file per model year: 1998-1999 zipped CSV, 2000-2016 CSV, 2017 on XLSX. Three layouts:
  - short names (1998-1999): yr, mfr name, carline, cid, rhp, trns, drv, etw, axle, n/v, eng family;
  - coded columns (model years 1998-2009): MDLYR_DT, VI_MFR_NM (manufacturer, no make), CL_NM (carline),
    GBE_CID_MSR (cubic inches), VC_RTD_HP_MSR, TRNS (L5, M6, AV...), DRV_SYS_CD, VC_DSN_ETW_MSR,
    VC_AXLE_RAT_MSR, VC_NV_RAT_MSR, EF_ID;
  - named columns (2009 late release, 2010 on): Model Year, Represented Test Veh Make/Model,
    Test Veh Displacement (L), Actual Tested Testgroup, Rated Horsepower, Tested Transmission Type,
    # of Gears, Drive System Description, Equivalent Test Weight (lbs.), Axle Ratio, N/V Ratio.
Each test is one row (city, highway, US06...); identical configurations are stored once.
Values outside plausible ranges become NULL (unknown) and are counted, never repaired.

usage: python3 scripts/import-epa-test-cars.py [--refresh]
Builds data/epa-test-cars.db atomically from files cached in operations/free-data/epa-test-cars/."""
from pathlib import Path
from urllib.request import Request, urlopen
import csv, datetime, hashlib, io, json, os, re, sqlite3, sys, time, zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
PAGE = 'https://www.epa.gov/compliance-and-fuel-economy-data/data-cars-used-testing-fuel-economy'
# File links on PAGE as read on 17 November 2026 (model year -> URL). The page lists one file per year.
URLS = {
    1998: 'https://www.epa.gov/sites/default/files/2016-07/98tstcar.zip',
    1999: 'https://www.epa.gov/sites/default/files/2016-07/99tstcar.zip',
    **{2000 + i: f'https://www.epa.gov/sites/default/files/2016-07/{i:02d}tstcar.csv' for i in range(0, 17)},
    2017: 'https://www.epa.gov/sites/default/files/2018-06/17tstcar-2018-05-30.xlsx',
    2018: 'https://www.epa.gov/sites/default/files/2018-10/18tstcar-2018-10-24.xlsx',
    2019: 'https://www.epa.gov/sites/default/files/2020-10/19tstcar-2020-10-02.xlsx',
    2020: 'https://www.epa.gov/sites/default/files/2021-03/20tstcar-2021-03-02.xlsx',
    2021: 'https://www.epa.gov/system/files/documents/2022-04/21-tstcar-2022-04-15.xlsx',
    2022: 'https://www.epa.gov/system/files/documents/2023-06/22-testcar-2023-06-13.xlsx',
    2023: 'https://www.epa.gov/system/files/documents/2024-05/23-testcar-2024-05-17_0.xlsx',
    2024: 'https://www.epa.gov/system/files/documents/2025-05/24-testcar-2025-05.xlsx',
    2025: 'https://www.epa.gov/system/files/documents/2026-01/25-testcar-2026-01-21.xlsx',
    2026: 'https://www.epa.gov/system/files/documents/2026-01/26-testcar-2026-01-21.xlsx',
}
# The 2009 file has a second, later release in the named layout.
EXTRA = {2009: ['https://www.epa.gov/sites/default/files/2016-07/09tstcar-laterelease.csv']}
# Honest client name (no browser imitation): if a source refuses it, stop and report, never disguise the request.
UA = 'mcp.vin-importer/1.0 (+https://mcp.vin)'
MAX_BYTES = 30_000_000

# Column names per layout -> field. First present name wins.
COLUMNS = {
    'model_year': ['Model Year', 'MDLYR_DT', 'yr'],
    'manufacturer': ['Vehicle Manufacturer Name', 'VI_MFR_NM', 'mfr name'],
    'make': ['Represented Test Veh Make'],
    'carline': ['Represented Test Veh Model', 'CL_NM', 'carline'],
    'test_group': ['Actual Tested Testgroup', 'EF_ID', 'eng family'],
    'displacement_l': ['Test Veh Displacement (L)'],
    'displacement_cid': ['GBE_CID_MSR', 'cid'],
    'cylinders': ['# of Cylinders and Rotors', 'VC_CYL_CNT'],
    'rated_hp': ['Rated Horsepower', 'VC_RTD_HP_MSR', 'rhp'],
    'trans_code': ['Tested Transmission Type Code', 'TRNS', 'trns'],
    'trans_type': ['Tested Transmission Type'],
    'gears': ['# of Gears'],
    'drive_code': ['Drive System Code', 'DRV_SYS_CD', 'drv'],
    'drive': ['Drive System Description'],
    'etw_lb': ['Equivalent Test Weight (lbs.)', 'VC_DSN_ETW_MSR', 'etw'],
    'axle_ratio': ['Axle Ratio', 'VC_AXLE_RAT_MSR', 'axle'],
    'nv_ratio': ['N/V Ratio', 'VC_NV_RAT_MSR', 'n/v'],
    'vehicle_type': ['Vehicle Type', 'CLS_TYP_CD', 'car/truck'],
}
REQUIRED = ['model_year', 'carline', 'rated_hp', 'axle_ratio', 'etw_lb']
# Plausible ranges; anything else is unknown.
RANGES = {'rated_hp': (20, 2500), 'axle_ratio': (1.0, 12.0), 'etw_lb': (1000, 20000), 'nv_ratio': (5, 200),
          'displacement_l': (0.5, 10.0), 'cylinders': (1, 16), 'gears': (1, 12)}
# Old coded transmissions: letter = kind, digits = gears (L5 = 5-speed automatic with lockup).
TRANS_KIND = {'A': 'Automatic', 'L': 'Automatic', 'S': 'Automatic', 'C': 'Automatic', 'M': 'Manual', 'AV': 'CVT', 'SCV': 'CVT', 'OT': None}
DRIVE_CODE = {'F': '2-Wheel Drive, Front', 'R': '2-Wheel Drive, Rear', '4': '4-Wheel Drive', 'A': 'All Wheel Drive', 'P': 'Part-time 4-Wheel Drive'}


def compact(text):
    """Letters and digits only, upper case. Must match lib/epa-test-cars.mjs."""
    return ''.join(re.findall(r'[A-Z0-9]+', str(text or '').upper()))


def number(value, field, rejected):
    text = str(value if value is not None else '').strip().replace(',', '')
    if text in ('', 'N/A', 'NA', '-', 'n/a'):
        return None
    try:
        n = float(text)
    except ValueError:
        rejected[field] = rejected.get(field, 0) + 1
        return None
    lo, hi = RANGES.get(field, (float('-inf'), float('inf')))
    if not lo <= n <= hi:
        rejected[field] = rejected.get(field, 0) + 1
        return None
    return n


def xlsx_rows(payload):
    """Rows of the first worksheet of an .xlsx file as lists of strings (stdlib only)."""
    ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    with zipfile.ZipFile(io.BytesIO(payload)) as z:
        names = set(z.namelist())
        shared = []
        if 'xl/sharedStrings.xml' in names:
            for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', ns):
                shared.append(''.join(t.text or '' for t in si.iter('{%s}t' % ns['m'])))
        rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
        targets = {r.get('Id'): r.get('Target') for r in rels}
        first = ET.fromstring(z.read('xl/workbook.xml')).find('m:sheets/m:sheet', ns)
        rid = first.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
        sheet = 'xl/' + targets[rid].lstrip('/').removeprefix('xl/')
        with z.open(sheet) as f:
            for _, el in ET.iterparse(f):
                if el.tag != '{%s}row' % ns['m']:
                    continue
                cells = {}
                for c in el.findall('m:c', ns):
                    ref = re.match(r'([A-Z]+)', c.get('r', ''))
                    col = 0
                    for ch in (ref.group(1) if ref else ''):
                        col = col * 26 + ord(ch) - 64
                    t, v = c.get('t'), c.find('m:v', ns)
                    if t == 's' and v is not None:
                        value = shared[int(v.text)]
                    elif t == 'inlineStr':
                        value = ''.join(x.text or '' for x in c.iter('{%s}t' % ns['m']))
                    else:
                        value = v.text if v is not None else ''
                    cells[col - 1] = value
                el.clear()
                if cells:
                    yield [cells.get(i, '') for i in range(max(cells) + 1)]


def table_rows(name, payload):
    """Header-keyed rows from a CSV, zipped CSV or XLSX file."""
    if name.endswith('.xlsx'):
        rows = xlsx_rows(payload)
    else:
        if name.endswith('.zip'):
            with zipfile.ZipFile(io.BytesIO(payload)) as z:
                members = [i for i in z.infolist() if i.filename.lower().endswith(('.csv', '.txt'))]
                if len(members) != 1 or members[0].file_size > 200_000_000:
                    raise ValueError('Unexpected archive layout: ' + name)
                payload = z.read(members[0])
        text = payload.decode('utf-8-sig') if payload[:3] == b'\xef\xbb\xbf' else payload.decode('latin-1')
        rows = csv.reader(io.StringIO(text))
    header = None
    for r in rows:
        if header is None:
            # Some files carry title lines above the header: the header names a carline column.
            if any(h.strip() in ('Represented Test Veh Model', 'CL_NM', 'carline') for h in r):
                header = [h.strip() for h in r]
            continue
        yield dict(zip(header, r))
    if header is None:
        raise ValueError('No header row found: ' + name)


def normalise(raw, year, rejected):
    """One output row or None. raw: header -> text."""
    get = lambda f: next((raw[c] for c in COLUMNS[f] if c in raw and str(raw[c]).strip() != ''), None)
    if any(get(f) is None for f in ('model_year', 'carline')):
        rejected['missing_carline_or_year'] = rejected.get('missing_carline_or_year', 0) + 1
        return None
    try:
        model_year = int(float(get('model_year')))
    except ValueError:
        model_year = None
    if model_year != year:
        rejected['model_year_differs_from_file'] = rejected.get('model_year_differs_from_file', 0) + 1
        return None
    disp = number(get('displacement_l'), 'displacement_l', rejected)
    if disp is None and get('displacement_cid') is not None:
        cid = number(get('displacement_cid'), 'displacement_cid', rejected)
        disp = round(cid * 0.016387064, 1) if cid and 30 <= cid <= 610 else None
    trans_code = str(get('trans_code') or '').strip().upper()
    trans_type, gears = (str(get('trans_type')).strip() if get('trans_type') else None), number(get('gears'), 'gears', rejected)
    m = re.fullmatch(r'([A-Z]+?)(\d{1,2})?', trans_code)
    if trans_type is None and m:
        trans_type = TRANS_KIND.get(m.group(1))
        if gears is None and m.group(2):
            gears = number(m.group(2), 'gears', rejected)
    drive_code = str(get('drive_code') or '').strip().upper()
    drive = str(get('drive')).strip() if get('drive') else DRIVE_CODE.get(drive_code)
    row = {
        'model_year': model_year,
        'manufacturer': str(get('manufacturer') or '').strip() or None,
        'make': str(get('make') or '').strip() or None,
        'carline': str(get('carline')).strip(),
        'test_group': str(get('test_group') or '').strip().upper() or None,
        'displacement_l': disp,
        'cylinders': number(get('cylinders'), 'cylinders', rejected),
        'rated_hp': number(get('rated_hp'), 'rated_hp', rejected),
        'trans_type': trans_type, 'trans_code': trans_code or None, 'gears': gears,
        'drive': drive,
        'etw_lb': number(get('etw_lb'), 'etw_lb', rejected),
        'axle_ratio': number(get('axle_ratio'), 'axle_ratio', rejected),
        'nv_ratio': number(get('nv_ratio'), 'nv_ratio', rejected),
    }
    if row['rated_hp'] is None and row['axle_ratio'] is None and row['etw_lb'] is None:
        rejected['no_usable_values'] = rejected.get('no_usable_values', 0) + 1
        return None
    return row


FIELDS = ['model_year', 'manufacturer', 'make', 'carline', 'test_group', 'displacement_l', 'cylinders', 'rated_hp',
          'trans_type', 'trans_code', 'gears', 'drive', 'etw_lb', 'axle_ratio', 'nv_ratio']


def build(files, target):
    """files: [(model_year, name, Path, url)]. Builds target atomically; a failure keeps the old file."""
    temp = target.with_name('epa-test-cars-build-' + str(os.getpid()) + '.db')
    db = sqlite3.connect(temp)
    try:
        db.executescript('''CREATE TABLE test_cars(model_year INTEGER NOT NULL,manufacturer TEXT,make TEXT,carline TEXT NOT NULL,
            test_group TEXT,displacement_l REAL,cylinders REAL,rated_hp REAL,trans_type TEXT,trans_code TEXT,gears REAL,drive TEXT,
            etw_lb REAL,axle_ratio REAL,nv_ratio REAL,make_compact TEXT,manufacturer_compact TEXT,carline_compact TEXT,source_file TEXT NOT NULL,
            tests INTEGER NOT NULL);
            CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);''')
        sources, kept = [], {}
        for year, name, path, url in sorted(files):
            payload = Path(path).read_bytes()
            rejected, read = {}, 0
            for raw in table_rows(name, payload):
                read += 1
                row = normalise(raw, year, rejected)
                if row is None:
                    continue
                key = tuple(row[f] for f in FIELDS)
                if key in kept:
                    kept[key][1] += 1
                else:
                    kept[key] = [name, 1]
            if not read:
                raise ValueError('Empty file: ' + name)
            row_level = ('missing_carline_or_year', 'model_year_differs_from_file', 'no_usable_values')
            sources.append({'model_year': year, 'file': name, 'url': url, 'sha256': hashlib.sha256(payload).hexdigest(), 'rows': read,
                            'rows_rejected': {k: v for k, v in rejected.items() if k in row_level},
                            # Placeholders such as displacement 0.001 or 99.999 (electric), axle 0, N/V 999.
                            'values_outside_plausible_range': {k: v for k, v in rejected.items() if k not in row_level}})
        db.executemany('INSERT INTO test_cars VALUES(' + ','.join('?' * 20) + ')',
                       [(*key, compact(key[2]), compact(key[1]), compact(key[3]), name, n) for key, (name, n) in kept.items()])
        db.executescript('CREATE INDEX by_group ON test_cars(model_year,test_group); CREATE INDEX by_carline ON test_cars(model_year,carline_compact);')
        years = sorted({s['model_year'] for s in sources})
        metadata = {'page': PAGE, 'sources': sources, 'model_years': [years[0], years[-1]] if years else None,
                    'source_rows': sum(s['rows'] for s in sources), 'configurations': len(kept),
                    'indexed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        db.execute('INSERT INTO metadata VALUES(?,?)', ('source', json.dumps(metadata)))
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


def main():
    cache = ROOT / 'operations/free-data/epa-test-cars'
    cache.mkdir(parents=True, exist_ok=True)
    files = []
    for year, url in sorted(URLS.items()):
        for u in [url, *EXTRA.get(year, [])]:
            name = u.rsplit('/', 1)[-1]
            path = cache / name
            if not path.exists() or '--refresh' in sys.argv:
                time.sleep(3)  # gentle on epa.gov
                with urlopen(Request(u, headers={'User-Agent': UA}), timeout=120) as r:
                    payload = r.read(MAX_BYTES + 1)
                if len(payload) > MAX_BYTES:
                    raise ValueError('Download size limit: ' + name)
                staged = path.with_suffix(path.suffix + '.download')
                staged.write_bytes(payload)
                os.replace(staged, path)
            files.append((year, name, path, u))
    target = ROOT / 'data/epa-test-cars.db'
    target.parent.mkdir(exist_ok=True)
    print(json.dumps(build(files, target), indent=2))


if __name__ == '__main__':
    main()

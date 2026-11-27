#!/usr/bin/env python3
"""Build data/nhtsa-complaints.db, mcp.vin's local copy of NHTSA's owner complaints, from the official flat file
(static.nhtsa.gov/odi/ffdd/cmpl/FLAT_CMPL.zip, about 380 MB zipped / 1.6 GB of text, updated daily).

Reports answer make/model/year complaint questions from this file the way NHTSA's complaintsByVehicle API answers
them (lib/nhtsa-local.mjs); the live API is only the fallback.

Only the fields the report uses are kept: complaint number, make, model, model year, crash, fire, injuries, deaths,
incident date, date received, components, product type and the complaint text. The flat file also carries the
complainant's city and state, part of the VIN, dealer details and (since 2026-04-30) the vehicle operator's name:
none of that is stored.

The flat file has one row per complaint, product and component. A complaint number (ODINO) received before
2002-12-15 can also cover several complaints by one person about several vehicles, each with its own text, so a
complaint here is one ODINO + text + make/model/year; its components are those of all the products it names, in file
order (CMPLID).

Usage: import-nhtsa-complaints.py --zip FLAT_CMPL.zip --out data/nhtsa-complaints.db [--last-modified '<HTTP date>']
       [--previous data/nhtsa-complaints.db] [--allow-shrink]
Atomic like the other importers; refuses a build with over 1% fewer complaints than the previous file."""
import argparse, datetime, email.utils, hashlib, io, json, os, re, sqlite3, zipfile
from pathlib import Path

FIELDS = 51
CMPLID, ODINO, MFR_NAME, MAKETXT, MODELTXT, YEARTXT, CRASH, FAILDATE, FIRE, INJURED, DEATHS, COMPDESC = range(12)
LDATE, CDESCR, PROD_TYPE = 16, 19, 45
SCHEMA_VERSION = 1


def norm(text):
    """Upper case and trimmed (NHTSA's API ignores case)."""
    return text.strip().upper()


def ymd(text):
    text = text.strip()
    return text if re.fullmatch(r'\d{8}', text) else None


def count(text):
    text = text.strip()
    return int(text) if text.isdigit() else 0


def rows_of(path):
    """Records of the archive; a record split over several lines by a line break in a text field is joined back."""
    with zipfile.ZipFile(path) as z:
        files = z.infolist()
        if len(files) != 1 or files[0].filename != 'FLAT_CMPL.txt' or files[0].file_size > 8_000_000_000:
            raise ValueError('Unexpected complaint archive layout')
        with z.open(files[0]) as raw:
            pending, start = None, 0
            for n, line in enumerate(io.TextIOWrapper(raw, encoding='utf-8', errors='strict', newline=''), 1):
                line = line.rstrip('\r\n')
                if pending is None:
                    if not line:
                        continue
                    pending, start = line, n
                else:
                    pending += '\n' + line
                p = pending.split('\t')
                if len(p) < FIELDS:
                    if n - start > 50:
                        raise ValueError(f'Unexpected complaint schema at line {start}')
                    continue
                if len(p) != FIELDS or not p[CMPLID].strip().isdigit() or not p[ODINO].strip().isdigit():
                    raise ValueError(f'Unexpected complaint schema at line {start}')
                pending = None
                yield p
            if pending is not None:
                raise ValueError(f'Unexpected complaint schema at line {start} (incomplete last record)')


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def previous_counts(path):
    if not path or not Path(path).exists():
        return None
    try:
        db = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
        meta = json.loads(db.execute("SELECT value FROM metadata WHERE key='source'").fetchone()[0])
        db.close()
        return meta.get('counts')
    except Exception:
        return None


def build(zip_path, target, last_modified=None, previous=None, allow_shrink=False):
    target = Path(target)
    temp = target.with_name(f'.{target.name}.build-{os.getpid()}')
    stage = target.with_name(f'.{target.name}.stage-{os.getpid()}')
    temp.unlink(missing_ok=True)
    stage.unlink(missing_ok=True)
    db = sqlite3.connect(temp)
    try:
        # Rows are staged in a separate file (deleted afterwards), so the result needs no VACUUM.
        db.execute('ATTACH DATABASE ? AS s', (str(stage),))
        db.executescript('''PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA s.journal_mode=OFF; PRAGMA s.synchronous=OFF;
            PRAGMA cache_size=-200000; PRAGMA s.cache_size=-200000;
            CREATE TABLE s.stage(make TEXT, model TEXT, year INTEGER, odi INTEGER, cmplid INTEGER, summary TEXT, crash INTEGER,
              fire INTEGER, injured INTEGER, deaths INTEGER, incident TEXT, received TEXT, component TEXT, prod_type TEXT);
            CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT);''')
        rows, latest, batch = 0, '', []
        for p in rows_of(zip_path):
            rows += 1
            make, model, year = norm(p[MAKETXT]), norm(p[MODELTXT]), p[YEARTXT].strip()
            if not make or not model or not year.isdigit():
                continue
            received = ymd(p[LDATE])
            if received:
                latest = max(latest, received)
            batch.append((make, model, int(year), int(p[ODINO]), int(p[CMPLID]), p[CDESCR], 1 if p[CRASH].strip() == 'Y' else 0,
                          1 if p[FIRE].strip() == 'Y' else 0, count(p[INJURED]), count(p[DEATHS]), ymd(p[FAILDATE]), received,
                          p[COMPDESC].strip(), p[PROD_TYPE].strip()))
            if len(batch) >= 50_000:
                db.executemany('INSERT INTO s.stage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', batch)
                batch = []
        if batch:
            db.executemany('INSERT INTO s.stage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', batch)
        if not rows:
            raise ValueError('Empty complaint archive')
        # One complaint = ODINO + text + make/model/year. Its components are those of every product the complaint
        # names (the API lists them all: a gas can's EQUIPMENT row sits under the can's maker, not the car's), in file
        # order (CMPLID). Values that can differ between rows of one vehicle (old multi-vehicle complaints) are
        # combined: crash/fire if any row says so, the largest injury and death counts, the first row's dates.
        db.executescript('''CREATE TABLE complaints(make TEXT NOT NULL, model TEXT NOT NULL, year INTEGER NOT NULL,
              odi INTEGER NOT NULL, first_row INTEGER NOT NULL, crash INTEGER NOT NULL, fire INTEGER NOT NULL,
              injured INTEGER NOT NULL, deaths INTEGER NOT NULL, incident TEXT, received TEXT, components TEXT NOT NULL,
              prod_types TEXT NOT NULL, summary TEXT NOT NULL,
              PRIMARY KEY(make, model, year, odi, first_row)) WITHOUT ROWID;
            CREATE TABLE s.grouped AS SELECT * FROM complaints WHERE 0;
            CREATE INDEX s.stage_group ON stage(odi, summary, cmplid);''')
        cur = db.execute('SELECT make, model, year, odi, summary, cmplid, crash, fire, injured, deaths, incident, received, component, prod_type '
                         'FROM s.stage ORDER BY odi, summary, cmplid')
        out, group, complaints = [], None, 0
        insert = 'INSERT INTO s.grouped VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'

        def flush(g):
            nonlocal complaints
            components = json.dumps(g['components'])
            for (make, model, year), v in g['vehicles'].items():
                complaints += 1
                out.append((make, model, year, g['k'][0], v['first'], v['crash'], v['fire'], v['injured'], v['deaths'],
                            v['incident'], v['received'], components, ','.join(sorted(v['types'])), g['k'][1]))

        for r in cur:
            k = (r[3], r[4])
            if group is None or group['k'] != k:
                if group:
                    flush(group)
                group = {'k': k, 'components': [], 'vehicles': {}}
            if r[12] and r[12] not in group['components']:
                group['components'].append(r[12])
            v = group['vehicles'].get(r[:3])
            if v is None:
                v = group['vehicles'][r[:3]] = {'first': r[5], 'crash': 0, 'fire': 0, 'injured': 0, 'deaths': 0, 'incident': r[10],
                                                'received': r[11], 'types': set()}
            v['crash'] |= r[6]
            v['fire'] |= r[7]
            v['injured'] = max(v['injured'], r[8])
            v['deaths'] = max(v['deaths'], r[9])
            if r[13]:
                v['types'].add(r[13])
            if len(out) >= 50_000:
                db.executemany(insert, out)
                out.clear()
        if group:
            flush(group)
        db.executemany(insert, out)
        # Stored in key order, so the rows of one make/model/year sit together in the file.
        db.execute('INSERT INTO complaints SELECT * FROM s.grouped ORDER BY make, model, year, odi, first_row')
        db.commit()
        db.execute('DETACH DATABASE s')
        stage.unlink(missing_ok=True)
        counts = {'source_rows': rows, 'complaints': complaints,
                  'complaint_numbers': db.execute('SELECT COUNT(DISTINCT odi) FROM complaints').fetchone()[0],
                  'make_model_years': db.execute('SELECT COUNT(*) FROM (SELECT DISTINCT make, model, year FROM complaints)').fetchone()[0]}
        prev = previous_counts(previous)
        if prev and not allow_shrink and prev.get('complaints') and counts['complaints'] < prev['complaints'] * 0.99:
            raise ValueError(f"complaints fell from {prev['complaints']} to {counts['complaints']}: refusing to replace the previous file")
        lm = email.utils.parsedate_to_datetime(last_modified).astimezone(datetime.timezone.utc).isoformat() if last_modified else None
        meta = {'schema': SCHEMA_VERSION, 'dataset': 'nhtsa_complaints',
                'sources': [{'file': Path(zip_path).name, 'sha256': sha256(zip_path), 'url': 'https://static.nhtsa.gov/odi/ffdd/cmpl/FLAT_CMPL.zip'}],
                'source_last_modified': lm, 'latest_received_date': f'{latest[:4]}-{latest[4:6]}-{latest[6:]}' if latest else None,
                'built_at': datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat(), 'counts': counts}
        db.execute('INSERT INTO metadata VALUES(?,?)', ('source', json.dumps(meta)))
        db.commit()
        if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise ValueError('Integrity failure')
        db.close()
        os.replace(temp, target)
        return meta
    except BaseException:
        db.close()
        temp.unlink(missing_ok=True)
        stage.unlink(missing_ok=True)
        raise


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--zip', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--last-modified')
    ap.add_argument('--previous')
    ap.add_argument('--allow-shrink', action='store_true')
    a = ap.parse_args(argv)
    print(json.dumps(build(a.zip, a.out, a.last_modified, a.previous or a.out, a.allow_shrink), indent=1))


if __name__ == '__main__':
    main()

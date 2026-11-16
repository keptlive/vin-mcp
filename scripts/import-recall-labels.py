#!/usr/bin/env python3
"""Index the model names NHTSA files recall campaigns under, from the official recall flat files.

Reports look up campaigns live (recallsByVehicle) by the exact vPIC model name. NHTSA often files
campaigns under other names for the same vehicle (CR-V HYBRID, F150, PRIUS PRIME, C 300 for C-Class).
/products/vehicle/models?issueType=r lists only part of a make's names (checked 2026-11-16), so this
index supplies the full list of names per make and model year. It holds names and campaign counts
only; campaign details still come from the live API."""
from pathlib import Path
from urllib.request import urlopen
import datetime, hashlib, io, json, os, re, sqlite3, sys, zipfile

ROOT = Path(__file__).resolve().parent.parent
URLS = {'FLAT_RCL_PRE_2010.zip': 'https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_PRE_2010.zip',
        'FLAT_RCL_POST_2010.zip': 'https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_POST_2010.zip'}
FIELDS = 29  # RCL.txt: RECORD_ID, CAMPNO, MAKETXT, MODELTXT, YEARTXT, ... PARK_OUTSIDE
MIN_YEAR, MAX_YEAR = 1980, 2100


def compact(text):
    """Letters and digits only, upper case: 'F-150' and 'F150' both become 'F150'. Must match lib/recall-labels.mjs."""
    return ''.join(re.findall(r'[A-Z0-9]+', text.upper()))


def build(archives, target, urls=URLS):
    """archives: {member zip name: Path}. Builds target atomically; a failure leaves the old file in place."""
    temp = target.with_name('recall-labels-build-' + str(os.getpid()) + '.db')
    db = sqlite3.connect(temp)
    try:
        db.executescript('''CREATE TABLE labels(make TEXT NOT NULL,model TEXT NOT NULL,year INTEGER NOT NULL,
            campaigns INTEGER NOT NULL,compact TEXT NOT NULL,PRIMARY KEY(make,model,year));
            CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);''')
        seen = {}
        sources, rows, skipped_fragments, unknown_year, latest = [], 0, 0, 0, ''
        for name, path in sorted(archives.items()):
            payload = Path(path).read_bytes()
            with zipfile.ZipFile(io.BytesIO(payload)) as z:
                files = z.infolist()
                if len(files) != 1 or files[0].filename != name.replace('.zip', '.txt') or files[0].file_size > 1_500_000_000:
                    raise ValueError('Unexpected recall archive layout')
                with z.open(files[0]) as raw:
                    for line in io.TextIOWrapper(raw, encoding='utf-8', errors='strict', newline=''):
                        line = line.rstrip('\r\n')
                        if not line:
                            continue
                        p = line.split('\t')
                        if len(p) != FIELDS:
                            # A line break inside a free-text field leaves a short fragment line.
                            if len(p) < FIELDS and not re.fullmatch(r'\d+', p[0]) or len(p) == 1:
                                skipped_fragments += 1
                                continue
                            raise ValueError('Unexpected recall schema')
                        if not re.fullmatch(r'\d+', p[0]) or not re.fullmatch(r'[0-9A-Z]{9}', p[1].strip()):
                            raise ValueError('Unexpected recall schema')
                        rows += 1
                        make, model, year = p[2].strip().upper(), p[3].strip().upper(), p[4].strip()
                        if not year.isdigit() or not MIN_YEAR <= int(year) <= MAX_YEAR:
                            unknown_year += 1
                            continue
                        if not make or not model or not compact(model):
                            continue
                        seen.setdefault((make, model, int(year)), set()).add(p[1].strip())
                        latest = max(latest, p[15].strip()) if re.fullmatch(r'\d{8}', p[15].strip()) else latest
            sources.append({'file': name, 'url': urls.get(name), 'sha256': hashlib.sha256(payload).hexdigest(),
                            'downloaded_at': datetime.datetime.fromtimestamp(Path(path).stat().st_mtime, datetime.timezone.utc).isoformat()})
        if not seen:
            raise ValueError('Empty recall archive')
        db.executemany('INSERT INTO labels VALUES(?,?,?,?,?)',
                       [(mk, md, y, len(c), compact(md)) for (mk, md, y), c in sorted(seen.items())])
        db.executescript('CREATE INDEX make_year ON labels(make,year); CREATE INDEX make_compact ON labels(make,compact);')
        metadata = {'sources': sources, 'source_rows': rows, 'labels': len(seen), 'skipped_fragment_lines': skipped_fragments,
                    'rows_without_model_year': unknown_year,
                    'latest_report_date': f'{latest[:4]}-{latest[4:6]}-{latest[6:]}' if latest else None,
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
    cache = ROOT / 'operations/free-data'
    cache.mkdir(parents=True, exist_ok=True)
    target = ROOT / 'data/recall-labels.db'
    target.parent.mkdir(exist_ok=True)
    archives = {}
    for name, url in URLS.items():
        archive = cache / name
        if not archive.exists() or '--refresh' in sys.argv:
            with urlopen(url, timeout=120) as r:
                payload = r.read(60_000_001)
            if len(payload) > 60_000_000:
                raise ValueError('Download size limit')
            staged = archive.with_suffix('.download')
            staged.write_bytes(payload)
            with zipfile.ZipFile(staged) as z:
                if z.testzip() is not None:
                    raise ValueError('Invalid archive')
            os.replace(staged, archive)
        archives[name] = archive
    print(json.dumps(build(archives, target), indent=2))


if __name__ == '__main__':
    main()

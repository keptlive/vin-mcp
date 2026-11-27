#!/usr/bin/env python3
"""Index the model names NHTSA files recall campaigns under, from the official recall flat files.

Reports look up campaigns live (recallsByVehicle) by the exact vPIC model name. NHTSA often files
campaigns under other names for the same vehicle (CR-V HYBRID, F150, PRIUS PRIME, C 300 for C-Class).
/products/vehicle/models?issueType=r lists only part of a make's names (checked 2026-11-16), so this
index supplies the full list of names per make and model year, with the campaign numbers filed under
each name. Campaign details still come from the live API; the numbers let reports point out campaigns
the live API does not return under the same name (it files some under other text, e.g. GLE350 for
the flat file's GLE 350).

It also keeps, per campaign row (campaign + make + model + model year), the manufacturer's build-date
range (BGMAN/ENDMAN) and the campaign's potential units affected (POTAFF), validated: a date must be a
real YYYYMMDD calendar date between 1950 and next year, and a begin date after its end date drops both.
Blank or invalid values stay NULL (unknown), never guessed."""
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


def build_date(text):
    """'20111017' -> ('2011-10-17', 'ok'); blank -> (None, 'blank'); anything else -> (None, 'invalid')."""
    text = text.strip()
    if not text:
        return None, 'blank'
    if not re.fullmatch(r'\d{8}', text):
        return None, 'invalid'
    try:
        d = datetime.date(int(text[:4]), int(text[4:6]), int(text[6:]))
    except ValueError:
        return None, 'invalid'
    if not 1950 <= d.year <= datetime.date.today().year + 1:
        return None, 'invalid'
    return d.isoformat(), 'ok'


def build(archives, target, urls=URLS):
    """archives: {member zip name: Path}. Builds target atomically; a failure leaves the old file in place."""
    temp = target.with_name('recall-labels-build-' + str(os.getpid()) + '.db')
    db = sqlite3.connect(temp)
    try:
        db.executescript('''CREATE TABLE labels(make TEXT NOT NULL,model TEXT NOT NULL,year INTEGER NOT NULL,
            campaigns INTEGER NOT NULL,compact TEXT NOT NULL,campaign_numbers TEXT NOT NULL,PRIMARY KEY(make,model,year));
            CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
            CREATE TABLE campaign_builds(campaign TEXT NOT NULL,make_compact TEXT NOT NULL,model_compact TEXT NOT NULL,
            year INTEGER NOT NULL,built_from TEXT,built_to TEXT,distinct_ranges INTEGER NOT NULL,
            PRIMARY KEY(campaign,make_compact,model_compact,year)) WITHOUT ROWID;
            CREATE TABLE campaign_units(campaign TEXT PRIMARY KEY,units_affected INTEGER NOT NULL) WITHOUT ROWID;''')
        seen, builds, units = {}, {}, {}
        dates = {'ok': 0, 'blank': 0, 'invalid': 0, 'reversed': 0}
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
                        campaign = p[1].strip()
                        seen.setdefault((make, model, int(year)), set()).add(campaign)
                        (begin, b_state), (end, e_state) = build_date(p[8]), build_date(p[9])
                        if begin and end and begin > end:
                            begin = end = None
                            dates['reversed'] += 1
                        else:
                            for state in (b_state, e_state):
                                dates[state] += 1
                        # Labels that differ only in punctuation or spacing (F-150, F150) are one key.
                        ranges = builds.setdefault((campaign, compact(make), compact(model), int(year)), set())
                        if begin or end:
                            ranges.add((begin, end))
                        if re.fullmatch(r'\d{1,9}', p[11].strip()) and int(p[11]) > 0:
                            units.setdefault(campaign, set()).add(int(p[11]))
                        latest = max(latest, p[15].strip()) if re.fullmatch(r'\d{8}', p[15].strip()) else latest
            sources.append({'file': name, 'url': urls.get(name), 'sha256': hashlib.sha256(payload).hexdigest(),
                            'downloaded_at': datetime.datetime.fromtimestamp(Path(path).stat().st_mtime, datetime.timezone.utc).isoformat()})
        if not seen:
            raise ValueError('Empty recall archive')
        db.executemany('INSERT INTO labels VALUES(?,?,?,?,?,?)',
                       [(mk, md, y, len(c), compact(md), ' '.join(sorted(c))) for (mk, md, y), c in sorted(seen.items())])
        db.executescript('CREATE INDEX make_year ON labels(make,year); CREATE INDEX make_compact ON labels(make,compact);')
        build_rows = []
        for (c, mk, md, y), ranges in sorted(builds.items()):
            begins = [b for b, _ in ranges if b]
            ends = [e for _, e in ranges if e]
            if ranges:
                build_rows.append((c, mk, md, y, min(begins) if begins else None, max(ends) if ends else None, len(ranges)))
        db.executemany('INSERT INTO campaign_builds VALUES(?,?,?,?,?,?,?)', build_rows)
        db.executemany('INSERT INTO campaign_units VALUES(?,?)', sorted((c, next(iter(u))) for c, u in units.items() if len(u) == 1))
        metadata = {'sources': sources, 'source_rows': rows, 'labels': len(seen), 'skipped_fragment_lines': skipped_fragments,
                    'rows_without_model_year': unknown_year,
                    'campaign_rows': len(builds), 'campaign_rows_with_build_dates': len(build_rows),
                    'campaign_rows_with_several_ranges': sum(1 for r in build_rows if r[6] > 1),
                    'build_date_values': dates, 'campaigns_with_conflicting_units': sum(1 for u in units.values() if len(u) > 1),
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
    """No arguments: download into operations/free-data (or reuse it) and build data/recall-labels.db.
    --pre/--post/--out: build from archives already downloaded (scripts/nhtsa-refresh.sh)."""
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--pre')
    ap.add_argument('--post')
    ap.add_argument('--out')
    ap.add_argument('--refresh', action='store_true', help='download again even when a cached archive exists')
    a = ap.parse_args()
    if a.pre or a.post or a.out:
        if not (a.pre and a.post and a.out):
            ap.error('--pre, --post and --out go together')
        print(json.dumps(build({'FLAT_RCL_PRE_2010.zip': Path(a.pre), 'FLAT_RCL_POST_2010.zip': Path(a.post)}, Path(a.out)), indent=2))
        return
    cache = ROOT / 'operations/free-data'
    cache.mkdir(parents=True, exist_ok=True)
    target = ROOT / 'data/recall-labels.db'
    target.parent.mkdir(exist_ok=True)
    archives = {}
    for name, url in URLS.items():
        archive = cache / name
        if not archive.exists() or a.refresh:
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

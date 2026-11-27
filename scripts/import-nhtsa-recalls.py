#!/usr/bin/env python3
"""Build data/nhtsa-recalls.db, mcp.vin's local copy of NHTSA's recall campaigns, from the official flat files
(static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_PRE_2010.zip and FLAT_RCL_POST_2010.zip, updated daily).

Reports answer make/model/year recall questions from this file the way NHTSA's recallsByVehicle API answers them
(lib/nhtsa-local.mjs); the live API is only the fallback. The flat files carry one row per campaign, vehicle and
recalled part; the campaign text (defect, consequence, remedy, notes, dates, advisories) is the same on every row
of a campaign (checked 2026-11-27: 0 of 30,494 campaigns differ), so it is stored once per campaign, and the
vehicle rows keep only make, model, model year, campaign, component and the row's manufacturer text.

Usage: import-nhtsa-recalls.py --pre FLAT_RCL_PRE_2010.zip --post FLAT_RCL_POST_2010.zip --out data/nhtsa-recalls.db
       [--last-modified 'Thu, 26 Nov 2026 08:04:00 GMT'] [--previous data/nhtsa-recalls.db]
The build is atomic (a temp file renamed over --out) and refuses a result that lost more than 1% of the previous
file's campaigns or vehicle rows (--allow-shrink overrides)."""
import argparse, datetime, email.utils, hashlib, io, json, os, re, sqlite3, sys, zipfile
from pathlib import Path

FIELDS = 29
NAMES = ('RECORD_ID CAMPNO MAKETXT MODELTXT YEARTXT MFGCAMPNO COMPNAME MFGNAME BGMAN ENDMAN RCLTYPECD POTAFF ODATE '
         'INFLUENCED_BY MFGTXT RCDATE DATEA RPNO FMVSS DESC_DEFECT CONEQUENCE_DEFECT CORRECTIVE_ACTION NOTES '
         'RCL_CMPT_ID MFR_COMP_NAME MFR_COMP_DESC MFR_COMP_PTNO DO_NOT_DRIVE PARK_OUTSIDE').split()
F = {n: i for i, n in enumerate(NAMES)}
SCHEMA_VERSION = 1


def norm(text):
    """Upper case, trimmed, inner whitespace collapsed: the key the lookup compares (NHTSA's API ignores case)."""
    return ' '.join(text.upper().split())


def iso(text):
    text = text.strip()
    if not re.fullmatch(r'\d{8}', text):
        return None
    try:
        return datetime.date(int(text[:4]), int(text[4:6]), int(text[6:])).isoformat()
    except ValueError:
        return None


def rows_of(path, member):
    with zipfile.ZipFile(path) as z:
        files = z.infolist()
        if len(files) != 1 or files[0].filename != member or files[0].file_size > 2_000_000_000:
            raise ValueError(f'Unexpected recall archive layout in {path}')
        with z.open(files[0]) as raw:
            for n, line in enumerate(io.TextIOWrapper(raw, encoding='utf-8', errors='strict', newline=''), 1):
                line = line.rstrip('\r\n')
                if not line:
                    continue
                p = line.split('\t')
                if len(p) != FIELDS or not p[0].isdigit() or not re.fullmatch(r'[0-9A-Z]{9}', p[1].strip()):
                    raise ValueError(f'Unexpected recall schema at {member}:{n}')
                yield p


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


def build(pre, post, target, last_modified=None, previous=None, allow_shrink=False):
    target = Path(target)
    temp = target.with_name(f'.{target.name}.build-{os.getpid()}')
    temp.unlink(missing_ok=True)
    db = sqlite3.connect(temp)
    try:
        db.executescript('''PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
            CREATE TABLE campaigns(campaign TEXT PRIMARY KEY, manufacturer TEXT, mfr_campaign TEXT, type TEXT,
              summary TEXT, consequence TEXT, remedy TEXT, notes TEXT, report_received TEXT, record_created TEXT,
              owners_notified TEXT, influenced_by TEXT, do_not_drive INTEGER, park_outside INTEGER) WITHOUT ROWID;
            CREATE TABLE vehicles(make TEXT NOT NULL, model TEXT NOT NULL, year INTEGER NOT NULL, campaign TEXT NOT NULL,
              component TEXT NOT NULL, first_record INTEGER NOT NULL, mfr_text TEXT,
              PRIMARY KEY(make, model, year, campaign, component)) WITHOUT ROWID;
            CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT);''')
        campaigns, vehicles = {}, {}
        rows, types = 0, {}
        latest = ''
        for path, member in ((pre, 'FLAT_RCL_PRE_2010.txt'), (post, 'FLAT_RCL_POST_2010.txt')):
            for p in rows_of(path, member):
                rows += 1
                camp = p[F['CAMPNO']].strip()
                t = p[F['RCLTYPECD']].strip()
                types[t] = types.get(t, 0) + 1
                yes = lambda v: 1 if v.strip() == 'Yes' else (0 if v.strip() == 'No' else None)
                c = (p[F['MFGNAME']].strip(), p[F['MFGCAMPNO']].strip(), t, p[F['DESC_DEFECT']], p[F['CONEQUENCE_DEFECT']],
                     p[F['CORRECTIVE_ACTION']], p[F['NOTES']], iso(p[F['RCDATE']]), iso(p[F['DATEA']]), iso(p[F['ODATE']]),
                     p[F['INFLUENCED_BY']].strip(), yes(p[F['DO_NOT_DRIVE']]), yes(p[F['PARK_OUTSIDE']]))
                old = campaigns.get(camp)
                if old is not None and old != c:
                    raise ValueError(f'Campaign text differs between rows of {camp}')
                campaigns[camp] = c
                rc = p[F['RCDATE']].strip()
                if re.fullmatch(r'\d{8}', rc):
                    latest = max(latest, rc)
                make, model, year = norm(p[F['MAKETXT']]), norm(p[F['MODELTXT']]), p[F['YEARTXT']].strip()
                if not make or not model or not year.isdigit():
                    continue
                key = (make, model, int(year), camp, p[F['COMPNAME']].strip())
                rid = int(p[F['RECORD_ID']])
                prev = vehicles.get(key)
                if prev is None or rid < prev[0]:
                    vehicles[key] = (rid, p[F['MFGTXT']].strip())
        if not campaigns or not vehicles:
            raise ValueError('Empty recall archives')
        db.executemany('INSERT INTO campaigns VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', ((k, *v) for k, v in sorted(campaigns.items())))
        db.executemany('INSERT INTO vehicles VALUES(?,?,?,?,?,?,?)', ((*k, *v) for k, v in sorted(vehicles.items())))
        counts = {'source_rows': rows, 'campaigns': len(campaigns), 'vehicle_rows': len(vehicles),
                  'make_model_years': db.execute('SELECT COUNT(*) FROM (SELECT DISTINCT make, model, year FROM vehicles)').fetchone()[0],
                  'campaign_types': types}
        prev = previous_counts(previous)
        if prev and not allow_shrink:
            for k in ('campaigns', 'vehicle_rows'):
                if prev.get(k) and counts[k] < prev[k] * 0.99:
                    raise ValueError(f'{k} fell from {prev[k]} to {counts[k]}: refusing to replace the previous file')
        lm = email.utils.parsedate_to_datetime(last_modified).astimezone(datetime.timezone.utc).isoformat() if last_modified else None
        meta = {'schema': SCHEMA_VERSION, 'dataset': 'nhtsa_recalls',
                'sources': [{'file': Path(x).name, 'sha256': sha256(x), 'url': f'https://static.nhtsa.gov/odi/ffdd/rcl/{Path(x).name}'} for x in (pre, post)],
                'source_last_modified': lm, 'latest_report_date': iso(latest) if latest else None,
                'built_at': datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat(), 'counts': counts}
        db.execute('INSERT INTO metadata VALUES(?,?)', ('source', json.dumps(meta)))
        db.commit()
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('Integrity failure')
        db.execute('VACUUM')
        db.close()
        os.replace(temp, target)
        return meta
    except BaseException:
        db.close()
        temp.unlink(missing_ok=True)
        raise


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--pre', required=True)
    ap.add_argument('--post', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--last-modified', help="the files' HTTP Last-Modified (the later of the two)")
    ap.add_argument('--previous', help='file whose counts the new build must not fall below (default: --out)')
    ap.add_argument('--allow-shrink', action='store_true')
    a = ap.parse_args(argv)
    meta = build(a.pre, a.post, a.out, a.last_modified, a.previous or a.out, a.allow_shrink)
    print(json.dumps(meta, indent=1))


if __name__ == '__main__':
    main()

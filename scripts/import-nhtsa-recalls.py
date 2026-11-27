#!/usr/bin/env python3
"""Build data/nhtsa-recalls.db, mcp.vin's local copy of NHTSA's recall campaigns, from the official flat files
(static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_PRE_2010.zip and FLAT_RCL_POST_2010.zip, updated daily).

Reports answer make/model/year recall questions from this file the way NHTSA's recallsByVehicle API answers them
(lib/nhtsa-local.mjs); the live API is only the fallback. The flat files carry one row per campaign, vehicle and
recalled part; the campaign text (defect, consequence, remedy, notes, dates, advisories) is the same on every row
of a campaign (checked 2026-11-27: 0 of 30,494 campaigns differ), so it is stored once per campaign, and the
vehicle rows keep only make, model, model year, campaign, component and the row's manufacturer text (the first
recall record number of each vehicle and component is kept for ordering).

The values only NHTSA's API has (the over-the-air flag, the one component the API names per campaign, its report
date, the texts' line breaks) come from --campaign-sheets, the state file of scripts/harvest-nhtsa-recall-campaigns.py,
and are used only where they still fit the flat files (merge_sheets); without it those stay as the flat files say.

Usage: import-nhtsa-recalls.py --pre FLAT_RCL_PRE_2010.zip --post FLAT_RCL_POST_2010.zip --out data/nhtsa-recalls.db
       [--campaign-sheets recall-campaigns.db] [--last-modified 'Thu, 26 Nov 2026 08:04:00 GMT'] [--previous data/nhtsa-recalls.db]
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
    """Records of one archive. A line break inside a free-text field splits a record over several lines: the parts are
    joined back (with the line break) until the record has all its fields; anything else is a schema error."""
    with zipfile.ZipFile(path) as z:
        files = z.infolist()
        if len(files) != 1 or files[0].filename != member or files[0].file_size > 2_000_000_000:
            raise ValueError(f'Unexpected recall archive layout in {path}')
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
                        raise ValueError(f'Unexpected recall schema at {member}:{start}')
                    continue
                if len(p) != FIELDS or not p[0].isdigit() or not re.fullmatch(r'[0-9A-Z]{9}', p[1].strip()):
                    raise ValueError(f'Unexpected recall schema at {member}:{start}')
                pending = None
                yield p
            if pending is not None:
                raise ValueError(f'Unexpected recall schema at {member}:{start} (incomplete last record)')


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


def ws(text):
    return ' '.join(str(text or '').split())


def api_date(text):
    """dd/mm/yyyy (the API's report date) -> ISO, or None."""
    m = re.fullmatch(r'(\d{2})/(\d{2})/(\d{4})', str(text or '').strip())
    if not m:
        return None
    try:
        return datetime.date(int(m[3]), int(m[2]), int(m[1])).isoformat()
    except ValueError:
        return None


def merge_sheets(path, campaigns, comps_by_campaign, vehicle_keys):
    """API values per campaign from the campaign crawl, each kept only where it still fits the flat files:
      - component: the API's one component when the flat files recall it in that campaign (else the flat pick);
        per-vehicle components only for campaigns where the API names several;
      - over-the-air flag: as the API says (null for campaign types the API gives none);
      - report date: the API's when within 3 days of the flat file's (it is one day later on ~6% of campaigns);
      - texts: the API's when they differ from the flat files' only in whitespace (line breaks).
    Returns ({campaign: (api_component, ota, api_report_received, texts)}, [(campaign, make, model, year, component)], stats)."""
    db = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    out, per_vehicle = {}, []
    st = {'campaigns_with_sheet': 0, 'api_absent': 0, 'ota_known': 0, 'ota_true': 0, 'component_from_api': 0,
          'component_api_not_in_flat': 0, 'vehicle_component_rows': 0, 'date_from_api': 0, 'date_api_differs': 0,
          'date_api_too_far': 0, 'texts_from_api': 0, 'texts_api_differ': 0, 'inconsistent_sheets': 0}
    last = None
    for row in db.execute("SELECT campaign, status, component, vehicle_components, ota, report_date, summary, consequence, remedy, notes, "
                          "consistent, fetched_at FROM campaigns WHERE status IN ('ok', 'absent')"):
        camp, status, comp, vcomps, ota, rdate, *texts, consistent, fetched = row
        if camp not in campaigns:
            continue
        last = max(last or '', fetched or '')
        if status == 'absent':
            st['api_absent'] += 1
            continue
        st['campaigns_with_sheet'] += 1
        st['inconsistent_sheets'] += 0 if consistent else 1
        flat = campaigns[camp][1]
        flat_comps = comps_by_campaign.get(camp, set())
        api_comp = comp.strip() if isinstance(comp, str) and comp.strip() in flat_comps else None
        st['component_from_api' if api_comp else 'component_api_not_in_flat'] += 1 if comp else 0
        if vcomps:
            for key, c in json.loads(vcomps).items():
                make, model, year = key.split('|')
                k = (norm(make), norm(model), int(year) if year.isdigit() else None)
                if c and str(c).strip() in flat_comps and (k[0], k[1], k[2], camp) in vehicle_keys:
                    per_vehicle.append((camp, *k, str(c).strip()))
        if ota is not None:
            st['ota_known'] += 1
            st['ota_true'] += ota
        a, f = api_date(rdate), flat[7]
        use_date = None
        if a and f and a != f:
            st['date_api_differs'] += 1
            if abs((datetime.date.fromisoformat(a) - datetime.date.fromisoformat(f)).days) <= 3:
                use_date = a
            else:
                st['date_api_too_far'] += 1
        st['date_from_api'] += 1 if use_date else 0
        new_texts = []
        for api, old in zip(texts, flat[3:7]):
            if isinstance(api, str) and api != old and ws(api) == ws(old):
                new_texts.append(api)
                st['texts_from_api'] += 1
            else:
                if isinstance(api, str) and ws(api) != ws(old):
                    st['texts_api_differ'] += 1
                new_texts.append(old)
        out[camp] = (api_comp, ota, use_date, tuple(new_texts))
    db.close()
    st['vehicle_component_rows'] = len(per_vehicle)
    st['flat_campaigns_without_sheet'] = len(campaigns) - st['campaigns_with_sheet'] - st['api_absent']
    st['last_fetched_at'] = last
    return out, per_vehicle, st


def build(pre, post, target, last_modified=None, previous=None, allow_shrink=False, campaign_sheets=None):
    target = Path(target)
    temp = target.with_name(f'.{target.name}.build-{os.getpid()}')
    temp.unlink(missing_ok=True)
    db = sqlite3.connect(temp)
    try:
        db.executescript('''PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
            CREATE TABLE campaigns(campaign TEXT PRIMARY KEY, manufacturer TEXT, mfr_campaign TEXT, type TEXT,
              summary TEXT, consequence TEXT, remedy TEXT, notes TEXT, report_received TEXT, record_created TEXT,
              owners_notified TEXT, influenced_by TEXT, do_not_drive INTEGER, park_outside INTEGER,
              api_component TEXT, ota INTEGER, api_report_received TEXT) WITHOUT ROWID;
            CREATE TABLE api_components(campaign TEXT NOT NULL, make TEXT NOT NULL, model TEXT NOT NULL, year INTEGER NOT NULL,
              component TEXT NOT NULL, PRIMARY KEY(campaign, make, model, year)) WITHOUT ROWID;
            CREATE TABLE vehicles(make TEXT NOT NULL, model TEXT NOT NULL, year INTEGER NOT NULL, campaign TEXT NOT NULL,
              component TEXT NOT NULL, first_record INTEGER NOT NULL, mfr_text TEXT,
              PRIMARY KEY(make, model, year, campaign, component)) WITHOUT ROWID;
            CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT);''')
        campaigns, vehicles, differing, comps_by_campaign = {}, {}, set(), {}
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
                # The campaign text is the same on every row (checked 2026-11-27); should NHTSA ever differ, the
                # lowest record number's text is kept and the campaign is counted in the metadata.
                rid = int(p[F['RECORD_ID']])
                old = campaigns.get(camp)
                if old is None or rid < old[0]:
                    if old is not None and old[1] != c:
                        differing.add(camp)
                    campaigns[camp] = (rid, c)
                elif old[1] != c:
                    differing.add(camp)
                comps_by_campaign.setdefault(camp, set()).add(p[F['COMPNAME']].strip())
                rc = p[F['RCDATE']].strip()
                if re.fullmatch(r'\d{8}', rc):
                    latest = max(latest, rc)
                make, model, year = norm(p[F['MAKETXT']]), norm(p[F['MODELTXT']]), p[F['YEARTXT']].strip()
                if not make or not model or not year.isdigit():
                    continue
                key = (make, model, int(year), camp, p[F['COMPNAME']].strip())
                prev = vehicles.get(key)
                if prev is None or rid < prev[0]:
                    vehicles[key] = (rid, p[F['MFGTXT']].strip())
        if not campaigns or not vehicles:
            raise ValueError('Empty recall archives')
        sheets, per_vehicle, sheet_stats = ({}, [], None)
        if campaign_sheets:
            sheets, per_vehicle, sheet_stats = merge_sheets(campaign_sheets, campaigns, comps_by_campaign,
                                                            {(k[0], k[1], k[2], k[3]) for k in vehicles})

        def campaign_row(k, c):
            s = sheets.get(k)
            if not s:
                return (k, *c, None, None, None)
            comp, ota, date, texts = s
            return (k, *c[:3], *texts, *c[7:], comp, ota, date)
        db.executemany('INSERT INTO campaigns VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (campaign_row(k, v[1]) for k, v in sorted(campaigns.items())))
        db.executemany('INSERT INTO api_components VALUES(?,?,?,?,?)', sorted(set(per_vehicle)))
        db.executemany('INSERT INTO vehicles VALUES(?,?,?,?,?,?,?)', ((*k, *v) for k, v in sorted(vehicles.items())))
        counts = {'source_rows': rows, 'campaigns': len(campaigns), 'vehicle_rows': len(vehicles),
                  'make_model_years': db.execute('SELECT COUNT(*) FROM (SELECT DISTINCT make, model, year FROM vehicles)').fetchone()[0],
                  'campaign_types': types, 'campaigns_with_differing_rows': len(differing), 'campaign_sheets': sheet_stats}
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
    ap.add_argument('--campaign-sheets', help='state file of scripts/harvest-nhtsa-recall-campaigns.py (optional)')
    ap.add_argument('--previous', help='file whose counts the new build must not fall below (default: --out)')
    ap.add_argument('--allow-shrink', action='store_true')
    a = ap.parse_args(argv)
    meta = build(a.pre, a.post, a.out, a.last_modified, a.previous or a.out, a.allow_shrink, a.campaign_sheets)
    print(json.dumps(meta, indent=1))


if __name__ == '__main__':
    main()

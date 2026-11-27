#!/usr/bin/env python3
"""Gentle crawl of NHTSA's recall campaign API for the values the recall flat files do not carry.

Measured 2026-11-27 against live recallsByVehicle answers (docs/nhtsa-local-data.md), the API's recall rows have:
  - overTheAirUpdate, which no NHTSA bulk file carries (not the flat files, not DOT datahub dataset 6axg-epim);
  - ONE component per campaign, the same for every vehicle, where the flat files list every recalled component;
  - on about 6% of campaigns a report received date one day after the flat files' (and DOT datahub's) date;
  - the texts' original line breaks, which the flat files turn into spaces.
api.nhtsa.gov/recalls/campaignNumber answers all of these for a whole campaign in one request, so this crawl asks
once per campaign; scripts/import-nhtsa-recalls.py --campaign-sheets merges the answers into data/nhtsa-recalls.db,
and everything else still comes from the daily flat files.

State: SQLite file (--state), table `campaigns`, one row per campaign: status ok / absent (the API has no rows) /
failed, the parsed values (not the raw answer), the flat-file fingerprint it was fetched for, fetched_at (last clean
answer) and checked_at (last try). A failed fetch keeps the last clean answer.

A run fetches, one request at a time with --pause seconds between requests, newest report first:
  1. campaigns in the flat files with no clean answer yet, or whose flat-file values changed since;
  2. campaigns reported in the last --recent-days days, again once --recent-every-days have passed (new campaigns are
     the ones NHTSA still edits);
  3. --rolling of the campaigns checked longest ago (slowly re-checks everything else).
--max-requests caps the campaigns fetched in one run (the rest wait for the next run). Exit 0 when everything due was
fetched cleanly, 3 when stopped early or some campaigns never ran clean (both listed in --summary)."""
import argparse, datetime, hashlib, importlib.util, json, os, sqlite3, sys, time, urllib.error, urllib.request
from pathlib import Path

URL = 'https://api.nhtsa.gov/recalls/campaignNumber?campaignNumber={}'
USER_AGENT = 'nhtsa-data-sync/1.0'
RETRY_WAITS = (15, 60, 180)  # seconds before attempts 2, 3, 4 of one campaign
FINAL_PASS_WAIT = 300        # seconds before the last try of every campaign that failed in this run
VALUE_COLUMNS = ('rows', 'component', 'vehicle_components', 'ota', 'park_it', 'park_outside', 'report_date',
                 'manufacturer', 'summary', 'consequence', 'remedy', 'notes', 'consistent')


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def load_importer():
    spec = importlib.util.spec_from_file_location('import_nhtsa_recalls', Path(__file__).with_name('import-nhtsa-recalls.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def flat_campaigns(pre, post):
    """campaign -> (report received date, fingerprint of the campaign's flat-file values: texts, date, type and the
    set of recalled components). A changed fingerprint means NHTSA amended the campaign: fetch it again."""
    imp = load_importer()
    F = imp.F
    acc = {}
    for path, member in ((pre, 'FLAT_RCL_PRE_2010.txt'), (post, 'FLAT_RCL_POST_2010.txt')):
        for p in imp.rows_of(path, member):
            camp, rid = p[F['CAMPNO']].strip(), int(p[F['RECORD_ID']])
            values = (p[F['RCDATE']].strip(), p[F['RCLTYPECD']].strip(), p[F['DESC_DEFECT']], p[F['CONEQUENCE_DEFECT']],
                      p[F['CORRECTIVE_ACTION']], p[F['NOTES']])
            a = acc.get(camp)
            if a is None:
                acc[camp] = a = [rid, values, set()]
            elif rid < a[0]:
                a[0], a[1] = rid, values
            a[2].add(p[F['COMPNAME']].strip())
    return {camp: (imp.iso(v[0]) or '', hashlib.sha256(json.dumps([v, sorted(comps)]).encode()).hexdigest()[:20])
            for camp, (rid, v, comps) in acc.items()}


def open_state(file):
    db = sqlite3.connect(file)
    db.executescript('''CREATE TABLE IF NOT EXISTS campaigns(campaign TEXT PRIMARY KEY, status TEXT NOT NULL, flat_hash TEXT,
          fetched_at TEXT, checked_at TEXT, tries INTEGER NOT NULL DEFAULT 0, error TEXT, run TEXT,
          rows INTEGER, component TEXT, vehicle_components TEXT, ota INTEGER, park_it INTEGER, park_outside INTEGER,
          report_date TEXT, manufacturer TEXT, summary TEXT, consequence TEXT, remedy TEXT, notes TEXT, consistent INTEGER);
        CREATE TABLE IF NOT EXISTS runs(run TEXT PRIMARY KEY, started_at TEXT, finished_at TEXT, args TEXT, summary TEXT);''')
    return db


def flag(v):
    return 1 if v is True else (0 if v is False else None)


def sheet(body):
    """The values of one campaignNumber answer, or None when the API has no rows for the campaign."""
    rows = body.get('results') if isinstance(body, dict) else None
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        raise ValueError('unexpected body')
    if not rows:
        return None
    first = rows[0]
    comps = {}
    for r in rows:
        comps[f"{str(r.get('Make', '')).upper()}|{str(r.get('Model', '')).upper()}|{r.get('ModelYear', '')}"] = r.get('Component')
    distinct = set(comps.values())
    same = all(all(r.get(k) == first.get(k) for r in rows) for k in
               ('Summary', 'Consequence', 'Remedy', 'Notes', 'ReportReceivedDate', 'overTheAirUpdate', 'parkIt', 'parkOutSide'))
    return {'rows': len(rows), 'component': first.get('Component'),
            # Only when the API names different components for different vehicles of one campaign.
            'vehicle_components': json.dumps(comps, sort_keys=True) if len(distinct) > 1 else None,
            'ota': flag(first.get('overTheAirUpdate')), 'park_it': flag(first.get('parkIt')), 'park_outside': flag(first.get('parkOutSide')),
            'report_date': first.get('ReportReceivedDate'), 'manufacturer': first.get('Manufacturer'),
            'summary': first.get('Summary'), 'consequence': first.get('Consequence'), 'remedy': first.get('Remedy'),
            'notes': first.get('Notes'), 'consistent': int(same)}


class Harvester:
    def __init__(self, db, pause, timeout, run, log, opener=None):
        self.db, self.pause, self.timeout, self.run, self.log = db, pause, timeout, run, log
        self.opener = opener or urllib.request.urlopen
        self.requests = 0
        self.last = 0.0
        self.values_changed = 0

    def _get(self, campaign):
        wait = self.pause - (time.monotonic() - self.last)
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(URL.format(campaign), headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'})
        self.requests += 1
        try:
            with self.opener(req, timeout=self.timeout) as res:
                return res.status, res.read().decode('utf-8')
        except urllib.error.HTTPError as err:
            return err.code, ''
        finally:
            self.last = time.monotonic()

    def fetch(self, campaign, flat_hash, retries=True):
        """Fetch one campaign with back-off retries and store the outcome; True when it ran clean."""
        attempts = 1 + (len(RETRY_WAITS) if retries else 0)
        error = None
        for attempt in range(attempts):
            if attempt:
                time.sleep(RETRY_WAITS[attempt - 1])
            try:
                status, text = self._get(campaign)
                if status == 200:
                    self._store(campaign, flat_hash, sheet(json.loads(text)), attempt + 1)
                    return True
                error = f'HTTP {status}'
                if 400 <= status < 500 and status != 429 and attempt >= 1:
                    break
            except Exception as err:  # timeouts, resets, bad JSON, unexpected body
                error = f'{type(err).__name__}: {err}'
            self.log(f'retry {attempt + 1}/{attempts} {campaign}: {error}')
        self._fail(campaign, attempts, error)
        return False

    def _store(self, campaign, flat_hash, values, tries):
        cols = ', '.join(VALUE_COLUMNS)
        old = self.db.execute(f'SELECT status, {cols} FROM campaigns WHERE campaign=?', (campaign,)).fetchone()
        status = 'ok' if values else 'absent'
        vals = tuple((values or {}).get(c) for c in VALUE_COLUMNS)
        if old is None or old[0] != status or tuple(old[1:]) != vals:
            self.values_changed += 1
        t = now()
        self.db.execute(f'INSERT OR REPLACE INTO campaigns(campaign, status, flat_hash, fetched_at, checked_at, tries, error, run, {cols}) '
                        f'VALUES(?,?,?,?,?,?,?,?,{",".join("?" * len(VALUE_COLUMNS))})',
                        (campaign, status, flat_hash, t, t, tries, None, self.run, *vals))
        self.db.commit()

    def _fail(self, campaign, tries, error):
        old = self.db.execute('SELECT status FROM campaigns WHERE campaign=?', (campaign,)).fetchone()
        if old and old[0] in ('ok', 'absent'):
            # Keep the last clean answer (and the fingerprint it was fetched for, so a changed campaign is retried).
            self.db.execute('UPDATE campaigns SET checked_at=?, error=?, tries=tries+? WHERE campaign=?', (now(), error, tries, campaign))
        else:
            self.db.execute('INSERT OR REPLACE INTO campaigns(campaign, status, checked_at, tries, error, run) VALUES(?,?,?,?,?,?)',
                            (campaign, 'failed', now(), tries, error, self.run))
        self.db.commit()


def due(db, flat, today, recent_days=120, recent_every_days=14, rolling=0):
    """[(campaign, flat_hash, reason)] in fetch order: missing/changed first, then recent re-checks, then rolling."""
    known = {r[0]: r[1:] for r in db.execute('SELECT campaign, status, flat_hash, fetched_at, checked_at FROM campaigns')}
    recent_from = (today - datetime.timedelta(days=recent_days)).isoformat()
    recheck_before = (datetime.datetime.combine(today, datetime.time()) - datetime.timedelta(days=recent_every_days)).strftime('%Y-%m-%dT%H:%M:%SZ')
    first, recent, rest = [], [], []
    for camp, (rdate, h) in flat.items():
        k = known.get(camp)
        if k is None or k[0] == 'failed':
            first.append((rdate, camp, h, 'missing'))
        elif k[1] != h:
            first.append((rdate, camp, h, 'changed'))
        elif rdate >= recent_from and (k[3] or '') < recheck_before:
            recent.append((rdate, camp, h, 'recent'))
        else:
            rest.append((k[3] or '', camp, h, 'rolling'))
    first.sort(reverse=True)
    recent.sort(reverse=True)
    rest.sort()
    return [(c, h, why) for _, c, h, why in first + recent + rest[:max(0, rolling)]]


def harvest(db, harvester, work, max_requests=0, log=print, stop_file=None):
    counts = {'due': len(work), 'fetched': 0, 'clean': 0, 'failed': 0, 'by_reason': {}}
    for why in (w for _, _, w in work):
        counts['by_reason'][why] = counts['by_reason'].get(why, 0) + 1
    failed = []
    for i, (camp, h, why) in enumerate(work):
        if (max_requests and counts['fetched'] >= max_requests) or (stop_file and os.path.exists(stop_file)):
            return {'complete': False, 'reason': 'request cap' if max_requests and counts['fetched'] >= max_requests else 'stopped', **counts}
        counts['fetched'] += 1
        if harvester.fetch(camp, h):
            counts['clean'] += 1
        else:
            counts['failed'] += 1
            failed.append((camp, h))
        if counts['fetched'] % 500 == 0:
            log(f'{now()} {counts["fetched"]}/{len(work)} campaigns, {counts["failed"]} failed, requests {harvester.requests}')
    return {'complete': True, **counts, '_failed': failed}


def final_pass(harvester, failed, log):
    if not failed:
        return []
    log(f'{now()} final pass: {len(failed)} failed campaigns, waiting {FINAL_PASS_WAIT} s')
    time.sleep(FINAL_PASS_WAIT)
    return [c for c, h in failed if not harvester.fetch(c, h, retries=False)]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--state', required=True, help='SQLite state file (created when missing)')
    ap.add_argument('--pre', required=True, help='FLAT_RCL_PRE_2010.zip')
    ap.add_argument('--post', required=True, help='FLAT_RCL_POST_2010.zip')
    ap.add_argument('--pause', type=float, default=1.0, help='seconds between requests (default 1.0)')
    ap.add_argument('--timeout', type=float, default=60.0)
    ap.add_argument('--max-requests', type=int, default=0, help='campaigns to fetch at most in this run (0: no cap)')
    ap.add_argument('--recent-days', type=int, default=120)
    ap.add_argument('--recent-every-days', type=int, default=14)
    ap.add_argument('--rolling', type=int, default=0, help='also re-check this many campaigns checked longest ago')
    ap.add_argument('--summary', help='write a JSON summary here')
    ap.add_argument('--stop-file', help='stop cleanly when this file exists')
    args = ap.parse_args(argv)
    log = lambda m: print(m, flush=True)
    flat = flat_campaigns(args.pre, args.post)
    db = open_state(args.state)
    run = now()
    db.execute('INSERT INTO runs(run, started_at, args) VALUES(?,?,?)', (run, run, json.dumps(vars(args))))
    db.commit()
    work = due(db, flat, datetime.date.today(), args.recent_days, args.recent_every_days, args.rolling)
    log(f'{run} {len(flat)} campaigns in the flat files, {len(work)} due')
    harvester = Harvester(db, args.pause, args.timeout, run, log)
    result = harvest(db, harvester, work, args.max_requests, log, args.stop_file)
    never_clean = final_pass(harvester, result.pop('_failed', []), log) if result.get('complete') else None
    status = dict(db.execute('SELECT status, COUNT(*) FROM campaigns GROUP BY status').fetchall())
    summary = {**result, 'run': run, 'finished_at': now(), 'requests': harvester.requests, 'values_changed': harvester.values_changed,
               'never_clean': never_clean, 'never_clean_count': None if never_clean is None else len(never_clean),
               'flat_campaigns': len(flat), 'state': status}
    db.execute('UPDATE runs SET finished_at=?, summary=? WHERE run=?', (summary['finished_at'], json.dumps(summary), run))
    db.commit()
    if args.summary:
        Path(args.summary).write_text(json.dumps(summary, indent=1))
    log(json.dumps({k: v for k, v in summary.items() if k != 'never_clean'}))
    return 0 if result.get('complete') and not never_clean else 3


if __name__ == '__main__':
    sys.exit(main())

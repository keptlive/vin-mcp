#!/usr/bin/env python3
"""Gentle crawl of NHTSA's 5-Star Safety Ratings API (NCAP) into a local state database.

Why a crawl: NHTSA's only bulk ratings file (static.nhtsa.gov/nhtsa/downloads/Safercar/Safercar_data.csv, checked
2026-11-27) has no VehicleId and no VehicleDescription, does not keep the API's variant order (the report's primary
rating is the first variant the API lists), and had not been updated since 2026-08-07 (no model year 2027). So the
local copy is a crawl of exactly the endpoints the live code calls, one request at a time with a pause between
requests:

  /SafetyRatings?format=json                                         model years
  /SafetyRatings/modelyear/{y}?format=json                           makes of a model year
  /SafetyRatings/modelyear/{y}/make/{make}?format=json               models of a make and year
  /SafetyRatings/modelyear/{y}/make/{make}/model/{model}?format=json variants (VehicleId, VehicleDescription), in order
  /SafetyRatings/VehicleId/{id}?format=json                          ratings of one variant

State: SQLite file (--state), table `responses` (path, status, body, fetched_at, tries, error), one row per path.
Re-running resumes: a path already fetched cleanly is not fetched again unless it is in scope of --refresh-years.
A path that fails is retried with back-off; at the end every failed path is tried once more, and paths that never
ran clean are listed in the summary (--summary) so the build can leave them to the live API.

Scheduled use (scripts/nhtsa-refresh.sh): `--refresh-years recent` re-fetches the lists and ratings of the last
model years (new ratings appear there); `--refresh-years all` re-crawls everything (quarterly).
"""
import argparse, datetime, json, os, sqlite3, sys, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

BASE = 'https://api.nhtsa.gov/SafetyRatings'
USER_AGENT = 'nhtsa-ratings-sync/1.0'
RETRY_WAITS = (15, 60, 180)  # seconds before attempts 2, 3, 4 of one path
FINAL_PASS_WAIT = 300        # seconds before the last try of every failed path


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def q(text):
    """Path segment encoded like JavaScript's encodeURIComponent (what lib/nhtsa.mjs sends)."""
    return urllib.parse.quote(str(text), safe="-_.!~*'()")


def path_years():
    return '/SafetyRatings?format=json'


def path_makes(year):
    return f'/SafetyRatings/modelyear/{q(year)}?format=json'


def path_models(year, make):
    return f'/SafetyRatings/modelyear/{q(year)}/make/{q(make)}?format=json'


def path_variants(year, make, model):
    return f'/SafetyRatings/modelyear/{q(year)}/make/{q(make)}/model/{q(model)}?format=json'


def path_detail(vehicle_id):
    return f'/SafetyRatings/VehicleId/{int(vehicle_id)}?format=json'


def open_state(file):
    db = sqlite3.connect(file)
    db.executescript('''CREATE TABLE IF NOT EXISTS responses(path TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT,
        fetched_at TEXT, tries INTEGER NOT NULL DEFAULT 0, error TEXT, run TEXT);
        CREATE TABLE IF NOT EXISTS runs(run TEXT PRIMARY KEY, started_at TEXT, finished_at TEXT, args TEXT, summary TEXT);''')
    return db


class Crawler:
    def __init__(self, db, pause, timeout, run, log, base=BASE, opener=None):
        self.db, self.pause, self.timeout, self.run, self.log, self.base = db, pause, timeout, run, log, base
        self.opener = opener or urllib.request.urlopen
        self.requests = 0
        self.last = 0.0

    def _get(self, path):
        wait = self.pause - (time.monotonic() - self.last)
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(self.base.rsplit('/SafetyRatings', 1)[0] + path,
                                     headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'})
        self.requests += 1
        try:
            with self.opener(req, timeout=self.timeout) as res:
                return res.status, res.read().decode('utf-8')
        except urllib.error.HTTPError as err:
            try:
                body = err.read().decode('utf-8', 'replace')
            except Exception:
                body = ''
            return err.code, body
        finally:
            self.last = time.monotonic()

    def fetch(self, path, retries=True):
        """Fetch one path (with back-off retries); store and return the parsed body, or None when it never ran clean."""
        attempts = 1 + (len(RETRY_WAITS) if retries else 0)
        error = None
        for attempt in range(attempts):
            if attempt:
                time.sleep(RETRY_WAITS[attempt - 1])
            try:
                status, text = self._get(path)
                if status == 200:
                    body = json.loads(text)
                    if isinstance(body, dict) and isinstance(body.get('Results'), list):
                        self._store(path, 'ok', text, attempt + 1, None)
                        return body
                    error = 'unexpected body'
                else:
                    error = f'HTTP {status}'
                    if 400 <= status < 500 and status != 429 and attempt >= 1:
                        break  # a client error twice is an answer, not an outage
            except Exception as err:  # timeouts, resets, bad JSON
                error = f'{type(err).__name__}: {err}'
            self.log(f'retry {attempt + 1}/{attempts} {path}: {error}')
        self._store(path, 'failed', None, attempts, error)
        return None

    def _store(self, path, status, body, tries, error):
        old = self.db.execute('SELECT status, tries FROM responses WHERE path=?', (path,)).fetchone()
        if status == 'failed' and old and old[0] == 'ok':
            # Keep the last clean answer; record the failure.
            self.db.execute('UPDATE responses SET error=?, tries=tries+? WHERE path=?', (error, tries, path))
        else:
            self.db.execute('INSERT OR REPLACE INTO responses(path,status,body,fetched_at,tries,error,run) VALUES(?,?,?,?,?,?,?)',
                            (path, status, body, now(), tries, error, self.run))
        self.db.commit()

    def get(self, path, refresh):
        """The stored clean body when there is one and the path is not being refreshed, else a fresh fetch."""
        if not refresh:
            row = self.db.execute("SELECT body FROM responses WHERE path=? AND status='ok'", (path,)).fetchone()
            if row:
                return json.loads(row[0])
        return self.fetch(path)


def year_scope(spec, years, today=None):
    """'all' -> every year; 'recent' -> current year - 2 and later; 'none' -> no year; '2024-2027' -> that range."""
    today = today or datetime.date.today()
    if spec == 'all':
        return set(years)
    if spec in ('none', ''):
        return set()
    if spec == 'recent':
        return {y for y in years if y >= today.year - 2}
    lo, _, hi = spec.partition('-')
    lo, hi = int(lo), int(hi or lo)
    return {y for y in years if lo <= y <= hi}


def crawl(db, crawler, only_years='all', refresh_years='none', log=print, stop_file=None):
    stopped = lambda: stop_file and os.path.exists(stop_file)
    top = crawler.get(path_years(), refresh=refresh_years != 'none')
    if top is None:
        return {'complete': False, 'reason': 'model year list failed'}
    years = sorted({int(r['ModelYear']) for r in top['Results'] if str(r.get('ModelYear', '')).isdigit()}, reverse=True)
    wanted = year_scope(only_years, years)
    fresh = year_scope(refresh_years, years)
    counts = {'years': 0, 'makes': 0, 'models': 0, 'variants': 0, 'details': 0}
    for year in years:
        if year not in wanted:
            continue
        if stopped():
            return {'complete': False, 'reason': 'stopped', **counts}
        refresh = year in fresh
        makes = crawler.get(path_makes(year), refresh)
        counts['years'] += 1
        if makes is None:
            continue
        for mk in makes['Results']:
            make = mk.get('Make')
            if not make:
                continue
            models = crawler.get(path_models(year, make), refresh)
            counts['makes'] += 1
            if models is None:
                continue
            for md in models['Results']:
                model = md.get('Model')
                if not model:
                    continue
                if stopped():
                    return {'complete': False, 'reason': 'stopped', **counts}
                variants = crawler.get(path_variants(year, make, model), refresh)
                counts['models'] += 1
                if variants is None:
                    continue
                for v in variants['Results']:
                    vid = v.get('VehicleId')
                    if not isinstance(vid, int) or vid <= 0:
                        continue
                    counts['variants'] += 1
                    if crawler.get(path_detail(vid), refresh) is not None:
                        counts['details'] += 1
        log(f'{now()} year {year} done: {json.dumps(counts)} requests {crawler.requests}')
    return {'complete': True, **counts}


def final_pass(db, crawler, log):
    failed = [r[0] for r in db.execute("SELECT path FROM responses WHERE status='failed' ORDER BY path")]
    if not failed:
        return []
    log(f'{now()} final pass: {len(failed)} failed paths, waiting {FINAL_PASS_WAIT} s')
    time.sleep(FINAL_PASS_WAIT)
    for p in failed:
        crawler.fetch(p, retries=False)
    return [r[0] for r in db.execute("SELECT path FROM responses WHERE status='failed' ORDER BY path")]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--state', required=True, help='SQLite state file (created when missing)')
    ap.add_argument('--years', default='all', help="model years to crawl: all | recent | 2024-2027")
    ap.add_argument('--refresh-years', default='none', help='model years whose stored answers are fetched again: none | recent | all | range')
    ap.add_argument('--pause', type=float, default=1.0, help='seconds between requests (default 1.0)')
    ap.add_argument('--timeout', type=float, default=30.0)
    ap.add_argument('--summary', help='write a JSON summary here')
    ap.add_argument('--stop-file', help='stop cleanly when this file exists')
    args = ap.parse_args(argv)
    log = lambda m: print(m, flush=True)
    db = open_state(args.state)
    run = now()
    db.execute('INSERT INTO runs(run, started_at, args) VALUES(?,?,?)', (run, run, json.dumps(vars(args))))
    db.commit()
    crawler = Crawler(db, args.pause, args.timeout, run, log)
    result = crawl(db, crawler, args.years, args.refresh_years, log, args.stop_file)
    never_clean = final_pass(db, crawler, log) if result.get('complete') else None
    summary = {**result, 'run': run, 'finished_at': now(), 'requests': crawler.requests,
               'never_clean': never_clean, 'never_clean_count': None if never_clean is None else len(never_clean),
               'stored_ok': db.execute("SELECT COUNT(*) FROM responses WHERE status='ok'").fetchone()[0]}
    db.execute('UPDATE runs SET finished_at=?, summary=? WHERE run=?', (summary['finished_at'], json.dumps(summary), run))
    db.commit()
    if args.summary:
        Path(args.summary).write_text(json.dumps(summary, indent=1))
    log(json.dumps({k: v for k, v in summary.items() if k != 'never_clean'}))
    return 0 if result.get('complete') else 3


if __name__ == '__main__':
    sys.exit(main())

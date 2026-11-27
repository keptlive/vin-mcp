#!/usr/bin/env python3
"""Every NHTSA-derived data file mcp.vin serves locally: what it is, how often NHTSA changes it, how a new copy is
checked before it replaces the live one, and how stale is too stale. Shared by the build server (scripts/nhtsa-build.sh),
the web server (scripts/nhtsa-install.py) and the freshness check. docs/nhtsa-local-data.md, "Refresh", explains the
whole chain.

  nhtsa_datasets.py gate DATASET NEW [--live FILE] [--max-drop 0.03] [--no-known-answers]
      Sanity gate: the file opens, PRAGMA quick_check is ok, every table and column the site reads exists, row counts
      are above a floor and not down more than --max-drop from --live, and the site's own lookup code gives known
      answers from it (scripts/nhtsa-known-answers.mjs). Prints JSON; exit 0 pass, 1 fail.
  nhtsa_datasets.py publish DATASET BUILT --publish DIR [--dl DIR] [--source-date ISO] [--extra JSON]
      (build server) gate BUILT against the copy published now, then publish it as DIR/<name>.<sha12>.db with the
      manifest DIR/<dataset>.json; keeps the previous version for pulls in flight. A failed gate keeps the old copy.
  nhtsa_datasets.py note DATASET RESULT [--message TEXT] [--confirmed] [--source-modified HTTPDATE|ISO] --publish DIR
      (build server) record one dataset's outcome in DIR/builder-status.json (read by the web server's check).
  nhtsa_datasets.py check [--state DIR] [--data DIR] [--dry-run] [--now ISO]
      (web server) freshness check: mails the owner (notify.py) when a dataset is older than its limit, a build or an
      install failed, or the build server stopped reporting. Each problem mails at most once per 20 hours.
  nhtsa_datasets.py status [--state DIR] [--data DIR]
      print the status lines (one JSON object per dataset: source date, built date, rows, ...).
"""
import argparse, contextlib, datetime, email.utils, fcntl, hashlib, json, os, socket, sqlite3, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOUR = 3600
DAY = 86400
ODI = 'https://static.nhtsa.gov/odi/ffdd/'

# tables: every table (or view) and column the site's lookup code reads. counts: name -> SQL; floor: minimum rows
# (well under the 2026-11-27 values, for a first install with no live copy to compare with). confirm_hours: the build
# server re-checks NHTSA's source this often; an installed copy not confirmed against NHTSA for 2x this long is
# stale. source_days: NHTSA itself normally changes the source at least this often; a source unchanged for over
# 2x this (plus a day for timing) is reported too. Daily sources get 3 days, so one skipped NHTSA day does not mail.
DATASETS = {
    'nhtsa-recalls': {
        'file': 'nhtsa-recalls.db', 'mode': 'odi', 'confirm_hours': 24, 'source_days': 1,
        'source': 'FLAT_RCL_PRE_2010.zip + FLAT_RCL_POST_2010.zip (' + ODI + 'rcl/) + recall campaign API crawl',
        'sources': ['FLAT_RCL_PRE_2010.zip', 'FLAT_RCL_POST_2010.zip'],
        'tables': {
            'campaigns': ['campaign', 'manufacturer', 'mfr_campaign', 'type', 'summary', 'consequence', 'remedy', 'notes',
                          'report_received', 'record_created', 'owners_notified', 'influenced_by', 'do_not_drive',
                          'park_outside', 'api_component', 'ota', 'api_report_received'],
            'vehicles': ['make', 'model', 'year', 'campaign', 'component', 'first_record', 'mfr_text'],
            'api_components': ['campaign', 'make', 'model', 'year', 'component'],
            'metadata': ['key', 'value']},
        'counts': {'campaigns': 'SELECT count(*) FROM campaigns', 'vehicle_rows': 'SELECT count(*) FROM vehicles'},
        'floor': {'campaigns': 28000, 'vehicle_rows': 180000},
        'meta': {'dataset': 'nhtsa_recalls', 'schema': 1}},
    'recall-labels': {
        'file': 'recall-labels.db', 'mode': 'odi', 'confirm_hours': 24, 'source_days': 1,
        'source': 'FLAT_RCL_PRE_2010.zip + FLAT_RCL_POST_2010.zip (' + ODI + 'rcl/)',
        'sources': ['FLAT_RCL_PRE_2010.zip', 'FLAT_RCL_POST_2010.zip'],
        'tables': {'labels': ['make', 'model', 'year', 'campaigns', 'compact', 'campaign_numbers'],
                   'campaign_builds': ['campaign', 'make_compact', 'model_compact', 'year', 'built_from', 'built_to', 'distinct_ranges'],
                   'campaign_units': ['campaign', 'units_affected'], 'metadata': ['key', 'value']},
        'counts': {'labels': 'SELECT count(*) FROM labels'},
        'floor': {'labels': 60000}},
    'nhtsa-complaints': {
        'file': 'nhtsa-complaints.db', 'mode': 'odi', 'confirm_hours': 24, 'source_days': 1,
        'source': 'FLAT_CMPL.zip (' + ODI + 'cmpl/)', 'sources': ['FLAT_CMPL.zip'],
        'tables': {'complaints': ['make', 'model', 'year', 'odi', 'first_row', 'crash', 'fire', 'injured', 'deaths', 'incident',
                                  'received', 'components', 'prod_types', 'summary'], 'metadata': ['key', 'value']},
        'counts': {'complaint_rows': 'SELECT count(*) FROM complaints'},
        'floor': {'complaint_rows': 1500000},
        'meta': {'dataset': 'nhtsa_complaints', 'schema': 1}},
    'investigations': {
        'file': 'investigations.db', 'mode': 'odi', 'confirm_hours': 24, 'source_days': 1,
        'source': 'FLAT_INV.zip (' + ODI + 'inv/)', 'sources': ['FLAT_INV.zip'],
        'tables': {'reports': ['hash', 'id', 'manufacturer', 'opened', 'closed', 'subject', 'summary'],
                   'applicability': ['hash', 'make', 'model', 'year', 'component', 'campaign'], 'metadata': ['key', 'value']},
        'counts': {'reports': 'SELECT count(*) FROM reports', 'applicability': 'SELECT count(*) FROM applicability'},
        'floor': {'reports': 5000, 'applicability': 140000}},
    'communications': {
        'file': 'communications.db', 'mode': 'odi', 'confirm_hours': 24, 'source_days': 1,
        'source': 'TSBS_RECEIVED_*.zip (' + ODI + 'tsbs/), normalized by scripts/compact-communications.py',
        'sources': 'TSBS_RECEIVED_*.zip',
        'tables': {'records': ['record', 'id', 'bulletin', 'received', 'issued', 'kind', 'summary', 'archive'],
                   'associations': ['seq', 'record', 'make', 'model', 'year', 'component'],
                   'communications': ['id', 'bulletin', 'received', 'issued', 'kind', 'make', 'model', 'year', 'component', 'summary', 'archive'],
                   'metadata': ['key', 'value']},
        'counts': {'records': 'SELECT count(*) FROM records', 'associations': 'SELECT count(*) FROM associations'},
        'floor': {'records': 240000, 'associations': 5000000}},
    'nhtsa-ratings': {
        'file': 'nhtsa-ratings.db', 'mode': 'ratings', 'confirm_hours': 7 * 24 + 12, 'source_days': 7,
        'source': 'NHTSA 5-Star Safety Ratings API crawl (current and next model years weekly)',
        'tables': {'years': ['year', 'makes_ok'], 'makes': ['year', 'make_key', 'make', 'models_ok'],
                   'models': ['year', 'make_key', 'model_key', 'model', 'variants_ok'],
                   'variants': ['year', 'make_key', 'model_key', 'ord', 'vehicle_id', 'description'],
                   'ratings': ['vehicle_id', 'body'], 'metadata': ['key', 'value']},
        'counts': {'rated_variants': 'SELECT count(*) FROM ratings', 'models': 'SELECT count(*) FROM models'},
        'floor': {'rated_variants': 15000, 'models': 10000},
        'meta': {'dataset': 'nhtsa_ratings', 'schema': 1}},
    'vpic': {
        'file': 'vpic.db', 'mode': 'vpic', 'confirm_hours': 24, 'source_days': 31,
        'source': 'vPICList_lite_YYYY_MM.plain.zip (vpic.nhtsa.dot.gov/downloads/), built and parity-checked by scripts/vpic-refresh.sh',
        'tables': {'meta': ['key', 'value'], 'wmi': ['id', 'wmi', 'manufacturer_id', 'make_id', 'vehicle_type_id', 'truck_type_id', 'changed_us', 'public_us'],
                   'pattern': ['id', 'schema_id', 'keys', 'element_id', 'attribute_id', 'changed_us'],
                   'vinschema': ['id', 'name', 'to_be_qced', 'valid_chars'], 'wmi_vinschema': ['wmi_id', 'schema_id', 'year_from', 'year_to'],
                   'element': ['id', 'name', 'code', 'lookup_table', 'is_private', 'group_name', 'data_type', 'decode', 'weight', 'value_table'],
                   'lookup': ['tbl', 'id', 'name'], 'rule_fix': None},
        'counts': {'patterns': 'SELECT count(*) FROM pattern', 'wmis': 'SELECT count(*) FROM wmi'},
        'floor': {'patterns': 1200000, 'wmis': 12000}},
}
ORDER = list(DATASETS)


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)


def iso(dt):
    return dt.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ') if dt else None


def parse_date(text):
    """ISO 8601, an HTTP date (Last-Modified) or 'YYYY-MM-DD HH:MM:SS' -> aware datetime, else None."""
    if not text:
        return None
    text = str(text).strip()
    try:
        d = datetime.datetime.fromisoformat(text.replace('Z', '+00:00'))
        return d if d.tzinfo else d.replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        pass
    try:
        return email.utils.parsedate_to_datetime(text).astimezone(datetime.timezone.utc)
    except (TypeError, ValueError, IndexError):
        return None


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(4 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def write_json(path, obj):
    path = Path(path)
    tmp = path.with_name('.' + path.name + '.tmp')
    tmp.write_text(json.dumps(obj, indent=1, sort_keys=True) + '\n')
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


@contextlib.contextmanager
def locked(path):
    with open(path, 'a') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def connect_ro(path):
    return sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)


def counts_of(name, path):
    spec = DATASETS[name]
    db = connect_ro(path)
    try:
        return {k: db.execute(sql).fetchone()[0] for k, sql in spec['counts'].items()}
    finally:
        db.close()


def file_meta(name, path):
    """Dates and facts recorded inside a data file (each importer writes its own metadata)."""
    db = connect_ro(path)
    try:
        if name == 'vpic':
            m = dict(db.execute('SELECT key, value FROM meta'))
            fixes = json.loads(m.get('rule_fixes') or '{}')
            return {'release': m.get('release'), 'source_date': iso(parse_date(m.get('nhtsa_dump_started'))),
                    'built_at': m.get('built_at'), 'schema_version': m.get('schema_version'),
                    'rule_fixes_needing_review': fixes.get('needs_review'), 'algorithm_changed': json.loads(m.get('algorithm_changed') or '[]')}
        m = dict(db.execute('SELECT key, value FROM metadata'))
        if name == 'communications':
            srcs = json.loads(m.get('sources') or '[]')
            return {'source_date': m.get('source_last_modified') and iso(parse_date(m['source_last_modified'])) or
                    max((s.get('downloaded_at') or '' for s in srcs), default=None),
                    'built_at': m.get('indexed_at'), 'archives': len(srcs)}
        src = json.loads(m.get('source') or '{}')
        if name == 'investigations':
            return {'source_date': iso(parse_date(m.get('source_last_modified'))) or src.get('downloaded_at'), 'built_at': src.get('indexed_at')}
        if name == 'recall-labels':
            return {'source_date': iso(parse_date(m.get('source_last_modified'))) or max((s.get('downloaded_at') or '' for s in src.get('sources', [])), default=None),
                    'built_at': src.get('indexed_at'), 'latest_record_date': src.get('latest_report_date')}
        out = {'source_date': iso(parse_date(src.get('source_last_modified') or src.get('last_crawl_finished_at'))),
               'built_at': src.get('built_at'), 'dataset': src.get('dataset'), 'schema': src.get('schema')}
        latest = src.get('latest_report_date') or src.get('latest_received_date')
        if latest:
            out['latest_record_date'] = latest
        return out
    finally:
        db.close()


def known_answers(name, path, repo=ROOT):
    """Ask the site's own lookup code (lib/*.mjs) for known answers from this file."""
    try:
        r = subprocess.run(['node', str(Path(repo) / 'scripts/nhtsa-known-answers.mjs'), name, str(path)],
                           capture_output=True, text=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as e:
        return {'ok': False, 'error': repr(e)}
    try:
        out = json.loads(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        out = {'ok': False, 'error': (r.stderr or r.stdout)[-500:]}
    out['ok'] = bool(out.get('ok')) and r.returncode == 0
    return out


def gate(name, new, live=None, max_drop=0.03, known=True, repo=ROOT):
    """Checks a new data file before it may replace `live`. Returns {'ok', 'failures', 'counts', 'live_counts', ...}."""
    spec = DATASETS[name]
    fails, result = [], {'dataset': name, 'file': str(new)}
    try:
        db = connect_ro(new)
        try:
            qc = db.execute('PRAGMA quick_check').fetchone()[0]
            if qc != 'ok':
                fails.append(f'quick_check: {qc[:200]}')
            have = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type IN ('table','view')")}
            for table, cols in spec['tables'].items():
                if table not in have:
                    fails.append(f'missing table {table}')
                    continue
                got = {r[1] for r in db.execute(f'PRAGMA table_info("{table}")')}
                missing = [c for c in cols or [] if c not in got]
                if missing:
                    fails.append(f'{table} lacks columns {missing}')
        finally:
            db.close()
    except sqlite3.Error as e:
        fails.append(f'unreadable: {e}')
    if not fails:
        try:
            result['counts'] = counts = counts_of(name, new)
            meta = result['meta'] = file_meta(name, new)
        except (sqlite3.Error, ValueError) as e:
            fails.append(f'counts/metadata: {e}')
            counts, meta = {}, {}
        for k, floor in spec['floor'].items():
            if counts.get(k, 0) < floor:
                fails.append(f'{k} {counts.get(k)} below the floor {floor}')
        for k, v in spec.get('meta', {}).items():
            if meta.get(k) != v:
                fails.append(f'metadata {k} is {meta.get(k)!r}, expected {v!r}')
        if name == 'vpic':
            if meta.get('schema_version') != '1':
                fails.append(f"vpic schema_version {meta.get('schema_version')!r}")
            if meta.get('rule_fixes_needing_review'):
                fails.append(f"{meta['rule_fixes_needing_review']} vPIC rule fixes need review")
            if meta.get('algorithm_changed'):
                fails.append(f"NHTSA changed decode functions {meta['algorithm_changed']}")
        if live and Path(live).exists():
            try:
                lc = result['live_counts'] = counts_of(name, live)
                for k, old in lc.items():
                    if old and counts.get(k, 0) < old * (1 - max_drop):
                        fails.append(f'{k} fell from {old} to {counts.get(k)} (more than {max_drop:.0%})')
            except sqlite3.Error as e:
                result['live_counts_error'] = str(e)  # an unreadable live copy is no reason to keep it
        if known and not fails:
            ka = result['known_answers'] = known_answers(name, new, repo)
            if not ka.get('ok'):
                bad = [c['name'] for c in ka.get('checks', []) if not c.get('ok')] or [ka.get('error', 'failed')]
                fails.append(f'known answers failed: {bad}')
    result['failures'] = fails
    result['ok'] = not fails
    return result


# ---------------------------------------------------------------------------------------------- build server side

def source_info(name, dl):
    """Last-Modified and ETag of the NHTSA files a dataset is built from (saved by nhtsa-build.sh's fetch)."""
    pat = DATASETS[name].get('sources')
    if not pat or not dl:
        return []
    names = sorted(p.name for p in Path(dl).glob(pat)) if isinstance(pat, str) else pat
    out = []
    for n in names:
        p = Path(dl) / n
        if p.suffix != '.zip' or not p.exists():
            continue
        lm = (Path(dl) / (n + '.last-modified'))
        etag = None
        hdr = Path(dl) / (n + '.headers')
        if hdr.exists():
            for line in hdr.read_text(errors='replace').splitlines():
                if line.lower().startswith('etag:'):
                    etag = line.split(':', 1)[1].strip().strip('"')
        seen = Path(dl) / (n + '.seen')  # NHTSA's Last-Modified at the latest check (re-stamped files keep their content)
        out.append({'name': n, 'last_modified': iso(parse_date(lm.read_text().strip())) if lm.exists() else None,
                    'seen_modified': iso(parse_date(seen.read_text().strip())) if seen.exists() else None,
                    'etag': etag, 'size': p.stat().st_size})
    return out


def newest_seen(name, dl):
    """NHTSA's newest change to a dataset's source files as of the latest check."""
    return max((s['seen_modified'] or s['last_modified'] for s in source_info(name, dl) if s['seen_modified'] or s['last_modified']), default=None)


def note(publish, name, result, message='', confirmed=False, source_modified=None, dl=None, **extra):
    """Record a dataset's outcome in publish/builder-status.json (the web server copies it and the check reads it)."""
    publish = Path(publish)
    source_modified = source_modified or newest_seen(name, dl)
    publish.mkdir(parents=True, exist_ok=True)
    with locked(publish / '.builder-status.lock'):
        st = read_json(publish / 'builder-status.json', {}) or {}
        now = iso(utcnow())
        d = st.setdefault('datasets', {}).setdefault(name, {})
        d.update({'result': result, 'message': message[:2000], 'at': now, **extra})
        if result in ('failed', 'gate_failed', 'needs_review'):
            d['last_failure_at'] = now
        else:
            d['last_ok_at'] = now
        if confirmed:
            d['confirmed_at'] = now
        sm = parse_date(source_modified)
        if sm:
            d['source_modified'] = iso(sm)
        st.update({'updated_at': now, 'host': socket.gethostname(), 'commit': git_commit()})
        write_json(publish / 'builder-status.json', st)
    return d


def git_commit(repo=ROOT):
    try:
        return subprocess.run(['git', '-C', str(repo), 'rev-parse', '--short=12', 'HEAD'], capture_output=True, text=True, timeout=10).stdout.strip() or None
    except (OSError, subprocess.TimeoutExpired):
        return None


def publish(name, built, publish_dir, dl=None, source_date=None, extra=None, max_drop=0.03, known=True, repo=ROOT, keep=2):
    """Gate `built` against the published copy, then publish it (hard link) with its manifest. Returns (ok, manifest|gate)."""
    publish_dir = Path(publish_dir)
    publish_dir.mkdir(parents=True, exist_ok=True)
    spec = DATASETS[name]
    current = read_json(publish_dir / f'{name}.json')
    live = publish_dir / current['file'] if current and (publish_dir / current['file']).exists() else None
    g = gate(name, built, live=live, max_drop=max_drop, known=known, repo=repo)
    srcs = source_info(name, dl)
    newest_src = max((s['last_modified'] for s in srcs if s['last_modified']), default=None)
    seen = newest_seen(name, dl) or newest_src
    if not g['ok']:
        note(publish_dir, name, 'gate_failed', '; '.join(g['failures']), source_modified=seen)
        return False, g
    sha = sha256_file(built)
    if current and current.get('sha256') == sha:
        note(publish_dir, name, 'unchanged', 'rebuilt file is identical', confirmed=True, source_modified=seen)
        return True, current
    stem = spec['file'][:-3]
    target = publish_dir / f'{stem}.{sha[:12]}.db'
    tmp = publish_dir / f'.{target.name}.tmp'
    tmp.unlink(missing_ok=True)
    os.link(built, tmp)  # the build directory keeps its copy: the importers compare their next build with it
    os.chmod(tmp, 0o644)
    os.replace(tmp, target)
    meta = g.get('meta', {})
    manifest = {'dataset': name, 'file': target.name, 'sha256': sha, 'size': target.stat().st_size,
                'rows': g.get('counts'), 'source': spec['source'], 'source_files': srcs,
                'source_date': source_date or newest_src or meta.get('source_date'),
                'built_at': meta.get('built_at') or iso(utcnow()), 'published_at': iso(utcnow()),
                'latest_record_date': meta.get('latest_record_date'), 'builder': {'host': socket.gethostname(), 'commit': git_commit(repo)},
                'gate': {'live_counts': g.get('live_counts'), 'known_answers': [c['name'] for c in g.get('known_answers', {}).get('checks', [])]},
                **(extra or {})}
    if name == 'vpic':
        manifest['release'] = meta.get('release')
    write_json(publish_dir / f'{name}.json', manifest)
    # prune: keep this version and the one before it (a web server may be pulling it right now)
    versions = sorted(publish_dir.glob(f'{stem}.' + '?' * 12 + '.db'), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in versions[keep:]:
        old.unlink(missing_ok=True)
    note(publish_dir, name, 'published', f"{target.name} rows {json.dumps(g.get('counts'))}", confirmed=True,
         source_modified=seen or manifest['source_date'], published_sha256=sha, published_at=manifest['published_at'])
    return True, manifest


# ------------------------------------------------------------------------------------------------ web server side

def status_lines(data, state, now=None):
    """One status object per dataset from the installed copy (its manifest, or the file's own metadata)."""
    data, state = Path(data), Path(state)
    builder = read_json(state / 'builder-status.json', {}) or {}
    lines = []
    for name in ORDER:
        spec = DATASETS[name]
        path = data / spec['file']
        live = read_json(state / 'live' / f'{name}.json')
        b = (builder.get('datasets') or {}).get(name, {})
        line = {'dataset': name, 'file': spec['file']}
        if not path.exists():
            line['state'] = 'missing'
        else:
            st = path.stat()
            if live and live.get('size') == st.st_size and live.get('inode') == st.st_ino:
                line.update({k: live.get(k) for k in ('source_date', 'built_at', 'installed_at', 'rows', 'sha256', 'latest_record_date', 'release')})
                line['state'] = 'installed'
                # the build server's last confirmation counts only for the version installed here
                line['confirmed_at'] = b.get('confirmed_at') if b.get('published_sha256') == live.get('sha256') else live.get('published_at')
            else:  # installed by hand (before this refresh existed): read the file itself
                try:
                    m = file_meta(name, path)
                    line.update({'source_date': m.get('source_date'), 'built_at': m.get('built_at'), 'rows': counts_of(name, path),
                                 'latest_record_date': m.get('latest_record_date'), 'release': m.get('release')})
                    line['state'] = 'manual'
                except (sqlite3.Error, ValueError, KeyError) as e:
                    line.update({'state': 'unreadable', 'error': str(e)[:200]})
                line['confirmed_at'] = line.get('built_at')
            line = {k: v for k, v in line.items() if v is not None}
        if b:
            line['builder'] = {k: b.get(k) for k in ('result', 'at', 'message', 'confirmed_at', 'source_modified', 'published_sha256') if b.get(k)}
        lines.append(line)
    return lines


def write_status(data, state):
    lines = status_lines(data, state)
    path = Path(state) / 'status.jsonl'
    tmp = path.with_name('.status.jsonl.tmp')
    tmp.write_text(''.join(json.dumps(l, sort_keys=True) + '\n' for l in lines))
    os.replace(tmp, path)
    return lines


def hours(a, b):
    return (a - b).total_seconds() / HOUR


def problems(data, state, now=None):
    """Everything the owner should hear about, as (topic, subject, body)."""
    now = now or utcnow()
    state = Path(state)
    out = []
    lines = status_lines(data, state, now)
    builder = read_json(state / 'builder-status.json')
    inst = read_json(state / 'install-state.json', {}) or {}
    bu = parse_date((builder or {}).get('updated_at'))
    if not builder or not bu or hours(now, bu) > 36:
        out.append(('builder', 'build server silent',
                    f"No build report newer than {iso(bu) or 'ever'} from the build server (storage 104.37.188.237). "
                    "Check there: systemctl list-timers 'nhtsa-build-*'; journalctl -u nhtsa-build-odi -n 80. "
                    f"The web server copies the report on every pull: last good pull {inst.get('last_ok_at', 'never')}."))
    lp = parse_date(inst.get('last_ok_at'))
    if not lp or hours(now, lp) > 6:
        out.append(('pull', 'pulls from the build server failing',
                    f"Last good pull {inst.get('last_ok_at', 'never')}; last error: {inst.get('last_error', 'none recorded')}. "
                    "Check: systemctl status vin-mcp-nhtsa-install.timer; journalctl -u vin-mcp-nhtsa-install -n 80."))
    for line in lines:
        name = line['dataset']
        spec = DATASETS[name]
        if line['state'] in ('missing', 'unreadable'):
            out.append((f'missing-{name}', f'{name} is {line["state"]}', f"data/{spec['file']} is {line['state']} on the web server. {line.get('error', '')}"))
            continue
        conf = parse_date(line.get('confirmed_at'))
        limit = 2 * spec['confirm_hours']
        if not conf or hours(now, conf) > limit:
            out.append((f'stale-{name}', f'{name} not refreshed for {hours(now, conf) / 24:.1f} days' if conf else f'{name} never refreshed',
                        f"The installed copy of {name} was last confirmed against NHTSA's source at {iso(conf) or 'never'} "
                        f"(limit {limit} h = twice the {spec['confirm_hours']} h refresh cycle). Source: {spec['source']}.\n"
                        f"Installed: source date {line.get('source_date')}, built {line.get('built_at')}, rows {json.dumps(line.get('rows'))}.\n"
                        f"Build server says: {json.dumps(line.get('builder', {}))}"))
        b = line.get('builder') or {}
        src = parse_date(b.get('source_modified') or line.get('source_date'))
        src_limit = 2 * spec['source_days'] + 1
        if src and hours(now, src) / 24 > src_limit:
            out.append((f'source-{name}', f"NHTSA's {name} source unchanged for {hours(now, src) / 24:.0f} days",
                        f"{spec['source']}: newest NHTSA change seen {iso(src)} (normally at least every {spec['source_days']} day(s); "
                        f"limit {src_limit} days). Our copy is as current as NHTSA's file; check that NHTSA still publishes it there."
                        + (" The site asks NHTSA's live API first once recalls or complaints are 7 days old." if name in ('nhtsa-recalls', 'nhtsa-complaints') else '')))
        if b.get('result') in ('failed', 'gate_failed', 'needs_review'):
            out.append((f'build-{name}', f'{name} refresh {b["result"].replace("_", " ")}',
                        f"Build server, {b.get('at')}: {b['result']}: {b.get('message')}\nThe live copy stays in place until a build passes."))
        pub = b.get('published_sha256')
        ib = (inst.get('datasets') or {}).get(name, {})
        if pub and pub != line.get('sha256') and pub not in ib.get('rejected', []):
            seen = parse_date(ib.get('seen_at')) if ib.get('seen_sha256') == pub else None
            if not seen or hours(now, seen) > 6:
                out.append((f'install-{name}', f'{name} build not installed',
                            f"The build server published {pub[:12]} at {b.get('at')} but the web server still serves {str(line.get('sha256'))[:12]}. "
                            f"Last install error: {ib.get('last_error', 'none recorded')}."))
    return out


def check(data, state, dry=False, now=None, notify=None):
    found = problems(data, state, now)
    notify = notify or os.environ.get('NHTSA_NOTIFY', '/opt/host-alert/notify.py')
    for topic, subject, body in found:
        print('ALERT', subject, '|', body.replace('\n', ' / '), flush=True)
        if not dry:
            subprocess.run([sys.executable, notify, '--topic', 'nhtsa-' + topic, '--cooldown', '72000',
                            'mcp.vin NHTSA data: ' + subject,
                            body + f'\n\nChecked on {socket.gethostname()} by scripts/nhtsa_datasets.py check. '
                            'Status lines: /var/lib/vin-mcp-nhtsa/status.jsonl; rollback: scripts/nhtsa-install.py rollback DATASET.'],
                           check=False, timeout=90)
    if not found:
        print('ok: every NHTSA dataset is fresh')
    return found


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    sub = ap.add_subparsers(dest='cmd', required=True)
    g = sub.add_parser('gate')
    g.add_argument('dataset', choices=ORDER); g.add_argument('new'); g.add_argument('--live')
    g.add_argument('--max-drop', type=float, default=0.03); g.add_argument('--no-known-answers', action='store_true')
    p = sub.add_parser('publish')
    p.add_argument('dataset', choices=ORDER); p.add_argument('built'); p.add_argument('--publish', required=True)
    p.add_argument('--dl'); p.add_argument('--source-date'); p.add_argument('--extra', default='{}')
    p.add_argument('--max-drop', type=float, default=0.03); p.add_argument('--no-known-answers', action='store_true')
    n = sub.add_parser('note')
    n.add_argument('dataset', choices=ORDER); n.add_argument('result'); n.add_argument('--publish', required=True)
    n.add_argument('--message', default=''); n.add_argument('--confirmed', action='store_true'); n.add_argument('--source-modified')
    n.add_argument('--dl', help="downloads directory: the source date is the newest Last-Modified seen there")
    for name in ('check', 'status'):
        c = sub.add_parser(name)
        c.add_argument('--state', default=os.environ.get('NHTSA_STATE', '/var/lib/vin-mcp-nhtsa'))
        c.add_argument('--data', default=os.environ.get('NHTSA_DATA', str(ROOT / 'data')))
        c.add_argument('--dry-run', action='store_true'); c.add_argument('--now')
    a = ap.parse_args(argv)
    if a.cmd == 'gate':
        r = gate(a.dataset, a.new, a.live, a.max_drop, not a.no_known_answers)
        print(json.dumps(r, indent=1))
        return 0 if r['ok'] else 1
    if a.cmd == 'publish':
        ok, r = publish(a.dataset, a.built, a.publish, a.dl, a.source_date, json.loads(a.extra), a.max_drop, not a.no_known_answers)
        print(json.dumps(r, indent=1))
        return 0 if ok else 1
    if a.cmd == 'note':
        print(json.dumps(note(a.publish, a.dataset, a.result, a.message, a.confirmed, a.source_modified, a.dl)))
        return 0
    if a.cmd == 'status':
        for line in write_status(a.data, a.state) if os.access(a.state, os.W_OK) else status_lines(a.data, a.state):
            print(json.dumps(line, sort_keys=True))
        return 0
    if a.cmd == 'check':
        check(a.data, a.state, a.dry_run, parse_date(a.now) if a.now else None)
        return 0  # problems are mailed; the unit itself only fails when the check cannot run


if __name__ == '__main__':
    sys.exit(main())

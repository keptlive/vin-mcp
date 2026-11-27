#!/usr/bin/env python3
"""Install new NHTSA data files on the web server (pull, verify, gate, atomic swap) and roll one back.

  nhtsa-install.py pull               hourly (vin-mcp-nhtsa-install.timer): copy the build server's manifests; for each
                                      dataset whose published version differs from the installed one, pull the file
                                      (rsync, delta against the live copy), check its sha256, gate it against the live
                                      copy with this server's own code, then rename it over data/<file> and keep the
                                      replaced file as data/<file>.prev. Any failure keeps the live copy and mails.
  nhtsa-install.py rollback DATASET   put data/<file>.prev back (one step); that version is never pulled again
  nhtsa-install.py status             print one status line per dataset (also written to $NHTSA_STATE/status.jsonl)

The site reads the new file without a restart: research lookups open the file per request, the recall, complaint,
rating and vPIC lookups notice a replaced file within a minute (lib/nhtsa-local.mjs, lib/vpic-local.mjs).

Environment: NHTSA_PUBLISH_SRC (rsync source, default nhtsapub@10.77.0.1: = the build server's publish directory,
read-only), NHTSA_RSYNC_SSH (default ssh -i /root/.ssh/nhtsa_pull -o BatchMode=yes -o ConnectTimeout=20),
NHTSA_DATA (default <repo>/data), NHTSA_STATE (default /var/lib/vin-mcp-nhtsa), NHTSA_MIN_FREE_GB (default 3),
NHTSA_NOTIFY (default /opt/host-alert/notify.py; 'off' prints instead of mailing), NHTSA_KNOWN_ANSWERS ('off': tests).
Exit codes: 0 ok, 1 something failed (mailed), 2 another run holds the lock.
"""
import fcntl, json, os, shutil, subprocess, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nhtsa_datasets as nd  # noqa: E402

ROOT = nd.ROOT
SRC = os.environ.get('NHTSA_PUBLISH_SRC', 'nhtsapub@10.77.0.1:')
SSH = os.environ.get('NHTSA_RSYNC_SSH', 'ssh -i /root/.ssh/nhtsa_pull -o BatchMode=yes -o ConnectTimeout=20')
DATA = Path(os.environ.get('NHTSA_DATA', str(ROOT / 'data')))
STATE = Path(os.environ.get('NHTSA_STATE', '/var/lib/vin-mcp-nhtsa'))
MIN_FREE = float(os.environ.get('NHTSA_MIN_FREE_GB', '3')) * 1e9
NOTIFY = os.environ.get('NHTSA_NOTIFY', '/opt/host-alert/notify.py')
KNOWN = os.environ.get('NHTSA_KNOWN_ANSWERS', 'on') != 'off'
KEEP_REJECTED = 5


class InstallError(Exception):
    pass


def log(msg):
    print(f'{nd.iso(nd.utcnow())} {msg}', flush=True)


def mail(topic, subject, body):
    log(f'ALERT {subject}: {body}')
    if NOTIFY == 'off':
        return
    subprocess.run([sys.executable, NOTIFY, '--topic', 'nhtsa-' + topic, '--cooldown', '72000', 'mcp.vin NHTSA data: ' + subject,
                    body + '\n\nFrom scripts/nhtsa-install.py on the web server. Status: /var/lib/vin-mcp-nhtsa/status.jsonl.'],
                   check=False, timeout=90)


def rsync(args):
    remote = ':' in SRC.split('/')[0]
    cmd = ['rsync', '-a', '--timeout=600'] + (['-z', '-e', SSH] if remote else []) + args
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise InstallError(f'rsync exit {r.returncode}: {(r.stderr or r.stdout).strip()[-400:]}')


def src(name):
    return SRC + name if SRC.endswith((':', '/')) else SRC + '/' + name


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def live_manifest(name):
    return nd.read_json(STATE / 'live' / f'{name}.json')


def installed_sha(name):
    path = DATA / nd.DATASETS[name]['file']
    m = live_manifest(name)
    if not m or not path.exists():
        return None
    st = path.stat()
    return m.get('sha256') if (m.get('inode'), m.get('size')) == (st.st_ino, st.st_size) else None


def install_one(name, m, ds):
    spec = nd.DATASETS[name]
    live = DATA / spec['file']
    incoming = DATA / '.incoming'
    incoming.mkdir(exist_ok=True)
    if not m.get('file', '').startswith(spec['file'][:-3] + '.') or '/' in m['file']:
        raise InstallError(f"manifest names an unexpected file {m.get('file')!r}")
    for old in incoming.glob(spec['file'][:-3] + '.*'):
        if old.name != m['file']:
            old.unlink()
    staged = incoming / m['file']
    free = shutil.disk_usage(DATA).free
    if free < m['size'] + MIN_FREE:
        raise InstallError(f"{free / 1e9:.1f} GB free on {DATA}; need {m['size'] / 1e9:.1f} GB + {MIN_FREE / 1e9:.0f} GB")
    if not staged.exists() and live.exists():
        os.link(live, staged)  # rsync's basis: only the changed parts of the file travel; the live inode is never written
    log(f"{name}: pulling {m['file']} ({m['size'] / 1e6:.0f} MB)")
    rsync(['-I', '--partial-dir=.rsync-partial', src(m['file']), str(incoming) + '/'])
    sha = nd.sha256_file(staged)
    if sha != m['sha256']:
        staged.unlink(missing_ok=True)
        raise InstallError(f"pulled file has sha256 {sha[:12]}, manifest says {m['sha256'][:12]}")
    g = nd.gate(name, staged, live=live if live.exists() else None, known=KNOWN, repo=ROOT)
    if not g['ok']:
        staged.unlink(missing_ok=True)
        ds.setdefault('rejected', []).append(m['sha256'])
        del ds['rejected'][:-KEEP_REJECTED]
        raise InstallError('gate failed on the web server: ' + '; '.join(g['failures']))
    prev_manifest = live_manifest(name)
    if live.exists():
        tmp = DATA / f".{spec['file']}.prev.tmp"
        tmp.unlink(missing_ok=True)
        os.link(live, tmp)
        os.replace(tmp, DATA / (spec['file'] + '.prev'))
        if prev_manifest and installed_sha(name):
            nd.write_json(STATE / 'live' / f'{name}.prev.json', prev_manifest)
        else:
            (STATE / 'live' / f'{name}.prev.json').unlink(missing_ok=True)
    os.chmod(staged, 0o644)
    os.replace(staged, live)
    fsync_dir(DATA)
    st = live.stat()
    nd.write_json(STATE / 'live' / f'{name}.json', {**m, 'installed_at': nd.iso(nd.utcnow()), 'inode': st.st_ino, 'size': st.st_size,
                                                    'previous_sha256': (prev_manifest or {}).get('sha256')})
    ds['installed_at'] = nd.iso(nd.utcnow())
    ds.pop('last_error', None)
    log(f"{name}: installed {m['file']} rows {json.dumps(g.get('counts'))} (was {json.dumps(g.get('live_counts'))})")


def pull():
    inbox = STATE / 'inbox'
    inbox.mkdir(parents=True, exist_ok=True)
    (STATE / 'live').mkdir(exist_ok=True)
    inst = nd.read_json(STATE / 'install-state.json', {}) or {}
    inst['last_run_at'] = nd.iso(nd.utcnow())
    failed = 0
    try:
        # --checksum: a manifest rewritten within the same second at the same size must still be copied
        rsync(['--checksum', '--delete', '--include=*.json', '--exclude=*', src(''), str(inbox) + '/'])
    except InstallError as e:
        inst['last_error'] = str(e)
        nd.write_json(STATE / 'install-state.json', inst)
        nd.write_status(DATA, STATE)
        log(f'manifest pull failed: {e}')
        return 1  # the check mails when pulls keep failing (6 h); one failed pull is normal noise
    inst['last_ok_at'] = nd.iso(nd.utcnow())
    inst.pop('last_error', None)
    if (inbox / 'builder-status.json').exists():
        shutil.copy2(inbox / 'builder-status.json', STATE / 'builder-status.json')
    for name in nd.ORDER:
        m = nd.read_json(inbox / f'{name}.json')
        if not m or not m.get('sha256'):
            continue
        ds = inst.setdefault('datasets', {}).setdefault(name, {})
        if m['sha256'] == installed_sha(name) or m['sha256'] in ds.get('rejected', []):
            continue
        if ds.get('seen_sha256') != m['sha256']:
            ds['seen_sha256'], ds['seen_at'] = m['sha256'], nd.iso(nd.utcnow())
        try:
            install_one(name, m, ds)
        except (InstallError, OSError) as e:
            failed += 1
            ds['last_error'] = f"{nd.iso(nd.utcnow())} {m['file']}: {e}"
            mail('install-' + name, f'{name} not installed', f"{m['file']} (built {m.get('built_at')}): {e}\nThe live copy stays in place.")
        nd.write_json(STATE / 'install-state.json', inst)
    nd.write_json(STATE / 'install-state.json', inst)
    for line in nd.write_status(DATA, STATE):
        log('status ' + json.dumps({k: line.get(k) for k in ('dataset', 'state', 'source_date', 'built_at', 'confirmed_at', 'rows')}))
    return 1 if failed else 0


def rollback(name):
    spec = nd.DATASETS[name]
    live, prev = DATA / spec['file'], DATA / (spec['file'] + '.prev')
    if not prev.exists():
        print(f'no {prev}: nothing to roll back to', file=sys.stderr)
        return 1
    inst = nd.read_json(STATE / 'install-state.json', {}) or {}
    ds = inst.setdefault('datasets', {}).setdefault(name, {})
    cur = live_manifest(name)
    if cur and cur.get('sha256'):
        ds.setdefault('rejected', []).append(cur['sha256'])
        del ds['rejected'][:-KEEP_REJECTED]
    tmp = DATA / f".{spec['file']}.rollback.tmp"
    tmp.unlink(missing_ok=True)
    os.link(prev, tmp)
    os.replace(tmp, live)
    fsync_dir(DATA)
    pm = nd.read_json(STATE / 'live' / f'{name}.prev.json')
    if pm:
        st = live.stat()
        nd.write_json(STATE / 'live' / f'{name}.json', {**pm, 'inode': st.st_ino, 'size': st.st_size, 'rolled_back_at': nd.iso(nd.utcnow())})
    else:
        (STATE / 'live' / f'{name}.json').unlink(missing_ok=True)  # a hand-installed file: its own metadata describes it
    ds['rolled_back_at'] = nd.iso(nd.utcnow())
    nd.write_json(STATE / 'install-state.json', inst)
    nd.write_status(DATA, STATE)
    log(f"{name}: rolled back to {(pm or {}).get('file', prev.name)}; {str((cur or {}).get('sha256'))[:12]} will not be installed again")
    return 0


def main(argv):
    cmd = argv[0] if argv else 'pull'
    if cmd == 'status':
        lines = nd.write_status(DATA, STATE) if STATE.is_dir() and os.access(STATE, os.W_OK) else nd.status_lines(DATA, STATE)
        for line in lines:
            print(json.dumps(line, sort_keys=True))
        return 0
    STATE.mkdir(parents=True, exist_ok=True)
    with open(STATE / 'install.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('another install run holds the lock', file=sys.stderr)
            return 2
        if cmd == 'pull':
            return pull()
        if cmd == 'rollback' and len(argv) == 2 and argv[1] in nd.DATASETS:
            return rollback(argv[1])
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

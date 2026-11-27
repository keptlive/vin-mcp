#!/usr/bin/env python3
"""Build data/nhtsa-ratings.db, mcp.vin's local copy of NHTSA's 5-Star Safety Ratings, from the crawl state written by
scripts/harvest-nhtsa-ratings.py (the API answers themselves, stored verbatim).

Tables: years (model years the API lists, and whether each year's make list was crawled cleanly), makes, models
(with the same flag for their lists), variants (the list call's VehicleId + VehicleDescription in the API's order)
and ratings (each VehicleId answer's Results[0], verbatim JSON). lib/nhtsa-local.mjs answers from it and asks the
live API whenever a list or rating it needs was not crawled cleanly.

Usage: import-nhtsa-ratings.py --state ratings-crawl.db --out data/nhtsa-ratings.db [--previous data/nhtsa-ratings.db]
Atomic; refuses a build with over 1% fewer rated variants than the previous file (--allow-shrink overrides)."""
import argparse, datetime, json, os, sqlite3, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
SCHEMA_VERSION = 1


def key(text):
    return ' '.join(str(text).upper().split())


def load_harvest():
    import importlib.util
    spec = importlib.util.spec_from_file_location('harvest', Path(__file__).resolve().parent / 'harvest-nhtsa-ratings.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


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


def build(state, target, previous=None, allow_shrink=False):
    hv = load_harvest()
    src = sqlite3.connect(f'file:{state}?mode=ro', uri=True)
    resp = {}
    for path, status, body in src.execute('SELECT path, status, body FROM responses'):
        resp[path] = json.loads(body) if status == 'ok' and body else None
    runs = src.execute('SELECT run, started_at, finished_at, summary FROM runs ORDER BY run').fetchall()
    src.close()
    target = Path(target)
    temp = target.with_name(f'.{target.name}.build-{os.getpid()}')
    temp.unlink(missing_ok=True)
    db = sqlite3.connect(temp)
    try:
        db.executescript('''PRAGMA journal_mode=OFF;
            CREATE TABLE years(year INTEGER PRIMARY KEY, makes_ok INTEGER NOT NULL);
            CREATE TABLE makes(year INTEGER NOT NULL, make_key TEXT NOT NULL, make TEXT NOT NULL, models_ok INTEGER NOT NULL,
              PRIMARY KEY(year, make_key)) WITHOUT ROWID;
            CREATE TABLE models(year INTEGER NOT NULL, make_key TEXT NOT NULL, model_key TEXT NOT NULL, model TEXT NOT NULL,
              variants_ok INTEGER NOT NULL, PRIMARY KEY(year, make_key, model_key)) WITHOUT ROWID;
            CREATE TABLE variants(year INTEGER NOT NULL, make_key TEXT NOT NULL, model_key TEXT NOT NULL, ord INTEGER NOT NULL,
              vehicle_id INTEGER NOT NULL, description TEXT, PRIMARY KEY(year, make_key, model_key, ord)) WITHOUT ROWID;
            CREATE TABLE ratings(vehicle_id INTEGER PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT);''')
        top = resp.get(hv.path_years())
        counts = {'years': 0, 'makes': 0, 'models': 0, 'variants': 0, 'rated_variants': 0, 'gaps': 0}
        gaps = []
        if top:
            for y in sorted({int(r['ModelYear']) for r in top['Results'] if str(r.get('ModelYear', '')).isdigit()}):
                makes = resp.get(hv.path_makes(y))
                db.execute('INSERT INTO years VALUES(?,?)', (y, 1 if makes else 0))
                counts['years'] += 1
                if not makes:
                    gaps.append(hv.path_makes(y))
                    continue
                for mk in makes['Results']:
                    make = mk.get('Make')
                    if not make:
                        continue
                    models = resp.get(hv.path_models(y, make))
                    if db.execute('SELECT 1 FROM makes WHERE year=? AND make_key=?', (y, key(make))).fetchone():
                        continue
                    db.execute('INSERT INTO makes VALUES(?,?,?,?)', (y, key(make), make, 1 if models else 0))
                    counts['makes'] += 1
                    if not models:
                        gaps.append(hv.path_models(y, make))
                        continue
                    for md in models['Results']:
                        model = md.get('Model')
                        if not model or db.execute('SELECT 1 FROM models WHERE year=? AND make_key=? AND model_key=?', (y, key(make), key(model))).fetchone():
                            continue
                        variants = resp.get(hv.path_variants(y, make, model))
                        db.execute('INSERT INTO models VALUES(?,?,?,?,?)', (y, key(make), key(model), model, 1 if variants else 0))
                        counts['models'] += 1
                        if not variants:
                            gaps.append(hv.path_variants(y, make, model))
                            continue
                        for i, v in enumerate(variants['Results']):
                            vid = v.get('VehicleId')
                            if not isinstance(vid, int) or vid <= 0:
                                continue
                            db.execute('INSERT INTO variants VALUES(?,?,?,?,?,?)', (y, key(make), key(model), i, vid, v.get('VehicleDescription')))
                            counts['variants'] += 1
                            detail = resp.get(hv.path_detail(vid))
                            r0 = (detail or {}).get('Results') or []
                            if r0 and isinstance(r0[0], dict):
                                db.execute('INSERT OR REPLACE INTO ratings VALUES(?,?)', (vid, json.dumps(r0[0], separators=(',', ':'))))
                                counts['rated_variants'] += 1
                            elif detail is None:
                                gaps.append(hv.path_detail(vid))
        counts['gaps'] = len(gaps)
        prev = previous_counts(previous)
        if prev and not allow_shrink and prev.get('rated_variants') and counts['rated_variants'] < prev['rated_variants'] * 0.99:
            raise ValueError(f"rated variants fell from {prev['rated_variants']} to {counts['rated_variants']}: refusing to replace the previous file")
        if not top or counts['rated_variants'] == 0:
            raise ValueError('The crawl holds no ratings')
        # The data's date is the end of the last crawl that went through every year in its scope (a stopped crawl
        # refreshed only part of it); the server treats the copy as stale 45 days after it.
        def complete(summary):
            try:
                return bool(json.loads(summary or '{}').get('complete'))
            except ValueError:
                return False
        fetched = [r for r in runs if r[2] and complete(r[3])]
        meta = {'schema': SCHEMA_VERSION, 'dataset': 'nhtsa_ratings', 'years_ok': bool(top),
                'source': 'NHTSA 5-Star Safety Ratings API (api.nhtsa.gov/SafetyRatings), crawled by scripts/harvest-nhtsa-ratings.py',
                'first_crawl_at': runs[0][1] if runs else None, 'last_crawl_finished_at': fetched[-1][2] if fetched else None,
                'built_at': datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat(),
                'counts': counts, 'gaps': gaps[:500]}
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
    ap.add_argument('--state', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--previous')
    ap.add_argument('--allow-shrink', action='store_true')
    a = ap.parse_args(argv)
    meta = build(a.state, a.out, a.previous or a.out, a.allow_shrink)
    print(json.dumps({k: v for k, v in meta.items() if k != 'gaps'}, indent=1))


if __name__ == '__main__':
    main()

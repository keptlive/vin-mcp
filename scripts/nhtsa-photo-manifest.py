#!/usr/bin/env python3
"""The NHTSA test-vehicle photo index, in two steps around the image build (scripts/build-nhtsa-photos.py).

  select LISTINGS TESTS OUT_MANIFEST
      LISTINGS: folder of saved get-multimedia-files/<test_no>.json replies (NHTSA vehicle crash-test database);
      TESTS: the database's by-search rows (JSON Lines: testNo, testConfiguration, impactAngle, closingSpeed, testType).
      For every crash test the site can match (a test_no in data-src/test-vehicle-specs.jsonl or tire-placards.jsonl),
      choose the photos by file name (scripts/nhtsa_photo_select.py) and write the build manifest (JSON Lines).
  index OUT_MANIFEST BUILT
      BUILT: built.jsonl from the image build. Writes data-src/test-vehicle-photos.jsonl (+ .meta.json): one row per
      test with at least one built photo, its vPIC key (from the specs/placard row of the same test) and each photo's
      sizes. Photos the build left out (narrow, failed) are not listed.

Never guesses: a test whose names give no clear whole-car view gets no row."""
import datetime, json, os, re, sys, urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))
from nhtsa_photo_select import choose, test_kind, struck_side  # noqa: E402

KEY_FIELDS = ('make', 'model', 'model_year', 'tested_as', 'vpic_trim', 'vpic_series', 'body_class', 'drive_type', 'fuel_type', 'ev_type',
              'powertrain', 'report_url', 'test_type', 'vpic_extra')
OUT = ROOT / 'data-src/test-vehicle-photos.jsonl'
NRD = 'https://nrd-static.nhtsa.dot.gov/'


def stem_of(test_no, p):
    """Our file name for one photo (no extension): NHTSA's own 'v10060P001' for the classic listings; for the newer
    listings, whose file name is the lab's long name ('No. 001 - As-Delivered ... .jpg'), 'v15334N001' from the
    listing's index. None when neither is usable."""
    m = re.fullmatch(r'(v\d{5}P\d{3,4})\.(?:jpe?g|png)', str(p.get('fileName') or ''), re.I)
    if m:
        return m.group(1)
    if isinstance(p.get('index'), int) and 0 < p['index'] < 10000 and 0 < test_no < 100000:
        return f'v{test_no:05d}N{p["index"]:03d}'
    return None


def site_tests():
    """test_no -> the specs (else placard) row of that crash test: the vPIC key the site matches on."""
    rows = {}
    for name in ('tire-placards.jsonl', 'test-vehicle-specs.jsonl'):  # specs rows win
        for line in open(ROOT / 'data-src' / name):
            r = json.loads(line)
            if isinstance(r.get('test_no'), int):
                rows[r['test_no']] = r
    return rows


def select(listings, tests_path, out_path):
    tests = {}
    for line in open(tests_path):
        t = json.loads(line)
        tests[int(t['testNo'])] = t
    site = site_tests()
    n_tests = n_photos = 0
    with open(out_path, 'w') as out:
        for test_no in sorted(site):
            t = tests.get(test_no)
            f = Path(listings) / f'{test_no}.json'
            if not t or not f.exists():
                continue
            listing = json.loads(f.read_text())
            photos = [{'file': p['fileName'], 'name': p.get('originalFileName'), 'media': p.get('media'), 'stem': stem_of(test_no, p)}
                      for res in listing.get('results') or [] for p in res.get('photos') or []]
            kind = test_kind(t.get('testConfiguration'), t.get('impactAngle'))
            kept = choose(photos, kind, struck_side(t.get('impactAngle')))
            kept = [p for p in kept if p['stem'] and str(p.get('media') or '').startswith(NRD)]
            if not kept:
                continue
            out.write(json.dumps({'test_no': test_no, 'test_kind': kind, 'struck_side': struck_side(t.get('impactAngle')),
                                  'closing_speed_kmh': t.get('closingSpeed'), 'test_type_nhtsa': t.get('testType'),
                                  'test_configuration': t.get('testConfiguration'),
                                  'photos': [{'file': p['file'], 'stem': p['stem'], 'media': p['media'], 'name': p['name'], 'phase': p['phase'],
                                              'view': p['view'], 'web': p['web']} for p in kept]}) + '\n')
            n_tests += 1
            n_photos += len(kept)
    print(json.dumps({'tests': n_tests, 'photos': n_photos, 'manifest': str(out_path)}))


def index(manifest_path, built_path):
    built = {}
    for line in open(built_path):
        r = json.loads(line)
        built[(r['test_no'], r['file'])] = r
    site = site_tests()
    rows = []
    total = {'photos': 0, 'bytes': 0, 'left_out': 0}
    for line in open(manifest_path):
        m = json.loads(line)
        s = site.get(m['test_no'])
        if not s:
            continue
        photos = []
        for p in m['photos']:
            b = built.get((m['test_no'], p['file']))
            if not b or b.get('skipped') or 'w960' not in b:
                total['left_out'] += 1
                continue
            photos.append({'stem': p['stem'], 'phase': p['phase'], 'view': p['view'], 'web': p['web'],
                           'w960': {k: b['w960'][k] for k in ('width', 'height', 'bytes')}, 'w320': {k: b['w320'][k] for k in ('width', 'height', 'bytes')},
                           'nhtsa_url': NRD + urllib.parse.quote(p['media'][len(NRD):], safe='/'), 'original_file_name': p['name']})
            total['photos'] += 1
            total['bytes'] += b['w960']['bytes'] + b['w320']['bytes']
        if not photos:
            continue
        row = {k: s.get(k) for k in KEY_FIELDS}
        row.update({'test_no': m['test_no'], 'test_kind': m['test_kind'], 'struck_side': m['struck_side'],
                    'closing_speed_kmh': m['closing_speed_kmh'], 'photos': photos})
        rows.append(row)
    rows.sort(key=lambda r: (r['make'], r['model'], r['model_year'], r['test_no']))
    with open(OUT, 'w') as fh:
        for r in rows:
            fh.write(json.dumps(r, separators=(',', ':')) + '\n')
    meta = {'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
            'source': 'NHTSA vehicle crash-test database (nrd.api.nhtsa.dot.gov get-multimedia-files) photo listings; photos from '
                      'nrd-static.nhtsa.dot.gov (photos/vehdb and vehdb/<test>/photos), chosen by file name (scripts/nhtsa_photo_select.py), resized to WebP '
                      '(fit 960x720 and 320x240, no metadata) by scripts/build-nhtsa-photos.py. Keys from the vPIC decode of each '
                      'test vehicle\'s VIN (data-src/test-vehicle-specs.jsonl, tire-placards.jsonl).',
            'tests': len(rows), 'photos': total['photos'], 'image_bytes': total['bytes'], 'left_out_by_build': total['left_out'],
            'pre_test_tests': sum(1 for r in rows if any(p['phase'] == 'pre' for p in r['photos'])),
            'crash_view_tests': sum(1 for r in rows if any(p['phase'] != 'pre' for p in r['photos']))}
    (ROOT / 'data-src/test-vehicle-photos.meta.json').write_text(json.dumps(meta, indent=1) + '\n')
    print(json.dumps(meta, indent=1))


if __name__ == '__main__':
    if len(sys.argv) >= 5 and sys.argv[1] == 'select':
        select(*sys.argv[2:5])
    elif len(sys.argv) >= 4 and sys.argv[1] == 'index':
        index(*sys.argv[2:4])
    else:
        sys.exit(__doc__)

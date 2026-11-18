#!/usr/bin/env python3
"""Download the chosen NHTSA crash-test photos once and resize them for the web (run on a build server, not the
web server and not over a metered link: the originals are about 1.5 MB each).

Input: a manifest (JSON Lines), one test per line: {"test_no": 10060, "photos": [{"file": "v10060P006.jpg",
"stem": "v10060P006", "media": "https://nrd-static.nhtsa.dot.gov/photos/vehdb/..."}...]} (scripts/nhtsa-photo-manifest.py
writes it; `stem` names our files).
Output folder (OUT):
  <test_no>/<stem>-960.webp   fits 960 x 720, the report's main photo
  <test_no>/<stem>-320.webp   fits 320 x 240, the thumbnail
  built.jsonl                 one line per photo: sizes, dimensions, sha256 of each file, or the reason it was left out
  DONE / FAILED               written on exit
Originals are kept in ORIG (a cache, so sizes can be re-made without downloading again).

Rules: one connection, requests started at least GAP seconds apart (default 1.0), a generic client name, files only
from nrd-static.nhtsa.dot.gov. It stops (FAILED, exit 3) on HTTP 429, on any 5xx, on 3 HTTP 403 answers in a row, or
after 5 errors in a row, and never retries around a block. A single 403 is a missing file: nrd-static answers a
listed-but-absent photo with 403 and an empty S3-style XML body (seen 2026-11-18 for v15409P105.jpg while the
next photo of the same test loaded), so it is recorded and left out. `touch OUT/STOP` stops it cleanly (exit 4). Resumable: photos already in
built.jsonl are skipped. A photo narrower than MIN_WIDTH px, or one that cannot be decoded, is left out (recorded).

Usage: python3 build-nhtsa-photos.py MANIFEST OUT ORIG [--limit N]
Needs Pillow with WebP support."""
import hashlib, io, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request
from PIL import Image, ImageOps

UA = 'Mozilla/5.0 (compatible; photo-index-builder/1.0)'
GAP = float(os.environ.get('PHOTO_GAP', '1.0'))
HOST = 'https://nrd-static.nhtsa.dot.gov/'
SIZES = ((960, 720, 74), (320, 240, 70))  # box width, box height, WebP quality
MIN_WIDTH = 640
MAX_BYTES = 40 * 1024 * 1024


class Blocked(Exception):
    pass


class Missing(Exception):
    pass


def log(msg):
    print(time.strftime('%Y-%m-%d %H:%M:%S'), msg, flush=True)


_last = [0.0]


def fetch(url, dest):
    """GET url into dest (bytes kept as served). Raises Blocked on 403/429/5xx; urllib errors otherwise."""
    if not url.startswith(HOST):
        raise ValueError(f'not an nrd-static URL: {url}')
    wait = GAP - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    _last[0] = time.time()
    # The listing's URLs are raw (the newer ones hold spaces): only the path is quoted.
    req = urllib.request.Request(HOST + urllib.parse.quote(url[len(HOST):], safe='/'), headers={'User-Agent': UA, 'Accept-Encoding': 'identity'})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            if r.headers.get('Content-Encoding', 'identity') not in ('', 'identity'):
                raise ValueError('unexpected content encoding')
            data = r.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as err:
        if err.code == 429 or err.code >= 500:
            raise Blocked(f'HTTP {err.code} {url}')
        if err.code == 403:
            raise Missing(f'HTTP 403 {url}')
        raise
    if len(data) > MAX_BYTES:
        raise ValueError('too big')
    tmp = dest + '.part'
    with open(tmp, 'wb') as fh:
        fh.write(data)
    os.replace(tmp, dest)
    return len(data)


def resize(src, out_dir, stem):
    """The web sizes of one original; returns the record fields."""
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        im = im.convert('RGB')
        ow, oh = im.size
        if ow < MIN_WIDTH:
            return {'skipped': f'narrow_{ow}x{oh}', 'orig_w': ow, 'orig_h': oh}
        rec = {'orig_w': ow, 'orig_h': oh}
        for bw, bh, q in SIZES:
            copy = im.copy()
            copy.thumbnail((bw, bh), Image.LANCZOS)
            buf = io.BytesIO()
            copy.save(buf, 'WEBP', quality=q, method=5)  # no EXIF or other metadata is written
            data = buf.getvalue()
            name = f'{stem}-{bw}.webp'
            with open(os.path.join(out_dir, name + '.part'), 'wb') as fh:
                fh.write(data)
            os.replace(os.path.join(out_dir, name + '.part'), os.path.join(out_dir, name))
            rec[f'w{bw}'] = {'file': name, 'width': copy.size[0], 'height': copy.size[1], 'bytes': len(data),
                             'sha256': hashlib.sha256(data).hexdigest()}
        return rec


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    limit = int(sys.argv[sys.argv.index('--limit') + 1]) if '--limit' in sys.argv else None
    manifest, out, orig = args[:3]
    os.makedirs(out, exist_ok=True)
    os.makedirs(orig, exist_ok=True)
    for f in ('DONE', 'FAILED'):
        if os.path.exists(os.path.join(out, f)):
            os.remove(os.path.join(out, f))
    built_path = os.path.join(out, 'built.jsonl')
    done = set()
    if os.path.exists(built_path):
        for line in open(built_path):
            r = json.loads(line)
            done.add((r['test_no'], r['file']))
    built = open(built_path, 'a')
    todo = [(t['test_no'], p) for line in open(manifest) if line.strip() for t in [json.loads(line)] for p in t['photos']
            if (t['test_no'], p['file']) not in done]
    log(f'{len(todo)} photos to do ({len(done)} already built), gap {GAP}s')
    errors_in_row = forbidden_in_row = n = fetched = 0
    t0 = time.time()
    try:
        for test_no, p in todo:
            if os.path.exists(os.path.join(out, 'STOP')):
                log('STOP file present; stopping')
                return 4
            if limit is not None and n >= limit:
                break
            n += 1
            stem = p['stem']
            if not re.fullmatch(r'v\d{5}[PN]\d{3,4}', stem or ''):
                raise ValueError(f'bad stem {stem!r}')
            src = os.path.join(orig, str(test_no), stem + (os.path.splitext(p['file'])[1].lower() or '.jpg'))
            os.makedirs(os.path.dirname(src), exist_ok=True)
            out_dir = os.path.join(out, str(test_no))
            os.makedirs(out_dir, exist_ok=True)
            rec = {'test_no': test_no, 'file': p['file'], 'media': p['media']}
            try:
                if not os.path.exists(src):
                    rec['orig_bytes'] = fetch(p['media'], src)
                    fetched += 1
                else:
                    rec['orig_bytes'] = os.path.getsize(src)
                errors_in_row = forbidden_in_row = 0
            except Blocked:
                raise
            except Missing as err:
                forbidden_in_row += 1
                rec['skipped'] = f'missing: {err}'[:200]
                built.write(json.dumps(rec) + '\n'); built.flush()
                log(f'missing {test_no} {p["file"]}: {err}')
                if forbidden_in_row >= 3:
                    raise Blocked('3 HTTP 403 answers in a row')
                continue
            except Exception as err:  # 404 and the like: recorded, the photo is left out
                errors_in_row += 1
                rec['skipped'] = f'fetch_error: {err}'[:200]
                built.write(json.dumps(rec) + '\n'); built.flush()
                log(f'error {test_no} {p["file"]}: {err}')
                if errors_in_row >= 5:
                    raise Blocked('5 errors in a row')
                continue
            try:
                rec.update(resize(src, out_dir, stem))
            except Exception as err:
                rec['skipped'] = f'decode_error: {err}'[:200]
            built.write(json.dumps(rec) + '\n'); built.flush()
            if n % 50 == 0:
                rate = fetched / max(1, time.time() - t0)
                log(f'{n}/{len(todo)} done, {fetched} fetched, {rate:.2f}/s')
    except Blocked as err:
        log(f'BLOCKED/ERRORS: {err}; stopping')
        open(os.path.join(out, 'FAILED'), 'w').write(str(err) + '\n')
        return 3
    except Exception as err:
        log(f'FAILED: {err!r}')
        open(os.path.join(out, 'FAILED'), 'w').write(repr(err) + '\n')
        return 2
    log(f'finished: {n} processed, {fetched} fetched')
    open(os.path.join(out, 'DONE'), 'w').write(time.strftime('%Y-%m-%dT%H:%M:%S') + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())

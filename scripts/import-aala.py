#!/usr/bin/env python3
"""Index NHTSA's Part 583 (American Automobile Labeling Act) "alphabetical" reports: per carline and model
year, the percentage of US/Canadian parts content, the other major source countries, the final assembly
countries and the countries of origin of the engine and the transmission, as manufacturers report them.

The reports are PDF tables only. Text is read with pdfminer.six character positions (lazy import, so the
tests run without it) and grouped into cells by horizontal gaps. Nothing is guessed:
 - left-hand cells go to the nearest of the Manufacturers / Makes / Carlines headers;
 - origin cells go to the header column whose printed span contains them. A cell printed between two
   columns could belong to either, so both columns are left empty for that row and flagged unreadable_*
   (the parts-content percentages, read from their own columns, stay); a cell that cannot be placed at all
   rejects the row (kept in the rejects table with its cells);
 - a cell printed on a neighbour baseline joins the nearest row (wrapped text, joined in reading order);
 - a manufacturer or make printed once for a group of rows is filled down and flagged;
 - US/Canadian % plus the other countries' % above 100 rejects the row.
Country codes are decoded only with the legend printed in the same file ("Country List"); codes the legend
does not list stay as printed.

usage: python3 scripts/import-aala.py [--years 2020-2027]   (needs pdfminer.six, e.g. a venv)
Builds data/aala.db atomically from PDFs cached in operations/free-data/aala/ (downloads missing ones)."""
from pathlib import Path
from urllib.request import Request, urlopen
import datetime, hashlib, json, os, re, sqlite3, statistics, sys, time

ROOT = Path(__file__).resolve().parent.parent
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
BASE = 'https://www.nhtsa.gov/sites/nhtsa.gov/files/'
# Newest edition of each model year's alphabetical report found on nhtsa.gov (the listing page itself
# refuses scripted requests, so the file links are kept here). Update when NHTSA posts a newer edition.
FILES = {
    2020: 'documents/2020_aala_alpha_1-26-21.pdf',
    2021: '2021-06/MY2021-AALA-Alphabetical-6-30-21.pdf',
    2022: '2022-09/MY2022-AALA-Alphabetical-8-30-22.pdf',
    2023: '2023-03/MY2023-AALA-Alphabetical-3-31-23.pdf',
    2024: '2025-02/MY2024-AALA-Alphabetical-2.4.25.pdf',
    2025: '2025-04/MY2025-AALA-Alphabetical%204_7_2025.pdf',
    2026: '2026-06/MY2026-AALA-Alphabetical-06-08-26.pdf',
    2027: '2026-06/MY2027-AALA-Alphabetical-06-08-26.pdf',
}
DEFAULT_YEARS = range(2020, 2028)
TYPES = {'PC', 'MPV', 'TRUCK', 'LDT', 'MDPV', 'BUS', 'MPV/TRUCK'}
GAP = 1.6       # a cell break is a gap wider than GAP x the median character width
NEAR = 8        # points: a cell on a neighbour baseline belongs to the nearest row within this distance
PAD = 4         # points of slack around a header column's printed span
ORIGIN_COLUMNS = ('final', 'final_add', 'engine', 'engine_add', 'trans', 'trans_add')


def compact(text):
    """Letters and digits only, upper case. Must match lib/aala.mjs."""
    return ''.join(re.findall(r'[A-Z0-9]+', str(text or '').upper()))


def pdf_pages(path):
    """[[(y, [(x0, x1, text)])]] per page, top to bottom, using pdfminer character positions."""
    try:
        from pdfminer.high_level import extract_pages
        from pdfminer.layout import LTChar, LAParams
    except ImportError:
        sys.exit('pdfminer.six is needed: pip install pdfminer.six (in a venv), then run this script with that python')
    pages = []
    for layout in extract_pages(str(path), laparams=LAParams()):
        chars = []
        def walk(o):
            if isinstance(o, LTChar):
                chars.append(o)
            elif hasattr(o, '__iter__'):
                for c in o:
                    walk(c)
        walk(layout)
        if not chars:
            pages.append([]); continue
        cw = statistics.median([c.width for c in chars if c.get_text().strip()] or [3])
        buckets = {}
        for c in chars:
            buckets.setdefault(round((c.y0 + c.y1) / 2 / 1.5), []).append(c)
        rows = []
        for k in sorted(buckets, reverse=True):
            cells, cur, last = [], None, None
            for c in sorted(buckets[k], key=lambda c: c.x0):
                if last is not None and c.x0 - last > GAP * cw:
                    cells.append(cur); cur = None
                if cur is None:
                    cur = [c.x0, c.x1, '']
                cur[1] = c.x1
                cur[2] += c.get_text()
                last = c.x1
            if cur:
                cells.append(cur)
            cells = [(round(a, 1), round(b, 1), re.sub(r'\s+', ' ', s).strip()) for a, b, s in cells if s.strip()]
            if cells:
                rows.append((round(k * 1.5, 1), cells))
        pages.append(rows)
    return pages


def centre(c):
    return (c[0] + c[1]) / 2


def header_columns(cells, type_x1):
    """Origin columns from the header cells right of the vehicle-type column: cells that overlap
    horizontally form one column; its label comes from the words it prints."""
    clusters = []
    for c in sorted((c for c in cells if c[0] > type_x1), key=lambda c: c[0]):
        for cl in clusters:
            if c[0] <= cl['x1'] - 2 and c[1] >= cl['x0'] + 2:
                cl['x0'], cl['x1'] = min(cl['x0'], c[0]), max(cl['x1'], c[1]); cl['text'] += ' ' + c[2]; break
        else:
            clusters.append({'x0': c[0], 'x1': c[1], 'text': c[2]})
    columns = []
    for cl in clusters:
        t = cl['text'].lower()
        add = 'additional' in t
        if 'percent' in t and ('us/' in t or 'canada' in t) and 'other' not in t:
            name = 'us_canada'
        elif 'percent content other' in t or 'major sources' in t or 'foreign parts' in t:
            name = 'foreign'
        elif 'final' in t:
            name = 'final_add' if add else 'final'
        elif 'engine' in t or 'motor' in t:
            name = 'engine_add' if add else 'engine'
        elif 'transmission' in t:
            name = 'trans_add' if add else 'trans'
        else:
            name = None
        if name:
            columns.append((name, cl['x0'] - PAD, cl['x1'] + PAD))
    return columns


def parse_pages(pages, model_year):
    """Cell rows of one report -> (rows, rejects, legend). Pure, so it is testable without pdfminer."""
    rows, rejects, legend = [], [], {}
    left, columns, type_span, prev = None, None, None, {}
    in_legend, legend_x, pending = False, None, ''
    for pno, page in enumerate(pages, 1):
        # Legend ("Country List"): code and name side by side after the table, sometimes over two pages.
        start = None
        for i, (y, cells) in enumerate(page):
            if not in_legend and any(c[2] == 'Australia' for c in cells):
                in_legend, legend_x, start = True, next(c for c in cells if c[2] == 'Australia'), i
                break
        body = page if start is None and not in_legend else page[:start] if start is not None else []
        if in_legend:
            for y, cells in page[start or 0:]:
                # names are printed left-aligned in some years and centred in others
                name = next((c for c in cells if (abs(c[0] - legend_x[0]) <= 3 or abs(centre(c) - centre(legend_x)) <= 3)
                             and re.fullmatch(r"[A-Za-z][A-Za-z .'-]*", c[2])), None)
                if not name:
                    continue
                code = next((c for c in cells if c is not name and abs(c[1] - name[0]) <= 80 and re.fullmatch(r'[A-Z]{1,3}', c[2])), None)
                if code:
                    legend[code[2]] = (pending + ' ' + name[2]).strip(); pending = ''
                else:
                    pending = (pending + ' ' + name[2]).strip()  # "Czech" / "Republic"
        first = next((i for i, (y, cells) in enumerate(body) if any(c[2].upper() in TYPES for c in cells)), None)
        if first is None:
            continue
        header = [c for y, cells in body[:first] for c in cells if 'AALA' not in c[2]]  # not the page title
        types_hdr = [c for c in header if re.match(r'(?i)vehicle type|on part 567|certification|label$|567 cert', c[2])]
        if types_hdr:  # header printed on this page; later pages without one reuse it
            type_span = (min(c[0] for c in types_hdr) - 10, max(c[1] for c in types_hdr) + 10)
            columns = header_columns(header, type_span[1] - 10)
            anchors = [(col, centre(c)) for col, pat in (('manufacturer', r'^Manufacturers'), ('make', r'^Makes'), ('carline', r'^Carlines')) for c in header if re.search(pat, c[2])]
            left = anchors if len({a[0] for a in anchors}) == 3 else None
        if not columns or not left:
            continue
        is_type = lambda c: c[2].upper() in TYPES and type_span[0] <= c[0] <= type_span[1]
        data = [(y, [(c, y) for c in cells]) for y, cells in body[first:] if any(is_type(c) for c in cells)]
        for y, cells in body[first:]:
            if any(is_type(c) for c in cells) or not data:
                continue
            j = min(range(len(data)), key=lambda k: abs(data[k][0] - y))
            if abs(data[j][0] - y) <= NEAR:
                data[j][1].extend((c, y) for c in cells)
        for y, placed in data:
            placed.sort(key=lambda p: (-p[1], p[0][0]))  # reading order: top line first, then left to right
            tcell = next(c for c, _ in placed if is_type(c))
            rec = {'model_year': model_year, 'page': pno, 'vehicle_type': tcell[2].upper()}
            got, unplaced, notes, flags, foreign, unreadable = {}, [], [], [], [], set()
            for c, cy in placed:
                if c is tcell:
                    continue
                if c[1] <= tcell[0]:
                    col = min(left, key=lambda a: abs(a[1] - centre(c)))[0]
                elif re.fullmatch(r'\d{1,3}%', c[2]) and any(n == 'us_canada' and a <= centre(c) <= b for n, a, b in columns):
                    if 'us_canada' in got:  # two percentages: two printed rows ran together
                        unplaced.append(c[2]); continue
                    got['us_canada'] = [(c[2], cy)]; continue
                elif re.fullmatch(r'\d{1,3} ?% ?[A-Za-z][A-Za-z .()]*', c[2]) and not any(n in ORIGIN_COLUMNS and a <= centre(c) <= b for n, a, b in columns):
                    m = re.fullmatch(r'(\d{1,3}) ?% ?(.+)', c[2]); foreign.append({'pct': int(m.group(1)), 'code': m.group(2).strip()}); continue
                else:
                    hits = [n for n, a, b in columns if a <= centre(c) <= b and n in ORIGIN_COLUMNS]
                    if hits:
                        col = hits[0]
                    elif centre(c) > max(b for _, _, b in columns):
                        notes.append(c[2]); continue
                    else:
                        # Between two origin columns: it belongs to one of them, and the file does not say
                        # which. Both neighbours become unreadable for this row (never guessed).
                        origin = [(n, a, b) for n, a, b in columns if n in ORIGIN_COLUMNS]
                        before = [n for n, a, b in origin if b < centre(c)]
                        after = [n for n, a, b in origin if a > centre(c)]
                        if not after:
                            unplaced.append(c[2]); continue
                        unreadable.update(([before[-1]] if before else []) + [after[0]])
                        continue
                got.setdefault(col, []).append((c[2], cy))
            for col, parts in got.items():
                if col == 'us_canada':
                    continue
                lines = {}
                for text, cy in parts:
                    lines.setdefault(cy, []).append(text)
                off = sorted(k - y for k in lines if k != y)
                # Three printed lines centred on the baseline (one above, one below, same distance) are one cell.
                centred = len(off) == 2 and off[0] < 0 < off[1] and abs(off[0] + off[1]) <= 1.5
                if len(lines) > 1 and not centred:
                    # A cell printed over two lines sits above and below the row's baseline. When the
                    # baseline itself also holds text for this column, the extra line may be the
                    # neighbour row's wrapped cell: an origin column is left unreadable, not joined.
                    if col in ORIGIN_COLUMNS and y in lines:
                        unreadable.add(col); continue
                    if y in lines:  # the same for names: the carline rejects the row, other names are dropped
                        if col == 'carline':
                            unplaced.extend(t for k, v in lines.items() if k != y for t in v)
                        else:
                            flags.append('unreadable_' + col)
                        continue
                if len(lines) > 1:
                    flags.append('joined_' + col)
                rec[col] = ' '.join(', '.join(v) for _, v in sorted(lines.items(), key=lambda kv: -kv[0]))
                # "Leipzig," or "US (3.6L," : the rest of the printed cell went to another row.
                if col in ORIGIN_COLUMNS and (rec[col].endswith((',', '(')) or rec[col].count('(') != rec[col].count(')')):
                    unreadable.add(col)
            for col in sorted(unreadable, key=ORIGIN_COLUMNS.index):
                rec.pop(col, None); flags.append('unreadable_' + col)
            for col in ('manufacturer', 'make'):  # printed once for a group of rows: fill down, flagged
                if col not in rec and prev.get(col) and 'unreadable_' + col not in flags:
                    rec[col] = prev[col]; flags.append('filled_down_' + col)
            if 'us_canada' in got:
                rec['us_canada_pct'] = int(got['us_canada'][0][0][:-1])
            rec['foreign'] = sorted(foreign, key=lambda f: -f['pct'])
            if notes:
                rec['notes'] = '; '.join(notes)
            rec['flags'] = flags
            reason = ('unplaced_cells' if unplaced else
                      'missing_carline' if not rec.get('carline') else
                      'missing_make' if not rec.get('make') else
                      'missing_us_canada_pct' if 'us_canada_pct' not in rec else
                      'missing_final_assembly' if not rec.get('final') and 'final' not in unreadable else
                      'percent_over_100' if rec['us_canada_pct'] + sum(f['pct'] for f in foreign) > 100 else None)
            if reason:
                rejects.append({'model_year': model_year, 'page': pno, 'reason': reason, 'unplaced': unplaced, 'cells': [c[2] for c, _ in placed], 'parsed': rec})
            else:
                rows.append(rec)
            prev = rec
    return rows, rejects, legend


def build(files, target):
    """files: [(model_year, name, path, url)]. Atomic; a failure keeps the old file."""
    temp = target.with_name('aala-build-' + str(os.getpid()) + '.db')
    db = sqlite3.connect(temp)
    try:
        db.executescript('''CREATE TABLE aala(model_year INTEGER NOT NULL,manufacturer TEXT,make TEXT NOT NULL,carline TEXT NOT NULL,
            vehicle_type TEXT,us_canada_pct INTEGER NOT NULL,foreign_sources TEXT NOT NULL,final_assembly TEXT,final_assembly_additional TEXT,
            engine TEXT,engine_additional TEXT,transmission TEXT,transmission_additional TEXT,notes TEXT,flags TEXT NOT NULL,page INTEGER,
            make_compact TEXT NOT NULL,carline_compact TEXT NOT NULL,source_file TEXT NOT NULL);
            CREATE INDEX by_vehicle ON aala(model_year,make_compact);
            CREATE TABLE rejects(model_year INTEGER NOT NULL,page INTEGER,reason TEXT NOT NULL,cells TEXT NOT NULL,unplaced TEXT);
            CREATE TABLE legends(model_year INTEGER NOT NULL,code TEXT NOT NULL,country TEXT NOT NULL,PRIMARY KEY(model_year,code));
            CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);''')
        sources = []
        for year, name, path, url in files:
            payload = Path(path).read_bytes()
            rows, rejects, legend = parse_pages(pdf_pages(path), year)
            if not rows:
                raise ValueError(f'No rows read from {name}')
            for r in rows:
                db.execute('INSERT INTO aala VALUES(' + ','.join('?' * 19) + ')', (
                    year, r.get('manufacturer'), r['make'], r['carline'], r['vehicle_type'], r['us_canada_pct'], json.dumps(r['foreign']), r.get('final'),
                    r.get('final_add'), r.get('engine'), r.get('engine_add'), r.get('trans'), r.get('trans_add'), r.get('notes'), json.dumps(r['flags']),
                    r['page'], compact(r['make']), compact(r['carline']), name))
            for x in rejects:
                db.execute('INSERT INTO rejects VALUES(?,?,?,?,?)', (year, x['page'], x['reason'], json.dumps(x['cells']), json.dumps(x['unplaced'])))
            db.executemany('INSERT INTO legends VALUES(?,?,?)', [(year, k, v) for k, v in legend.items()])
            reasons = {}
            for x in rejects:
                reasons[x['reason']] = reasons.get(x['reason'], 0) + 1
            total = len(rows) + len(rejects)
            sources.append({'model_year': year, 'file': name, 'url': url, 'sha256': hashlib.sha256(payload).hexdigest(), 'rows': len(rows),
                            'rejected': reasons, 'reject_rate': round(len(rejects) / total, 4), 'legend_codes': len(legend),
                            'flagged': sum(1 for r in rows if r['flags'])})
        metadata = {'sources': sources, 'indexed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    'page': 'https://www.nhtsa.gov/part-583-american-automobile-labeling-act-reports'}
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
    years = DEFAULT_YEARS
    if '--years' in sys.argv:
        a, _, b = sys.argv[sys.argv.index('--years') + 1].partition('-')
        years = range(int(a), int(b or a) + 1)
    cache = ROOT / 'operations/free-data/aala'
    cache.mkdir(parents=True, exist_ok=True)
    files = []
    for year in years:
        url = BASE + FILES[year]
        path = cache / FILES[year].split('/')[-1].replace('%20', ' ')
        if not path.exists():
            time.sleep(3)
            with urlopen(Request(url, headers={'User-Agent': UA}), timeout=120) as r:
                payload = r.read(10_000_001)
            if len(payload) > 10_000_000 or not payload.startswith(b'%PDF'):
                raise ValueError('Not a PDF or too large: ' + url)
            path.write_bytes(payload)
        files.append((year, path.name, path, url))
    target = ROOT / 'data/aala.db'
    target.parent.mkdir(exist_ok=True)
    print(json.dumps(build(files, target), indent=2))


if __name__ == '__main__':
    main()

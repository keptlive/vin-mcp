#!/usr/bin/env python3
"""Index NHTSA's final theft rates (49 CFR Part 541), with each vehicle line's production, from the
"Final Theft Data" notices in the Federal Register.

Each notice prints a table "... Theft Rates for Model Year YYYY Passenger Motor Vehicles Stolen in
Calendar Year YYYY": rank, manufacturer, make/model (vehicle line), thefts, production (as the
manufacturer reported it to EPA) and thefts per 1,000 vehicles produced. Federal Register XML exists
from mid-2000. The notices for model years 2011 (2014-02548), 2013 and 2014 print no table in the XML,
so coverage is model years 1998-2010 and 2012. When two notices carry the same model year (a
correction), the newer notice wins. A row whose printed rate differs from thefts / production x 1000
by more than rounding is kept as printed and flagged (rate_check='printed_rate_differs').

usage: python3 scripts/import-theft-rates.py [--refresh]
Builds data/theft-rates.db atomically from XML cached in operations/free-data/theft-rates/."""
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import datetime, hashlib, json, os, re, sqlite3, sys, time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
API = 'https://www.federalregister.gov/api/v1/documents'
# Honest client name (no browser imitation): if a source refuses it, stop and report, never disguise the request.
UA = 'mcp.vin-importer/1.0 (+https://mcp.vin)'
TITLE = re.compile(r'Theft Rates (?:for|of) (?:Model Year )?(\d{4})(?: Model Year)? .*Stolen in Calendar Year (\d{4})', re.I)


def compact(text):
    """Letters and digits only, upper case. Must match lib/theft-rates.mjs."""
    return ''.join(re.findall(r'[A-Z0-9]+', str(text or '').upper()))


def cell(e):
    return re.sub(r'\s+', ' ', ''.join(e.itertext())).strip()


def parse_notice(xml_bytes):
    """[(model_year, calendar_year, title, rows, total)] for every final theft-rate table in one notice.
    rows: dicts or ('rejected', reason); total: the printed all-lines total or None. A notice without a table gives []."""
    root = ET.fromstring(xml_bytes)
    tables = []
    for tab in root.iter('GPOTABLE'):
        t = tab.find('TTITLE')
        title = cell(t) if t is not None else ''
        m = TITLE.search(title)
        if not m:
            continue
        rows, total = [], None
        for row in tab.iter('ROW'):
            ents = [cell(e) for e in row.findall('ENT')]
            if ents and re.search(r'total|theft rate per', ents[0], re.I):  # the all-lines total row (some years print it)
                try:
                    total = {'thefts': int(ents[-3].replace(',', '')), 'production': int(ents[-2].replace(',', '')), 'rate': float(ents[-1].replace(',', ''))}
                except (ValueError, IndexError):
                    rows.append(('rejected', 'total_row_unreadable'))
                continue
            if len(ents) >= 6 and re.fullmatch(r'\d+', ents[0]):  # rank | manufacturer | line | thefts | production | rate
                rank, mfr, line, thefts, prod, rate = ents[:6]
            elif len(ents) >= 5 and re.match(r'\d+\.?\s', ents[0]):  # "rank manufacturer" or "rank. manufacturer" | line | ...
                rank, mfr = ents[0].split(None, 1)
                rank = rank.rstrip('.')
                line, thefts, prod, rate = ents[1:5]
            else:
                rows.append(('rejected', 'layout'))
                continue
            try:
                rec = {'rank': int(rank), 'manufacturer': mfr.strip(), 'line': line.strip(),
                       'thefts': int(thefts.replace(',', '')), 'production': int(prod.replace(',', '')), 'rate': float(rate.replace(',', ''))}
            except ValueError:
                rows.append(('rejected', 'not_a_number'))
                continue
            if rec['production'] <= 0 or rec['thefts'] < 0 or not rec['line']:
                rows.append(('rejected', 'implausible'))
                continue
            # Rates are printed to 4 decimals.
            rec['rate_check'] = 'ok' if abs(rec['thefts'] / rec['production'] * 1000 - rec['rate']) <= 0.00051 else 'printed_rate_differs'
            rows.append(rec)
        tables.append((int(m.group(1)), int(m.group(2)), title, rows, total))
    return tables


def build(notices, target):
    """notices: [{'document_number','publication_date','path','url'}]. Atomic; a failure keeps the old file."""
    temp = target.with_name('theft-rates-build-' + str(os.getpid()) + '.db')
    db = sqlite3.connect(temp)
    try:
        db.executescript('''CREATE TABLE theft_rates(model_year INTEGER NOT NULL,calendar_year INTEGER NOT NULL,rank INTEGER,
            manufacturer TEXT NOT NULL,line TEXT NOT NULL,line_compact TEXT NOT NULL,manufacturer_compact TEXT NOT NULL,thefts INTEGER NOT NULL,
            production INTEGER NOT NULL,rate REAL NOT NULL,rate_check TEXT NOT NULL,lines_in_table INTEGER NOT NULL,document_number TEXT NOT NULL,
            publication_date TEXT NOT NULL,source_url TEXT);
            CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);''')
        chosen, sources = {}, []
        for n in sorted(notices, key=lambda n: n['publication_date']):
            payload = Path(n['path']).read_bytes()
            tables = parse_notice(payload)
            sources.append({'document_number': n['document_number'], 'publication_date': n['publication_date'], 'url': n.get('url'),
                            'sha256': hashlib.sha256(payload).hexdigest(), 'tables': [{'model_year': t[0], 'rows': len(t[3])} for t in tables]})
            for my, cy, title, rows, total in tables:
                chosen[my] = (cy, title, rows, total, n)  # newer publication replaces an older one
        out, rejected, flagged, totals = [], {}, 0, {}
        for my, (cy, title, rows, total, n) in sorted(chosen.items()):
            if total:
                totals[str(my)] = total
            good = [r for r in rows if isinstance(r, dict)]
            for r in rows:
                if not isinstance(r, dict):
                    rejected[r[1]] = rejected.get(r[1], 0) + 1
            for r in good:
                flagged += r['rate_check'] != 'ok'
                out.append((my, cy, r['rank'], r['manufacturer'], r['line'], compact(r['line']), compact(r['manufacturer']), r['thefts'], r['production'],
                            r['rate'], r['rate_check'], len(good), n['document_number'], n['publication_date'], n.get('url')))
        if not out:
            raise ValueError('No theft-rate tables found')
        db.executemany('INSERT INTO theft_rates VALUES(' + ','.join('?' * 15) + ')', out)
        db.execute('CREATE INDEX by_year ON theft_rates(model_year)')
        metadata = {'sources': sources, 'model_years': sorted(chosen), 'rows': len(out), 'rows_rejected': rejected, 'rows_rate_flagged': flagged, 'printed_totals': totals,
                    'indexed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
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


def get(url, limit=5_000_000):
    time.sleep(3)  # gentle on federalregister.gov
    with urlopen(Request(url, headers={'User-Agent': UA}), timeout=120) as r:
        payload = r.read(limit + 1)
    if len(payload) > limit:
        raise ValueError('Download size limit: ' + url)
    return payload


def main():
    cache = ROOT / 'operations/free-data/theft-rates'
    cache.mkdir(parents=True, exist_ok=True)
    refresh = '--refresh' in sys.argv
    pages = sorted(cache.glob('search-*.json'))
    if refresh or not pages:
        params = {'conditions[agencies][]': 'national-highway-traffic-safety-administration', 'conditions[term]': '"Final Theft Data"',
                  'fields[]': ['title', 'publication_date', 'document_number', 'full_text_xml_url'], 'order': 'newest', 'per_page': 20}
        url, i, pages = API + '?' + urlencode(params, doseq=True), 1, []
        while url and i <= 10:
            data = get(url)
            page = cache / f'search-{i}.json'
            page.write_bytes(data)
            pages.append(page)
            url, i = json.loads(data).get('next_page_url'), i + 1
    notices = []
    for page in pages:
        for r in json.loads(page.read_bytes()).get('results', []):
            if not str(r.get('title', '')).startswith('Final Theft Data') or not r.get('full_text_xml_url'):
                continue
            path = cache / (r['document_number'] + '.xml')
            if refresh or not path.exists():
                path.write_bytes(get(r['full_text_xml_url']))
            notices.append({'document_number': r['document_number'], 'publication_date': r['publication_date'], 'path': path,
                            'url': 'https://www.federalregister.gov/d/' + r['document_number']})
    target = ROOT / 'data/theft-rates.db'
    target.parent.mkdir(exist_ok=True)
    print(json.dumps(build(notices, target), indent=2, default=str))


if __name__ == '__main__':
    main()

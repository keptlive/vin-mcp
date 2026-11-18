#!/usr/bin/env python3
"""Build data/vpic.db: the part of NHTSA's standalone vPIC database that VIN decoding needs (lib/vpic-local.mjs).

NHTSA publishes the whole vPIC database every month ("vPICList_lite_YYYY_MM", https://vpic.nhtsa.dot.gov/api/,
"Standalone vPIC database"). The PostgreSQL edition is a plain SQL dump: table data as COPY blocks plus NHTSA's
own decode functions (spvindecode). This script reads that dump directly -- no database server is needed -- and
writes a compact SQLite file holding the decode tables only:

  VIN patterns and schemas (per WMI and model-year range), WMIs, elements and their lookup lists, make/model,
  engine-model patterns, unit conversions, vehicle-spec patterns, default values, check-digit exceptions,
  VIN descriptors, error codes, and a compact form of the valid-character table used for error codes 2-5 and 14.

Left out: rows no decode can read (patterns of private NCSA elements without a '#' formula, elements with no
decode role, the WMI rows 26/27/29/39 that the pattern step skips) and the 8.8 million-row valid-character
table, which is folded into one string per WMI and year. The valid characters each schema's patterns allow are
precomputed (the fallback NHTSA uses when the cached table has no row for a WMI and year), so the left-out
pattern rows still count there.

NHTSA's decode functions are fingerprinted (SHA-256 of each function body in the dump). The interpreter was
written against the fingerprints in ALGORITHM_FINGERPRINTS below; when a new release changes any of them the
build stops (exit 3) unless --accept-algorithm-change is given, because the decode logic itself moved and
lib/vpic-local.mjs must be reviewed first.

mcp.vin's rule fixes: after the NHTSA tables are written, the reviewed changeset data-src/vpic-rule-fixes.jsonl is
applied to them (edits of NHTSA's own rule rows: change a pattern's value or keys, remove a wrong row, add a narrower
row). Each entry names the exact original rows; an entry is applied only when every original row (and every row it
relies on, `premise`) is unchanged in this release, otherwise nothing of it is applied and it is reported as
needs_review. Applied edits are recorded in rule_fix (with the original row), so the interpreter can decode with
NHTSA's pristine rules too (parity tests, and the official value a fix changed). --no-rule-fixes leaves them out.

Usage:
  python3 scripts/import-vpic.py --dump /path/to/vPICList_lite_2026_11.plain.zip   (or the unzipped .sql)
         [--out data/vpic.db] [--release 2026_11] [--accept-algorithm-change] [--rule-fixes FILE | --no-rule-fixes]
  python3 scripts/import-vpic.py --reapply-rule-fixes data/vpic.db [--rule-fixes FILE]
         (undo the recorded fixes of an existing file and apply the changeset again, without the dump)
The file is built next to the target and renamed into place; a failure leaves the previous file untouched.
Exit status 4 when an entry of the changeset needs review (the file is still written, without that entry)."""
from pathlib import Path
import argparse, datetime as dt, hashlib, io, json, os, re, sqlite3, sys, time, zipfile

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / 'data/vpic.db'
RULE_FIXES = ROOT / 'data-src/vpic-rule-fixes.jsonl'
SCHEMA_VERSION = 1

# SHA-256 of each decode function's text in the vPICList_lite_2026_11 dump (print with --print-fingerprints).
# lib/vpic-local.mjs reproduces exactly these; a different fingerprint means NHTSA changed the algorithm.
ALGORITHM_FINGERPRINTS = {
    'spvindecode': 'f7ca4420f5ea644e3e6f534bf629cb716b0ebba22d34290b35b6075dcd5205dc',
    'spvindecode_core': '629f4d73bd21da053ef914dbe2f5504c1fdc13a01d56b0d5d62d26edb546801e',
    'spvindecode_errorcode': '30f2ea18ae708c85e474eb27284acf1306c3162d1cdd5c455a2f66fd5c299c53',
    'felementattributevalue': '699b5d1f487725e492f07a4d904219231bc03415a6ccfbbaea33e1366745d9e5',
    'ferrorvalue': 'ea39e61e2b43db774dd47087e8173f2cf4ed9b992ff081bbc9a28a6c4ae2bd50',
    'fextractvalidcharsperwmiyear': 'aee612a4e4d684ecb280c6b6366f2510fd158027d1103cd9e2fcd14d4a7a2c18',
    'fvalidcharsinkey': 'df5cfb7175fbe48709fe292a074ea88cebc069dae43356d8cfeeee4fcc1c2866',
    'fvalidcharsinregex': 'e3e35908288f1db5f712279c8a201830e5508b5967ab84d12dbe927eca7d9787',
    'fvincheckdigit': '4a9250e784d7af06217385058a6025bf71833fdd43103589bb9cc49106f583a3',
    'fvincheckdigit2': '24ff35ba635ad0a9acd19674caca6cc4ff67655cad2ed03b750496ee13181eed',
    'fvindescriptor': '42ccb32d54ee910782879a04e3ea0e7f70ffcc05fd563eb86db660f787d71350',
    'fvinmodelyear2': '9e3bbe28adb479029d9c07afa7ce71f92306788be8fdb8c655b6c6d16883902f',
    'fvinwmi': '1cda913f7a2ea78b673040a9bef110214433d7d3dc481361e47d284d8e818a00',
    'sqlwild_to_regex': '09194d38e9c8cf652283b1c77ff1d2d833ebe7f46cf6df9c884e3e9d464659a2',
}
FUNCTIONS = ['spvindecode', 'spvindecode_core', 'spvindecode_errorcode', 'felementattributevalue', 'ferrorvalue',
             'fextractvalidcharsperwmiyear', 'fvalidcharsinkey', 'fvalidcharsinregex', 'fvincheckdigit', 'fvincheckdigit2',
             'fvindescriptor', 'fvinmodelyear2', 'fvinwmi', 'sqlwild_to_regex']

# Tables read from the dump: name -> columns kept (dump column names).
TABLES = {
    'pattern': ['id', 'vinschemaid', 'keys', 'elementid', 'attributeid', 'createdon', 'updatedon'],
    'wmi': ['id', 'wmi', 'manufacturerid', 'makeid', 'vehicletypeid', 'createdon', 'updatedon', 'publicavailabilitydate', 'trucktypeid'],
    'wmi_vinschema': ['wmiid', 'vinschemaid', 'yearfrom', 'yearto'],
    'vinschema': ['id', 'name', 'tobeqced'],
    'element': ['id', 'name', 'code', 'lookuptable', 'isprivate', 'groupname', 'datatype', 'decode', 'weight'],
    'make_model': ['makeid', 'modelid'],
    'wmi_make': ['wmiid', 'makeid'],
    'enginemodel': ['id', 'name'],
    'enginemodelpattern': ['id', 'enginemodelid', 'elementid', 'attributeid', 'createdon', 'updatedon'],
    'conversion': ['id', 'fromelementid', 'toelementid', 'formula'],
    'vehiclespecschema': ['id', 'makeid', 'vehicletypeid', 'tobeqced'],
    'vehiclespecschema_model': ['vehiclespecschemaid', 'modelid'],
    'vehiclespecschema_year': ['id', 'vehiclespecschemaid', 'year'],
    'vspecschemapattern': ['id', 'schemaid'],
    'vehiclespecpattern': ['id', 'vspecschemapatternid', 'iskey', 'elementid', 'attributeid', 'createdon', 'updatedon'],
    'defaultvalue': ['id', 'elementid', 'vehicletypeid', 'defaultvalue', 'createdon', 'updatedon'],
    'vinexception': ['vin', 'checkdigit'],
    'vindescriptor': ['descriptor', 'modelyear'],
    'errorcode': ['id', 'name', 'additionalerrortext', 'weight'],
    'wmiyearvalidchars': ['wmi', 'year', 'position', 'char'],
}
VALID_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789'
POSITIONS = range(4, 15)  # VIN positions the error-code step checks (4-14)


def unescape_copy(field):
    """PostgreSQL COPY text format: \\N is NULL; backslash escapes."""
    if field == '\\N':
        return None
    if '\\' not in field:
        return field
    out, i, n = [], 0, len(field)
    simple = {'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t', 'v': '\v', '\\': '\\'}
    while i < n:
        c = field[i]
        if c != '\\' or i + 1 >= n:
            out.append(c); i += 1; continue
        d = field[i + 1]
        if d in simple:
            out.append(simple[d]); i += 2
        elif d in '01234567':
            j = i + 1
            while j < n and j < i + 4 and field[j] in '01234567':
                j += 1
            out.append(chr(int(field[i + 1:j], 8))); i = j
        elif d == 'x':
            j = i + 2
            while j < n and j < i + 4 and field[j] in '0123456789abcdefABCDEF':
                j += 1
            out.append(chr(int(field[i + 2:j], 16))); i = j
        else:
            out.append(d); i += 2
    return ''.join(out)


TS = re.compile(r'^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$')
EPOCH = dt.datetime(1970, 1, 1)


def ts_us(value):
    """'2015-07-10 11:37:12.123' -> integer microseconds (naive timestamps compare as written)."""
    if value is None:
        return None
    m = TS.match(value)
    if not m:
        raise ValueError(f'bad timestamp {value!r}')
    y, mo, d, h, mi, s, frac = m.groups()
    t = dt.datetime(int(y), int(mo), int(d), int(h), int(mi), int(s))
    us = int((frac or '').ljust(6, '0') or 0)
    delta = t - EPOCH
    return (delta.days * 86400 + delta.seconds) * 1_000_000 + us


def boolean(value):
    return None if value is None else (1 if value == 't' else 0 if value == 'f' else int(value))


def open_dump(path):
    path = Path(path)
    if path.suffix == '.zip':
        z = zipfile.ZipFile(path)
        names = sorted((i for i in z.infolist() if i.filename.endswith('.sql')), key=lambda i: -i.file_size)
        if not names:
            raise SystemExit('no .sql file in the zip')
        return io.TextIOWrapper(z.open(names[0]), encoding='utf-8', newline='\n'), names[0].filename
    return open(path, encoding='utf-8', newline='\n'), path.name


COPY_RE = re.compile(r'^COPY vpic\.(\w+) \((.*)\) FROM stdin;$')
FUNC_RE = re.compile(r'^CREATE FUNCTION vpic\.(\w+)\(')
STARTED_RE = re.compile(r'^-- Started on (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})')


def lookup_map(functions):
    """felementattributevalue: element id -> lookup table, as NHTSA's function maps it (not element.lookuptable)."""
    text = functions.get('felementattributevalue', '')
    pairs = re.findall(r'WHEN (\d+) THEN\s+select name from vpic\.(\w+) where cast\(Id as character varying\) = AttributeId into v;', text, re.I)
    out = {}
    for el, tbl in pairs:
        out[int(el)] = tbl.lower()
    if len(out) < 60:
        raise SystemExit(f'felementattributevalue: only {len(out)} lookups parsed; the function changed')
    return out


def valid_chars_in_regex(cls):
    """fValidCharsInRegEx: a bracket class -> the characters it allows (literal list when no range/negation)."""
    s = cls.upper()
    if '-' not in s and '^' not in s:
        return s.replace(']', '').replace('[', '')
    rx = re.compile('^' + s + '$')
    return ''.join(c for c in VALID_CHARS if rx.match(c))


def valid_chars_in_key(key):
    """fValidCharsInKey (strict): [(key position, char)]; '*' allows nothing explicit, '#' any digit."""
    out, ind, inside, start = [], 0, False, 0
    for i, s in enumerate(key, 1):
        if s == '[' and not inside:
            inside, start = True, i
            continue
        if not inside:
            ind += 1
            if s == '#':
                out.extend((ind, d) for d in '0123456789')
            elif s != '*':
                out.append((ind, s))
            continue
        if s == ']' and inside:
            ind += 1
            for c in valid_chars_in_regex(key[start - 1:i]):
                if c not in ('*', '|'):
                    out.append((ind, c))
            inside, start = False, 0
    return out


def sort_chars(chars):
    return ''.join(sorted(set(chars), key=lambda c: (0 if c == '_' else 1, c)))


def encode_positions(by_pos):
    """{vin position: set(chars)} -> 'c4,c5,...,c14' (positions 4-14; '' = no explicit characters)."""
    return ','.join(sort_chars(by_pos.get(p, ())) for p in POSITIONS)


def build(dump, out, release, accept_change, print_fingerprints, rule_fixes=RULE_FIXES):
    t0 = time.time()
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + '.tmp')
    for f in (tmp, Path(str(tmp) + '-journal')):
        if f.exists():
            f.unlink()
    db = sqlite3.connect(tmp)
    db.executescript('''
      PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA page_size=4096;
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE element(id INTEGER PRIMARY KEY, name TEXT, code TEXT, lookup_table TEXT, is_private INTEGER, group_name TEXT,
        data_type TEXT, decode TEXT, weight INTEGER, value_table TEXT);
      CREATE TABLE lookup(tbl TEXT NOT NULL, id TEXT NOT NULL, name TEXT, PRIMARY KEY(tbl, id)) WITHOUT ROWID;
      CREATE TABLE wmi(id INTEGER PRIMARY KEY, wmi TEXT NOT NULL UNIQUE, manufacturer_id INTEGER, make_id INTEGER, vehicle_type_id INTEGER,
        truck_type_id INTEGER, changed_us INTEGER, public_us INTEGER);
      CREATE TABLE wmi_vinschema(wmi_id INTEGER NOT NULL, schema_id INTEGER NOT NULL, year_from INTEGER NOT NULL, year_to INTEGER);
      CREATE TABLE vinschema(id INTEGER PRIMARY KEY, name TEXT, to_be_qced INTEGER, valid_chars TEXT);
      CREATE TABLE pattern(id INTEGER PRIMARY KEY, schema_id INTEGER NOT NULL, keys TEXT NOT NULL, element_id INTEGER NOT NULL,
        attribute_id TEXT NOT NULL, changed_us INTEGER);
      CREATE TABLE make_model(model_id INTEGER NOT NULL, make_id INTEGER NOT NULL);
      CREATE TABLE wmi_make(wmi_id INTEGER NOT NULL, make_id INTEGER NOT NULL);
      CREATE TABLE engine_model(id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE engine_model_pattern(id INTEGER PRIMARY KEY, engine_model_id INTEGER NOT NULL, element_id INTEGER NOT NULL,
        attribute_id TEXT, changed_us INTEGER);
      CREATE TABLE conversion(id INTEGER PRIMARY KEY, from_element_id INTEGER NOT NULL, to_element_id INTEGER NOT NULL, formula TEXT NOT NULL);
      CREATE TABLE spec_schema(id INTEGER PRIMARY KEY, make_id INTEGER, vehicle_type_id INTEGER, to_be_qced INTEGER);
      CREATE TABLE spec_schema_model(schema_id INTEGER NOT NULL, model_id INTEGER NOT NULL);
      CREATE TABLE spec_schema_year(id INTEGER PRIMARY KEY, schema_id INTEGER NOT NULL, year INTEGER);
      CREATE TABLE spec_schema_pattern(id INTEGER PRIMARY KEY, schema_id INTEGER NOT NULL);
      CREATE TABLE spec_pattern(id INTEGER PRIMARY KEY, spec_schema_pattern_id INTEGER NOT NULL, is_key INTEGER NOT NULL, element_id INTEGER NOT NULL,
        attribute_id TEXT, changed_us INTEGER);
      CREATE TABLE default_value(id INTEGER PRIMARY KEY, element_id INTEGER NOT NULL, vehicle_type_id INTEGER, default_value TEXT, changed_us INTEGER);
      CREATE TABLE vin_exception(vin TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE vin_descriptor(descriptor TEXT NOT NULL, model_year INTEGER);
      CREATE TABLE error_code(id INTEGER PRIMARY KEY, name TEXT, additional_text TEXT, weight INTEGER);
      CREATE TABLE wmi_year_chars(wmi TEXT NOT NULL, year INTEGER NOT NULL, chars TEXT NOT NULL, PRIMARY KEY(wmi, year)) WITHOUT ROWID;
      CREATE TABLE stage_vc(wmi TEXT, year INTEGER, position INTEGER, ch TEXT);
    ''')
    counts = {t: 0 for t in TABLES}
    elements = {}
    pending_patterns = []
    schema_chars = {}

    def sink(table, r):
        counts[table] = counts.get(table, 0) + 1
        if table == 'pattern':
            # valid characters per schema: every pattern counts (NHTSA's fallback reads all of them)
            sc = schema_chars.setdefault(int(r['vinschemaid']), {})
            for pos, ch in valid_chars_in_key(r['keys']):
                vp = pos + 3
                if 4 <= vp <= 14:
                    sc.setdefault(vp, set()).add(ch)
            pending_patterns.append((int(r['id']), int(r['vinschemaid']), r['keys'], int(r['elementid']), r['attributeid'],
                                     ts_us(r['updatedon'] or r['createdon'])))
            if len(pending_patterns) >= 50000:
                flush_patterns()
        elif table == 'wmi':
            db.execute('INSERT INTO wmi VALUES (?,?,?,?,?,?,?,?)', (int(r['id']), r['wmi'], int_or_none(r['manufacturerid']), int_or_none(r['makeid']),
                       int_or_none(r['vehicletypeid']), int_or_none(r['trucktypeid']), ts_us(r['updatedon'] or r['createdon']), ts_us(r['publicavailabilitydate'])))
        elif table == 'wmi_vinschema':
            db.execute('INSERT INTO wmi_vinschema VALUES (?,?,?,?)', (int(r['wmiid']), int(r['vinschemaid']), int(r['yearfrom']), int_or_none(r['yearto'])))
        elif table == 'vinschema':
            db.execute('INSERT INTO vinschema(id, name, to_be_qced) VALUES (?,?,?)', (int(r['id']), r['name'], boolean(r['tobeqced'])))
        elif table == 'element':
            elements[int(r['id'])] = r
        elif table == 'make_model':
            db.execute('INSERT INTO make_model VALUES (?,?)', (int(r['modelid']), int(r['makeid'])))
        elif table == 'wmi_make':
            db.execute('INSERT INTO wmi_make VALUES (?,?)', (int(r['wmiid']), int(r['makeid'])))
        elif table == 'enginemodel':
            db.execute('INSERT INTO engine_model VALUES (?,?)', (int(r['id']), r['name']))
        elif table == 'enginemodelpattern':
            db.execute('INSERT INTO engine_model_pattern VALUES (?,?,?,?,?)', (int(r['id']), int(r['enginemodelid']), int(r['elementid']), r['attributeid'],
                       ts_us(r['updatedon'] or r['createdon'])))
        elif table == 'conversion':
            db.execute('INSERT INTO conversion VALUES (?,?,?,?)', (int(r['id']), int(r['fromelementid']), int(r['toelementid']), r['formula']))
        elif table == 'vehiclespecschema':
            db.execute('INSERT INTO spec_schema VALUES (?,?,?,?)', (int(r['id']), int_or_none(r['makeid']), int_or_none(r['vehicletypeid']), boolean(r['tobeqced'])))
        elif table == 'vehiclespecschema_model':
            db.execute('INSERT INTO spec_schema_model VALUES (?,?)', (int(r['vehiclespecschemaid']), int(r['modelid'])))
        elif table == 'vehiclespecschema_year':
            db.execute('INSERT INTO spec_schema_year VALUES (?,?,?)', (int(r['id']), int(r['vehiclespecschemaid']), int_or_none(r['year'])))
        elif table == 'vspecschemapattern':
            db.execute('INSERT INTO spec_schema_pattern VALUES (?,?)', (int(r['id']), int(r['schemaid'])))
        elif table == 'vehiclespecpattern':
            db.execute('INSERT INTO spec_pattern VALUES (?,?,?,?,?,?)', (int(r['id']), int(r['vspecschemapatternid']), boolean(r['iskey']), int(r['elementid']),
                       r['attributeid'], ts_us(r['updatedon'] or r['createdon'])))
        elif table == 'defaultvalue':
            db.execute('INSERT INTO default_value VALUES (?,?,?,?,?)', (int(r['id']), int(r['elementid']), int_or_none(r['vehicletypeid']), r['defaultvalue'],
                       ts_us(r['updatedon'] or r['createdon'])))
        elif table == 'vinexception':
            if boolean(r['checkdigit']):
                db.execute('INSERT OR IGNORE INTO vin_exception VALUES (?)', (r['vin'],))
        elif table == 'vindescriptor':
            db.execute('INSERT INTO vin_descriptor VALUES (?,?)', (r['descriptor'], int_or_none(r['modelyear'])))
        elif table == 'errorcode':
            db.execute('INSERT INTO error_code VALUES (?,?,?,?)', (int(r['id']), r['name'], r['additionalerrortext'], int_or_none(r['weight'])))
        elif table == 'wmiyearvalidchars':
            db.execute('INSERT INTO stage_vc VALUES (?,?,?,?)', (r['wmi'], int(r['year']), int_or_none(r['position']), r['char']))

    def flush_patterns():
        db.executemany('INSERT INTO stage_pattern VALUES (?,?,?,?,?,?)', pending_patterns)
        pending_patterns.clear()

    db.execute('CREATE TABLE stage_pattern(id INTEGER PRIMARY KEY, schema_id INTEGER, keys TEXT, element_id INTEGER, attribute_id TEXT, changed_us INTEGER)')
    # One pass over the dump. Which tables are lookups is known only from the functions, so every small (id, name)
    # table is kept whole while streaming and the needed ones are written afterwards.
    fh, source_name = open_dump(dump)
    generic = {}
    functions, header = read_dump(fh, sink, generic)
    fh.close()
    flush_patterns()
    lmap = lookup_map(functions)

    fingerprints = {name: hashlib.sha256(functions.get(name, '').encode()).hexdigest() for name in FUNCTIONS}
    if print_fingerprints:
        print(json.dumps(fingerprints, indent=2))
    changed = [n for n in FUNCTIONS if ALGORITHM_FINGERPRINTS.get(n) and ALGORITHM_FINGERPRINTS[n] != fingerprints[n]]
    missing = [n for n in FUNCTIONS if not functions.get(n)]
    if missing:
        raise SystemExit(f'decode functions missing from the dump: {missing}')
    if changed and not accept_change:
        print(f'NHTSA changed decode functions {changed}: review lib/vpic-local.mjs against the new source, then rerun with '
              f'--accept-algorithm-change and update ALGORITHM_FINGERPRINTS.', file=sys.stderr)
        db.close(); tmp.unlink()
        sys.exit(3)

    # Elements (+ the lookup table NHTSA's value function uses for each)
    for eid, r in elements.items():
        db.execute('INSERT INTO element VALUES (?,?,?,?,?,?,?,?,?,?)', (eid, r['name'], r['code'], r['lookuptable'], boolean(r['isprivate']), r['groupname'],
                   r['datatype'], r['decode'], int_or_none(r['weight']), lmap.get(eid)))
    needed_tables = sorted(set(lmap.values()))
    missing_tables = []
    for tbl in needed_tables:
        rows = generic.get(tbl)
        if rows is None:
            missing_tables.append(tbl)
            continue
        db.executemany('INSERT OR IGNORE INTO lookup VALUES (?,?,?)', [(tbl, r['id'], r['name']) for r in rows])
    # Views (vncsa*) map private NCSA elements only; nothing public reads them.
    missing_tables = [t for t in missing_tables if not t.startswith('vncsa')]
    if missing_tables:
        raise SystemExit(f'lookup tables missing from the dump: {missing_tables}')

    # Patterns the decode can read. Kept: every '#' formula pattern (that step has no element filter), and others
    # whose element the pattern step accepts (not 26/27/29/39, has a decode role, not private).
    readable = {eid for eid, r in elements.items() if eid not in (26, 27, 29, 39) and r['decode'] is not None and boolean(r['isprivate']) != 1}
    db.execute('INSERT INTO pattern SELECT * FROM stage_pattern WHERE instr(keys, \'#\') > 0 OR element_id IN (%s)' % ','.join(map(str, sorted(readable))))
    kept = db.execute('SELECT count(*) FROM pattern').fetchone()[0]
    db.execute('DROP TABLE stage_pattern')
    db.executemany('UPDATE vinschema SET valid_chars = ? WHERE id = ?', [(encode_positions(sc), sid) for sid, sc in schema_chars.items()])

    # wmi-year valid characters (NHTSA's cache table), one string per WMI and year
    cur = db.execute('SELECT DISTINCT wmi, year, position, ch FROM stage_vc ORDER BY wmi, year')
    batch, key, acc = [], None, {}
    for wmi, year, pos, ch in cur:
        if (wmi, year) != key:
            if key is not None:
                batch.append((key[0], key[1], encode_positions(acc)))
            key, acc = (wmi, year), {}
        if pos is not None and ch is not None and 4 <= pos <= 14:
            acc.setdefault(pos, set()).add(ch)
    if key is not None:
        batch.append((key[0], key[1], encode_positions(acc)))
    db.execute('DROP TABLE stage_vc')
    db.executemany('INSERT INTO wmi_year_chars VALUES (?,?,?)', batch)

    db.executescript('''
      CREATE INDEX ix_pattern_schema ON pattern(schema_id);
      CREATE INDEX ix_wvs_wmi ON wmi_vinschema(wmi_id);
      CREATE INDEX ix_make_model ON make_model(model_id);
      CREATE INDEX ix_wmi_make ON wmi_make(wmi_id);
      CREATE INDEX ix_emp ON engine_model_pattern(engine_model_id);
      CREATE INDEX ix_em_name ON engine_model(name);
      CREATE INDEX ix_ssm ON spec_schema_model(model_id);
      CREATE INDEX ix_ssy ON spec_schema_year(schema_id);
      CREATE INDEX ix_ssp ON spec_schema_pattern(schema_id);
      CREATE INDEX ix_sp ON spec_pattern(spec_schema_pattern_id);
      CREATE INDEX ix_dv ON default_value(vehicle_type_id);
      CREATE INDEX ix_vd ON vin_descriptor(descriptor);
    ''')
    built = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
    m = re.search(r'(\d{4})_(\d{2})', source_name)
    rel = release or (f'{m.group(1)}_{m.group(2)}' if m else None)
    if not rel:
        raise SystemExit('cannot tell the release from the file name; pass --release YYYY_MM')
    meta = {
        'schema_version': str(SCHEMA_VERSION), 'release': rel, 'release_name': f'vPICList_lite_{rel}',
        'source_file': source_name, 'nhtsa_dump_started': header.get('started') or '', 'built_at': built,
        'source_url': 'https://vpic.nhtsa.dot.gov/api/ (Standalone vPIC database, PostgreSQL edition)',
        'algorithm_fingerprints': json.dumps(fingerprints, sort_keys=True), 'algorithm_changed': json.dumps(changed),
        'counts': json.dumps({**counts, 'pattern_kept': kept, 'wmi_year_chars': len(batch)}, sort_keys=True),
    }
    db.executemany('INSERT INTO meta VALUES (?,?)', sorted(meta.items()))
    fixes = apply_rule_fixes(db, rule_fixes, rel)
    db.commit()
    db.execute('VACUUM')
    db.close()
    os.replace(tmp, out)
    size = out.stat().st_size
    print(json.dumps({'out': str(out), 'bytes': size, 'mb': round(size / 1e6, 1), 'release': rel, 'seconds': round(time.time() - t0),
                      'patterns': counts['pattern'], 'patterns_kept': kept, 'wmi_year_chars': len(batch), 'algorithm_changed': changed,
                      'rule_fixes': fixes['summary']}))
    report_fixes(fixes)
    return fixes


# ---------------------------------------------------------------- mcp.vin rule fixes

FIX_TABLES = '''
  CREATE TABLE IF NOT EXISTS rule_fix_entry(fix_id TEXT PRIMARY KEY, written_against TEXT, fix_case TEXT, status TEXT NOT NULL, problem TEXT,
    reason TEXT, evidence TEXT, errors TEXT, reviewed TEXT, edits TEXT, premise TEXT);
  CREATE TABLE IF NOT EXISTS rule_fix(fix_id TEXT NOT NULL, edit_no INTEGER NOT NULL, action TEXT NOT NULL, tbl TEXT NOT NULL, row_id INTEGER NOT NULL,
    schema_id INTEGER, spec_schema_pattern_id INTEGER, element_id INTEGER NOT NULL, is_key INTEGER,
    orig_keys TEXT, orig_attribute_id TEXT, orig_changed_us INTEGER, new_keys TEXT, new_attribute_id TEXT, new_changed_us INTEGER,
    PRIMARY KEY(fix_id, edit_no));
'''


def lookup_name(db, element_id, attribute_id):
    vt = db.execute('SELECT value_table FROM element WHERE id = ?', (element_id,)).fetchone()
    if not vt or not vt[0]:
        return attribute_id
    r = db.execute('SELECT name FROM lookup WHERE tbl = ? AND id = ?', (vt[0], str(attribute_id))).fetchone()
    return r[0] if r else None


def check_row(db, table, want, el_id):
    """Is the original row still exactly there? None when it is, else what differs."""
    if table == 'pattern':
        r = db.execute('SELECT schema_id, keys, element_id, attribute_id, changed_us FROM pattern WHERE id = ?', (want['id'],)).fetchone()
        if not r:
            return f"pattern row {want['id']} is gone"
        got = {'schema_id': r[0], 'keys': r[1], 'element_id': r[2], 'attribute_id': r[3]}
        exp = {'schema_id': want['schema_id'], 'keys': want['keys'], 'element_id': el_id, 'attribute_id': str(want['attribute_id'])}
    elif table == 'spec_pattern':
        r = db.execute('SELECT spec_schema_pattern_id, is_key, element_id, attribute_id, changed_us FROM spec_pattern WHERE id = ?', (want['id'],)).fetchone()
        if not r:
            return f"spec_pattern row {want['id']} is gone"
        got = {'spec_schema_pattern_id': r[0], 'is_key': r[1], 'element_id': r[2], 'attribute_id': r[3]}
        exp = {'spec_schema_pattern_id': want['spec_schema_pattern_id'], 'is_key': 0, 'element_id': el_id, 'attribute_id': str(want['attribute_id'])}
    else:
        return f'unsupported table {table}'
    diff = {k: [exp[k], got[k]] for k in exp if exp[k] != got[k]}
    return f"{table} row {want['id']} changed: " + json.dumps(diff) if diff else None


def apply_rule_fixes(db, path, release):
    """Apply the reviewed changeset to NHTSA's tables in `db`; record each applied edit with its original row."""
    db.executescript(FIX_TABLES)
    out = {'entries': [], 'summary': {'file': str(path) if path else None, 'entries': 0, 'applied': 0, 'needs_review': 0, 'edits_applied': 0}}
    if not path:
        db.execute("INSERT OR REPLACE INTO meta VALUES ('rule_fixes', ?)", (json.dumps(out['summary']),))
        return out
    path = Path(path)
    if not path.exists():
        raise SystemExit(f'rule-fix changeset {path} not found (use --no-rule-fixes to build without it)')
    codes = {c: i for c, i in db.execute('SELECT code, id FROM element')}
    seen = set()
    for n, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            e = json.loads(line)
        except ValueError:
            raise SystemExit(f'{path}:{n}: not JSON')
        fid = e.get('id')
        if not isinstance(fid, str) or not re.fullmatch(r'rf-\d{3,}', fid) or fid in seen:
            raise SystemExit(f'{path}:{n}: bad or duplicate id {fid!r}')
        seen.add(fid)
        for k in ('release', 'case', 'errors', 'edits', 'reason', 'evidence', 'reviewed'):
            if not e.get(k):
                raise SystemExit(f'{path}:{n} ({fid}): missing {k}')
        problems, plan = [], []
        for p in e.get('premise', []):
            el = codes.get(p['row'].get('element'))
            problems.append(check_row(db, p['table'], p['row'], el) if el else f"premise element {p['row'].get('element')} unknown")
        for i, ed in enumerate(e['edits'], 1):
            act, tbl = ed.get('action'), ed.get('table')
            src = ed.get('row') if act in ('modify', 'delete') else ed.get('new')
            el = codes.get((src or {}).get('element'))
            if not src or el is None or act not in ('modify', 'delete', 'add') or tbl not in ('pattern', 'spec_pattern') or (act == 'add' and tbl != 'pattern'):
                raise SystemExit(f'{path}:{n} ({fid}) edit {i}: unsupported edit')
            if act in ('modify', 'delete'):
                problems.append(check_row(db, tbl, src, el))
                cur = db.execute(f'SELECT * FROM {tbl} WHERE id = ?', (src['id'],)).fetchone()
                if act == 'modify':
                    new_attr = str(ed['set'].get('attribute_id', src['attribute_id']))
                    new_keys = ed['set'].get('keys', src.get('keys'))
                    name = lookup_name(db, el, new_attr)
                    if name is None or ('value' in ed['set'] and name.lower() != str(ed['set']['value']).lower()):
                        problems.append(f"edit {i}: attribute {new_attr} of {src['element']} is {name!r} in this release, not {ed['set'].get('value')!r}")
                    plan.append((i, act, tbl, src, el, cur, new_keys, new_attr))
                else:
                    plan.append((i, act, tbl, src, el, cur, None, None))
            else:
                if db.execute('SELECT 1 FROM pattern WHERE id = ?', (src['id'],)).fetchone() or src['id'] >= 0:
                    problems.append(f"edit {i}: new row id {src['id']} must be negative and unused")
                if not db.execute('SELECT 1 FROM vinschema WHERE id = ?', (src['schema_id'],)).fetchone():
                    problems.append(f"edit {i}: schema {src['schema_id']} is gone")
                other = db.execute('SELECT id, attribute_id FROM pattern WHERE schema_id = ? AND keys = ? AND element_id = ?', (src['schema_id'], src['keys'], el)).fetchone()
                if other:
                    problems.append(f"edit {i}: NHTSA now has its own row {other[0]} for {src['keys']} {src['element']} (value {other[1]})")
                name = lookup_name(db, el, src['attribute_id'])
                if name is None or name.lower() != str(src.get('value', name)).lower():
                    problems.append(f"edit {i}: attribute {src['attribute_id']} of {src['element']} is {name!r} in this release, not {src.get('value')!r}")
                plan.append((i, act, tbl, src, el, None, src['keys'], str(src['attribute_id'])))
        problems = [p for p in problems if p]
        status = 'needs_review' if problems else 'applied'
        db.execute('INSERT INTO rule_fix_entry VALUES (?,?,?,?,?,?,?,?,?,?,?)', (fid, e['release'], e['case'], status, '; '.join(problems) or None, e['reason'],
                   json.dumps(e['evidence']), json.dumps(e['errors']), json.dumps(e['reviewed']), json.dumps(e['edits']), json.dumps(e.get('premise', []))))
        out['entries'].append({'id': fid, 'status': status, 'problems': problems, 'written_against': e['release'], 'errors': e['errors']})
        out['summary']['entries'] += 1
        out['summary'][status] += 1
        if problems:
            continue
        reviewed_us = int(dt.datetime.fromisoformat(e['reviewed']['on']).replace(tzinfo=dt.timezone.utc).timestamp() * 1e6)
        for i, act, tbl, src, el, cur, new_keys, new_attr in plan:
            if tbl == 'pattern':
                if act == 'modify':
                    db.execute('UPDATE pattern SET keys = ?, attribute_id = ? WHERE id = ?', (new_keys, new_attr, src['id']))
                    rec = (cur[1], None, cur[2], cur[4], cur[5], new_keys, new_attr, cur[5])
                elif act == 'delete':
                    db.execute('DELETE FROM pattern WHERE id = ?', (src['id'],))
                    rec = (cur[1], None, cur[2], cur[4], cur[5], None, None, None)
                else:
                    db.execute('INSERT INTO pattern VALUES (?,?,?,?,?,?)', (src['id'], src['schema_id'], new_keys, el, new_attr, reviewed_us))
                    rec = (src['schema_id'], None, None, None, None, new_keys, new_attr, reviewed_us)
                schema_id, spp, ok, oa, oc, nk, na, nc = rec
                is_key = None
            else:
                if act == 'modify':
                    db.execute('UPDATE spec_pattern SET attribute_id = ? WHERE id = ?', (new_attr, src['id']))
                    schema_id, spp, ok, oa, oc, nk, na, nc = None, cur[1], None, cur[4], cur[5], None, new_attr, cur[5]
                else:
                    db.execute('DELETE FROM spec_pattern WHERE id = ?', (src['id'],))
                    schema_id, spp, ok, oa, oc, nk, na, nc = None, cur[1], None, cur[4], cur[5], None, None, None
                is_key = cur[2]
            db.execute('INSERT INTO rule_fix VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (fid, i, act, tbl, src['id'], schema_id, spp, el, is_key, ok, oa, oc, nk, na, nc))
            out['summary']['edits_applied'] += 1
    db.execute("INSERT OR REPLACE INTO meta VALUES ('rule_fixes', ?)", (json.dumps(out['summary']),))
    return out


def revert_rule_fixes(db):
    """Undo every recorded edit (back to NHTSA's rows), then forget the fixes."""
    db.executescript(FIX_TABLES)
    for fid, n, act, tbl, rid, schema_id, spp, el, is_key, ok, oa, oc, nk, na, nc in db.execute('SELECT * FROM rule_fix ORDER BY fix_id DESC, edit_no DESC').fetchall():
        if tbl == 'pattern':
            if act == 'modify':
                db.execute('UPDATE pattern SET keys = ?, attribute_id = ? WHERE id = ?', (ok, oa, rid))
            elif act == 'delete':
                db.execute('INSERT INTO pattern VALUES (?,?,?,?,?,?)', (rid, schema_id, ok, el, oa, oc))
            else:
                db.execute('DELETE FROM pattern WHERE id = ?', (rid,))
        else:
            if act == 'modify':
                db.execute('UPDATE spec_pattern SET attribute_id = ? WHERE id = ?', (oa, rid))
            else:
                db.execute('INSERT INTO spec_pattern VALUES (?,?,?,?,?,?)', (rid, spp, is_key, el, oa, oc))
    db.execute('DROP TABLE rule_fix')
    db.execute('DROP TABLE rule_fix_entry')


def report_fixes(fixes):
    for e in fixes['entries']:
        if e['status'] != 'applied':
            print(f"RULE FIX NEEDS REVIEW {e['id']} (written against {e['written_against']}; "
                  f"{', '.join(x['pattern'] + ' ' + x['field'] for x in e['errors'])}): {'; '.join(e['problems'])}", file=sys.stderr)


def reapply(path_db, rule_fixes):
    """Re-apply the changeset to an existing file (copy, revert, apply, rename into place)."""
    import shutil
    src = Path(path_db)
    tmp = src.with_name(src.name + '.tmp')
    shutil.copyfile(src, tmp)
    try:
        db = sqlite3.connect(tmp)
        rel = db.execute("SELECT value FROM meta WHERE key = 'release'").fetchone()[0]
        revert_rule_fixes(db)
        fixes = apply_rule_fixes(db, rule_fixes, rel)
        db.commit()
        db.execute('VACUUM')
        db.close()
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    os.replace(tmp, src)
    print(json.dumps({'out': str(src), 'release': rel, 'rule_fixes': fixes['summary']}))
    report_fixes(fixes)
    return fixes


SMALL_TABLE_LIMIT = 100000


def read_dump(fh, sink, generic):
    """Stream the dump: COPY rows of wanted tables go to sink(table, row); every other small (id, name) table is kept
    whole in `generic` (lookup lists); returns the decode functions' text and the dump header."""
    functions, header = {}, {}
    func_name, func_lines = None, []
    copy_table, copy_cols, keep_idx, gen = None, None, None, None
    for raw in fh:
        line = raw.rstrip('\n')
        if copy_table is not None:
            if line == '\\.':
                copy_table = None
                continue
            parts = line.split('\t')
            if len(parts) != len(copy_cols):
                raise SystemExit(f'{copy_table}: {len(parts)} fields, expected {len(copy_cols)}')
            if keep_idx is not None:
                sink(copy_table, {c: unescape_copy(parts[i]) for c, i in keep_idx})
            if gen is not None and len(gen) < SMALL_TABLE_LIMIT:
                gen.append({'id': unescape_copy(parts[copy_cols.index('id')]), 'name': unescape_copy(parts[copy_cols.index('name')])})
            continue
        if func_name is not None:
            func_lines.append(line)
            if re.fullmatch(r'\$\w*\$;', line):
                functions[func_name] = '\n'.join(func_lines)
                func_name = None
            continue
        m = COPY_RE.match(line)
        if m:
            copy_table = m.group(1)
            copy_cols = [c.strip().strip('"') for c in m.group(2).split(',')]
            want = TABLES.get(copy_table)
            keep_idx = None
            if want:
                missing = [c for c in want if c not in copy_cols]
                if missing:
                    raise SystemExit(f'{copy_table}: dump lacks columns {missing}')
                keep_idx = [(c, copy_cols.index(c)) for c in want]
            gen = None
            if 'id' in copy_cols and 'name' in copy_cols and copy_table not in ('pattern', 'wmiyearvalidchars', 'vinschema'):
                gen = generic.setdefault(copy_table, [])
            continue
        m = FUNC_RE.match(line)
        if m:
            func_name, func_lines = m.group(1), [line]
            continue
        m = STARTED_RE.match(line)
        if m and 'started' not in header:
            header['started'] = m.group(1)
    return functions, header


def int_or_none(v):
    return None if v is None or v == '' else int(v)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--dump', help='vPICList_lite_YYYY_MM.plain.zip or the .sql inside it')
    ap.add_argument('--out', default=str(TARGET))
    ap.add_argument('--release', default=None, help='YYYY_MM (default: from the file name)')
    ap.add_argument('--accept-algorithm-change', action='store_true')
    ap.add_argument('--print-fingerprints', action='store_true')
    ap.add_argument('--rule-fixes', default=str(RULE_FIXES), help='reviewed changeset to apply (default data-src/vpic-rule-fixes.jsonl)')
    ap.add_argument('--no-rule-fixes', action='store_true', help="NHTSA's tables only")
    ap.add_argument('--reapply-rule-fixes', metavar='DB', help='re-apply the changeset to an existing vpic.db (no dump needed)')
    a = ap.parse_args()
    fixes_path = None if a.no_rule_fixes else a.rule_fixes
    if a.reapply_rule_fixes:
        fixes = reapply(a.reapply_rule_fixes, fixes_path)
    elif a.dump:
        fixes = build(a.dump, a.out, a.release, a.accept_algorithm_change, a.print_fingerprints, fixes_path)
    else:
        ap.error('--dump or --reapply-rule-fixes is required')
    sys.exit(4 if fixes['summary']['needs_review'] else 0)


if __name__ == '__main__':
    main()

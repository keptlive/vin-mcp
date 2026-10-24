#!/usr/bin/env python3
"""Index the official NHTSA investigation archive without dropping source variants."""
from pathlib import Path
from urllib.request import urlopen
import csv, datetime, hashlib, io, json, os, sqlite3, sys, zipfile

ROOT = Path(__file__).resolve().parent.parent
URL = 'https://static.nhtsa.gov/odi/ffdd/inv/FLAT_INV.zip'

def build(archive, target, url=URL):
    payload = archive.read_bytes()
    temp = target.with_name('investigations-build-' + str(os.getpid()) + '.db')
    db = sqlite3.connect(temp)
    try:
        db.executescript('''CREATE TABLE reports(hash TEXT PRIMARY KEY,id TEXT,manufacturer TEXT,opened TEXT,closed TEXT,subject TEXT,summary TEXT);
        CREATE TABLE applicability(hash TEXT,make TEXT,model TEXT,year INTEGER,component TEXT,campaign TEXT,UNIQUE(hash,make,model,year,component,campaign));
        CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);''')
        count = 0
        with zipfile.ZipFile(io.BytesIO(payload)) as z:
            files = z.infolist()
            if len(files)!=1 or files[0].filename!='FLAT_INV.txt' or files[0].file_size>600_000_000:
                raise ValueError('Unexpected investigation archive layout')
            with z.open(files[0]) as raw:
                for row in csv.reader(io.TextIOWrapper(raw,encoding='utf-8-sig'),delimiter='\t',quoting=csv.QUOTE_NONE):
                    if not row: continue
                    if len(row)!=11 or not row[0] or (row[3] and not row[3].isdigit()):
                        raise ValueError('Unexpected investigation schema')
                    # Different summaries/manufacturers under the same action number stay distinct.
                    report = [row[i].strip() for i in [0,5,6,7,9,10]]
                    digest = hashlib.sha256(json.dumps(report).encode()).hexdigest()
                    db.execute('INSERT OR IGNORE INTO reports VALUES(?,?,?,?,?,?,?)',[digest]+report)
                    db.execute('INSERT OR IGNORE INTO applicability VALUES(?,?,?,?,?,?)',(digest,row[1].strip(),row[2].strip(),int(row[3]) if row[3] else None,row[4].strip(),row[8].strip()))
                    count += 1
        if count == 0: raise ValueError('Empty investigation archive')
        db.executescript('CREATE INDEX vehicle ON applicability(make COLLATE NOCASE,model COLLATE NOCASE,year); CREATE INDEX action ON reports(id);')
        metadata = {'url':url,'sha256':hashlib.sha256(payload).hexdigest(),'source_rows':count,'downloaded_at':datetime.datetime.fromtimestamp(archive.stat().st_mtime,datetime.timezone.utc).isoformat(),'indexed_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
        db.execute('INSERT INTO metadata VALUES(?,?)',('source',json.dumps(metadata)))
        db.commit()
        if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok': raise ValueError('Integrity failure')
        metadata['distinct_actions']=db.execute('SELECT count(DISTINCT id) FROM reports').fetchone()[0]
        db.close()
        os.replace(temp,target)
        return metadata
    except BaseException:
        db.close()
        temp.unlink(missing_ok=True)
        raise

def main():
    cache=ROOT/'operations/free-data'; cache.mkdir(parents=True,exist_ok=True)
    target=ROOT/'data/investigations.db'; target.parent.mkdir(exist_ok=True)
    archive=cache/'FLAT_INV.zip'
    if not archive.exists() or '--refresh' in sys.argv:
        with urlopen(URL,timeout=60) as r: payload=r.read(30_000_001)
        if len(payload)>30_000_000: raise ValueError('Download size limit')
        staged=archive.with_suffix('.download')
        staged.write_bytes(payload)
        with zipfile.ZipFile(staged) as z:
            if z.testzip() is not None: raise ValueError('Invalid archive')
        os.replace(staged,archive)
    print(json.dumps(build(archive,target),indent=2))

if __name__=='__main__': main()

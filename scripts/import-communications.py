#!/usr/bin/env python3
"""Build a separate, atomically replaced public-data index; never touches accounts.
Run: python3 scripts/import-communications.py [--refresh]
"""
from pathlib import Path
from urllib.request import urlopen
import csv, datetime, hashlib, io, json, os, sqlite3, sys, zipfile
ROOT=Path(__file__).resolve().parent.parent
PERIODS=['1995-1999','2000-2004','2005-2009','2010-2014','2015-2019','2020-2024','2025-2026']
def main():
    cache=ROOT/'operations/free-data';cache.mkdir(parents=True,exist_ok=True)
    target=ROOT/'data/communications.db';target.parent.mkdir(exist_ok=True)
    temp=target.with_name('communications-build-'+str(os.getpid())+'.db')
    db=sqlite3.connect(temp)
    db.executescript('CREATE TABLE communications(id TEXT,bulletin TEXT,received TEXT,issued TEXT,kind TEXT,make TEXT,model TEXT,year INTEGER,component TEXT,summary TEXT,archive TEXT,UNIQUE(id,make,model,year,component)); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);')
    receipts=[]
    try:
        for period in PERIODS:
            name='TSBS_RECEIVED_'+period+'.zip';url='https://static.nhtsa.gov/odi/ffdd/tsbs/'+name
            archive=cache/name
            if not archive.exists() or '--refresh' in sys.argv:
                with urlopen(url,timeout=60) as response: payload=response.read(100_000_001)
                if len(payload)>100_000_000: raise ValueError('Archive size limit')
                archive.write_bytes(payload)
            payload=archive.read_bytes();count=0
            with zipfile.ZipFile(io.BytesIO(payload)) as z:
                members=[m for m in z.infolist() if m.filename.lower().endswith('.txt')]
                if len(members)!=1 or members[0].file_size>2_000_000_000: raise ValueError('Unexpected archive layout')
                with z.open(members[0]) as raw:
                    for row in csv.reader(io.TextIOWrapper(raw,encoding='utf-8-sig'),delimiter='\t',quoting=csv.QUOTE_NONE):
                        if not row: continue
                        if len(row)!=14 or not row[0].isdigit() or not row[9].isdigit(): raise ValueError('Unexpected communication schema')
                        db.execute('INSERT OR IGNORE INTO communications VALUES(?,?,?,?,?,?,?,?,?,?,?)',(row[0],row[3],row[2],row[4],row[6],row[7],row[8],int(row[9]),row[10],row[13],url));count+=1
            receipts.append({'url':url,'sha256':hashlib.sha256(payload).hexdigest(),'source_rows':count,'downloaded_at':datetime.datetime.fromtimestamp(archive.stat().st_mtime,datetime.timezone.utc).isoformat()})
            db.commit();print(period,count,flush=True)
        if not receipts or any(r['source_rows']==0 for r in receipts):raise ValueError('Empty source archive')
        db.execute('CREATE INDEX vehicle ON communications(make COLLATE NOCASE,model COLLATE NOCASE,year,received DESC)')
        db.execute('INSERT INTO metadata VALUES(?,?)',('sources',json.dumps(receipts)))
        db.execute('INSERT INTO metadata VALUES(?,?)',('indexed_at',datetime.datetime.now(datetime.timezone.utc).isoformat()))
        db.commit()
        if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise ValueError('Integrity check failed')
        print('Indexed rows:',db.execute('SELECT count(*) FROM communications').fetchone()[0]);db.close();os.replace(temp,target)
    except BaseException:
        db.close();temp.unlink(missing_ok=True);raise
if __name__=='__main__':main()

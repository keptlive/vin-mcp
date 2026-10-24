#!/usr/bin/env python3
"""Losslessly normalize the public bulletin index behind its existing SQL view."""
from pathlib import Path
import argparse, hashlib, json, os, sqlite3

COLUMNS='id,bulletin,received,issued,kind,make,model,year,component,summary,archive'

def compact(source, target):
    source=Path(source).resolve(); target=Path(target).resolve()
    if source==target or target.exists(): raise ValueError('Choose a new target; source and existing files are never overwritten')
    temp=target.with_name(target.stem+'-build-'+str(os.getpid())+'.db')
    if temp.exists(): raise ValueError('Build file already exists')
    src=sqlite3.connect(source.as_uri()+'?mode=ro',uri=True)
    dst=sqlite3.connect(temp)
    try:
        dst.executescript('''PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-65536;
        CREATE TABLE records(record INTEGER PRIMARY KEY,id TEXT,bulletin TEXT,received TEXT,issued TEXT,kind TEXT,summary TEXT,archive TEXT);
        CREATE TABLE associations(seq INTEGER PRIMARY KEY,record INTEGER,make TEXT,model TEXT,year INTEGER,component TEXT);
        CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
        CREATE VIEW communications AS SELECT r.id,r.bulletin,r.received,r.issued,r.kind,a.make,a.model,a.year,a.component,r.summary,r.archive FROM associations a JOIN records r ON r.record=a.record;''')
        known={}; batch=[]; digest=hashlib.sha256(); count=0
        dst.execute('BEGIN')
        for count,row in enumerate(src.execute('SELECT '+COLUMNS+' FROM communications ORDER BY rowid'),1):
            digest.update((json.dumps(row,ensure_ascii=True,separators=(',',':'))+'\n').encode())
            report=tuple(row[i] for i in [0,1,2,3,4,9,10])
            key=hashlib.sha256(json.dumps(report,ensure_ascii=True,separators=(',',':')).encode()).digest()
            record=known.get(key)
            if record is None:
                record=len(known)+1;known[key]=record
                dst.execute('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)',(record,)+report)
            batch.append((count,record,row[5],row[6],row[7],row[8]))
            if len(batch)>=5000: dst.executemany('INSERT INTO associations VALUES(?,?,?,?,?,?)',batch);batch=[]
        dst.executemany('INSERT INTO associations VALUES(?,?,?,?,?,?)',batch)
        if count==0: raise ValueError('Empty source index')
        dst.executemany('INSERT INTO metadata VALUES(?,?)',src.execute('SELECT key,value FROM metadata'))
        dst.execute('CREATE INDEX vehicle ON associations(make COLLATE NOCASE,model COLLATE NOCASE,year)')
        check=hashlib.sha256()
        for row in dst.execute('SELECT r.id,r.bulletin,r.received,r.issued,r.kind,a.make,a.model,a.year,a.component,r.summary,r.archive FROM associations a JOIN records r ON r.record=a.record ORDER BY a.seq'):
            check.update((json.dumps(row,ensure_ascii=True,separators=(',',':'))+'\n').encode())
        if check.digest()!=digest.digest(): raise ValueError('Logical row verification failed')
        if dst.execute('PRAGMA integrity_check').fetchone()[0]!='ok': raise ValueError('Integrity check failed')
        receipt={'format':'normalized-view-v1','rows':count,'reports':len(known),'logical_sha256':digest.hexdigest(),'source_bytes':source.stat().st_size}
        dst.execute('INSERT INTO metadata VALUES(?,?)',('storage',json.dumps(receipt)))
        dst.commit();dst.close();src.close()
        if target.exists(): raise ValueError('Target appeared during build')
        os.replace(temp,target)
        receipt['compact_bytes']=target.stat().st_size
        return receipt
    except BaseException:
        src.close();dst.close();temp.unlink(missing_ok=True);raise

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path);parser.add_argument('target',type=Path)
    args=parser.parse_args();print(json.dumps(compact(args.source,args.target),indent=2))

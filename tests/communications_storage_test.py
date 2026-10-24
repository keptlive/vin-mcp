import importlib.util, pathlib, sqlite3, tempfile, unittest, hashlib

spec=importlib.util.spec_from_file_location('compact',pathlib.Path(__file__).resolve().parents[1]/'scripts/compact-communications.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class CompactStorageTest(unittest.TestCase):
    def test_lossless_variants_metadata_and_source_preservation(self):
        with tempfile.TemporaryDirectory() as directory:
            source=pathlib.Path(directory)/'original.db';target=pathlib.Path(directory)/'compact.db'
            rows=[('123','Bulletin','20261020','20261019','TSB','HONDA','ACCORD',2003,str(i),'Full summary '*100,'https://example.invalid/archive') for i in range(1000)]
            rows.append(tuple(list(rows[0][:9])+['A differing summary',rows[0][10]]))
            with sqlite3.connect(source) as db:
                db.execute('CREATE TABLE communications(id,bulletin,received,issued,kind,make,model,year,component,summary,archive)')
                db.executemany('INSERT INTO communications VALUES(?,?,?,?,?,?,?,?,?,?,?)',rows)
                db.execute('CREATE TABLE metadata(key PRIMARY KEY,value)');db.execute("INSERT INTO metadata VALUES('sources','[]')")
            original=hashlib.sha256(source.read_bytes()).hexdigest()
            receipt=module.compact(source,target)
            self.assertEqual(receipt['rows'],len(rows));self.assertEqual(receipt['reports'],2)
            self.assertLess(target.stat().st_size,source.stat().st_size)
            with sqlite3.connect(target) as db:
                self.assertCountEqual(db.execute('SELECT * FROM communications').fetchall(),rows)
                self.assertEqual(db.execute("SELECT value FROM metadata WHERE key='sources'").fetchone()[0],'[]')
                self.assertEqual(db.execute('SELECT count(DISTINCT id) FROM communications WHERE make=? COLLATE NOCASE AND model=? COLLATE NOCASE AND year=?',('honda','accord',2003)).fetchone()[0],1)
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),original)
            before=target.read_bytes()
            with self.assertRaises(ValueError): module.compact(source,target)
            self.assertEqual(target.read_bytes(),before)

if __name__=='__main__': unittest.main()

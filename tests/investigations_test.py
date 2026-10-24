import importlib.util, pathlib, sqlite3, tempfile, unittest, zipfile

spec = importlib.util.spec_from_file_location('importer', pathlib.Path(__file__).resolve().parents[1]/'scripts/import-investigations.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)

class InvestigationImportTest(unittest.TestCase):
    def test_variants_unknown_years_and_atomic_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory); archive=root/'source.zip'; target=root/'investigations.db'
            base=['EA00001','HONDA','ACCORD','2003','BRAKES','HONDA','20030101','','03V001000','Brake issue','First summary']
            variant=base.copy(); variant[-1]='Revised summary'
            unknown=base.copy(); unknown[3]=''
            with zipfile.ZipFile(archive,'w') as z:
                z.writestr('FLAT_INV.txt','\n'.join('\t'.join(r) for r in [base,base,variant,unknown]))
            receipt=importer.build(archive,target)
            self.assertEqual(receipt['distinct_actions'],1)
            with sqlite3.connect(target) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM reports').fetchone()[0],2)
                self.assertEqual(db.execute('SELECT count(*) FROM applicability WHERE year IS NULL').fetchone()[0],1)
                self.assertEqual(db.execute('SELECT count(*) FROM applicability WHERE year=2003').fetchone()[0],2)
            before=target.read_bytes()
            with zipfile.ZipFile(archive,'w') as z: z.writestr('FLAT_INV.txt','broken\trow')
            with self.assertRaises(ValueError): importer.build(archive,target)
            self.assertEqual(target.read_bytes(),before)
            self.assertEqual(list(root.glob('investigations-build-*')),[])

if __name__=='__main__': unittest.main()

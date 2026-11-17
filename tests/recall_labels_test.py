import importlib.util, json, pathlib, sqlite3, tempfile, unittest, zipfile

spec = importlib.util.spec_from_file_location('importer', pathlib.Path(__file__).resolve().parents[1]/'scripts/import-recall-labels.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)

def row(record, campaign, make, model, year, rcdate='20240401'):
    r = [''] * 29
    r[0], r[1], r[2], r[3], r[4], r[15] = record, campaign, make, model, year, rcdate
    return '\t'.join(r)

class RecallLabelImportTest(unittest.TestCase):
    def test_labels_per_make_year_unknown_years_fragments_and_atomic_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); target = root/'recall-labels.db'
            post, pre = root/'FLAT_RCL_POST_2010.zip', root/'FLAT_RCL_PRE_2010.zip'
            with zipfile.ZipFile(post, 'w') as z:
                z.writestr('FLAT_RCL_POST_2010.txt', '\n'.join([
                    row('1', '24V744000', 'HONDA', 'CR-V', '2024'), row('2', '24V744000', 'HONDA', 'CR-V HYBRID', '2024'),
                    row('3', '24V763000', 'HONDA', 'CR-V HYBRID', '2024', '20241015'), row('4', '24V763000', 'HONDA', 'CR-V HYBRID', '2024'),
                    row('5', '19V001000', 'FORD', 'F-150', '9999'), 'continued free text after a line break', '']))
            with zipfile.ZipFile(pre, 'w') as z:
                z.writestr('FLAT_RCL_PRE_2010.txt', row('6', '08V001000', 'TOYOTA', 'PRIUS', '2008', '20080101'))
            receipt = importer.build({'FLAT_RCL_POST_2010.zip': post, 'FLAT_RCL_PRE_2010.zip': pre}, target)
            self.assertEqual(receipt['labels'], 3); self.assertEqual(receipt['rows_without_model_year'], 1)
            self.assertEqual(receipt['skipped_fragment_lines'], 1); self.assertEqual(receipt['latest_report_date'], '2024-10-15')
            with sqlite3.connect(target) as db:
                self.assertEqual(db.execute("SELECT campaigns, compact, campaign_numbers FROM labels WHERE make='HONDA' AND model='CR-V HYBRID' AND year=2024").fetchone(), (2, 'CRVHYBRID', '24V744000 24V763000'))
                self.assertEqual(db.execute('SELECT count(*) FROM labels WHERE year=9999').fetchone()[0], 0)
                self.assertEqual(json.loads(db.execute("SELECT value FROM metadata WHERE key='source'").fetchone()[0])['source_rows'], 6)
            before = target.read_bytes()
            with zipfile.ZipFile(post, 'w') as z: z.writestr('FLAT_RCL_POST_2010.txt', '7\t24V744000\tHONDA\tCR-V\t2024')
            with self.assertRaises(ValueError): importer.build({'FLAT_RCL_POST_2010.zip': post}, target)
            with zipfile.ZipFile(post, 'w') as z: z.writestr('OTHER.txt', row('1', '24V744000', 'HONDA', 'CR-V', '2024'))
            with self.assertRaises(ValueError): importer.build({'FLAT_RCL_POST_2010.zip': post}, target)
            self.assertEqual(target.read_bytes(), before)
            self.assertEqual(list(root.glob('recall-labels-build-*')), [])

    def test_compact_matches_runtime_rule(self):
        self.assertEqual(importer.compact('Mustang Mach-E'), 'MUSTANGMACHE')
        self.assertEqual(importer.compact(' f-150 '), 'F150')

if __name__ == '__main__': unittest.main()

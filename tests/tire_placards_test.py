import importlib.util, json, pathlib, sqlite3, tempfile, unittest

spec = importlib.util.spec_from_file_location('importer', pathlib.Path(__file__).resolve().parents[1]/'scripts/import-tire-placards.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)

URL = 'https://nrd-static.nhtsa.dot.gov/reports/vehdb/v10000/v11400/v11490R001.pdf'


def row(**over):
    r = {'make': 'FORD', 'model': 'F-150', 'model_year': 2021, 'tested_as': '2021 Ford F-150 4x4 SuperCrew',
         'tires': {'front': '275/60R20 115T', 'rear': '275/60R20 115T'},
         'cold_pressure_kpa': {'front': 240, 'rear': 240}, 'cold_pressure_psi': {'front': 35, 'rear': 35},
         'test_no': 11490, 'report_url': URL, 'confidence': 'normal', 'other_reports': []}
    r.update(over)
    return r


def write(path, rows):
    path.write_text(''.join(json.dumps(r) + '\n' for r in rows))


class TirePlacardImportTest(unittest.TestCase):
    def test_build_keys_variants_metadata_and_atomic_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); src = root/'tire-placards.jsonl'; target = root/'tire-placards.db'
            meta = root/'meta.json'; meta.write_text(json.dumps({'generated_at': '2026-11-17T08:00:00Z', 'reports_used': 2}))
            write(src, [row(), row(tires={'front': 'P265/70R17 113T', 'rear': 'P265/70R17 113T'}, test_no=11491, report_url=URL.replace('11490', '11491'),
                              confidence='high', other_reports=[{'test_no': 11492, 'report_url': URL.replace('11490', '11492')}]),
                        row(make='Honda ', model='CR-V', tested_as='2023 Honda CR-V AWD EX', model_year=2023, cold_pressure_kpa={'front': 240, 'rear': 220},
                            cold_pressure_psi={'front': 35, 'rear': 32}, test_no=14439, report_url=URL.replace('11490', '14439'))])
            receipt = importer.build(src, target, meta)
            self.assertEqual(receipt['rows'], 3); self.assertEqual(receipt['keys'], 2); self.assertEqual(receipt['dataset_generated_at'], '2026-11-17T08:00:00Z')
            with sqlite3.connect(target) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM placards WHERE make_key='FORD' AND model_key='F-150' AND year=2021").fetchone()[0], 2)
                self.assertEqual(db.execute("SELECT make_key, psi_front, psi_rear, kpa_rear FROM placards WHERE test_no=14439").fetchone(), ('HONDA', 35, 32, 220.0))
                self.assertEqual(json.loads(db.execute('SELECT other_reports FROM placards WHERE test_no=11491').fetchone()[0])[0]['test_no'], 11492)
            before = target.read_bytes()
            bad_rows = [
                row(cold_pressure_psi={'front': 36, 'rear': 35}),  # psi must be the printed kPa converted
                row(report_url='https://example.com/x.pdf'),  # only NHTSA's report host
                row(cold_pressure_kpa={'front': 35, 'rear': 35}, cold_pressure_psi={'front': 5, 'rear': 5}),  # psi printed as kPa
                row(tires={'front': '', 'rear': '275/60R20'}),
                row(confidence='high'),  # high confidence needs the agreeing second report
                row(model_year=2021.5),
            ]
            for bad in bad_rows:
                write(src, [row(test_no=1), bad])
                with self.assertRaises(ValueError, msg=json.dumps(bad)):
                    importer.build(src, target)
            write(src, [row(), row(test_no=2)])  # same make/model/year/tires twice
            with self.assertRaises(ValueError):
                importer.build(src, target)
            write(src, [])
            with self.assertRaises(ValueError):
                importer.build(src, target)
            self.assertEqual(target.read_bytes(), before)
            self.assertEqual(list(root.glob('tire-placards-build-*')), [])

    def test_tire_size_forms_as_printed(self):
        # Forms the NHTSA data sheets print: plain metric, P-metric with a space, ZR, LT with dual load index,
        # and the HL (high load) prefix with the XL marker (VW ID.Buzz 2025).
        for good in ('275/60R20 115T', 'P225/45 R18 95Y', 'P245/40ZR20 95Y', 'LT265/70R18 124/121S', '235/80R17LT', 'HL 235/50R20 XL 107T'):
            self.assertTrue(importer.SIZE.match(good), good)
        for bad in ('235/50R20 XXL', 'XL 235/50R20', '235/5R20', '235/50 20', 'HL'):
            self.assertFalse(importer.SIZE.match(bad), bad)

    def test_key_matches_runtime_rule(self):
        self.assertEqual(importer.key('  mercedes-benz '), 'MERCEDES-BENZ')
        self.assertEqual(importer.key('Model  3'), 'MODEL 3')
        self.assertNotEqual(importer.key('F-150'), importer.key('F150'))

    def test_shipped_dataset_builds(self):
        src = pathlib.Path(__file__).resolve().parents[1]/'data-src/tire-placards.jsonl'
        meta = src.with_name('tire-placards.meta.json')
        if not src.exists():
            self.skipTest('dataset not shipped')
        with tempfile.TemporaryDirectory() as directory:
            receipt = importer.build(src, pathlib.Path(directory)/'tire-placards.db', meta)
            self.assertGreater(receipt['rows'], 0)


if __name__ == '__main__':
    unittest.main()

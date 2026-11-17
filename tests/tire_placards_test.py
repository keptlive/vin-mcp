import importlib.util, json, pathlib, sqlite3, tempfile, unittest

spec = importlib.util.spec_from_file_location('importer', pathlib.Path(__file__).resolve().parents[1]/'scripts/import-tire-placards.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)

URL = 'https://nrd-static.nhtsa.dot.gov/reports/vehdb/v10000/v11400/v11490R001.pdf'


def row(**over):
    r = {'make': 'FORD', 'model': 'F-150', 'model_year': 2021, 'tested_as': '2021 Ford F-150 4x4 SuperCrew',
         'tires': {'front': '275/60R20 115T', 'rear': '275/60R20 115T'}, 'powertrain': 'not_battery_electric',
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
                row(powertrain='electric'),  # only battery_electric / not_battery_electric / unknown
                row(powertrain=None),
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

    def test_specs_rows_are_validated_and_kept_as_printed(self):
        def spec(**over):
            r = {'make': 'FORD', 'model': 'F-150', 'model_year': 2021, 'tested_as': '2021 Ford F-150', 'powertrain': 'not_battery_electric',
                 'test_no': 11490, 'report_url': URL, 'fuel_tank_standard': {'litres': 87.1, 'printed': 23, 'unit_printed': 'gal', 'method': 'x'},
                 'vehicle_capacity_weight_kg': 650, 'seating': {'front': 3, 'rear': 3, 'third': 0, 'total': 6},
                 'gvwr': {'value': 7000, 'unit_printed': 'lb'}, 'gawr_front': {'value': 2205, 'unit_printed': None, 'unit_assumed': 'kg'},
                 'curb_weight_kg': {'front': 1250, 'rear': 900, 'total': 2150}, 'wheelbase_mm': 3680}
            r.update(over)
            return r
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); src = root/'p.jsonl'; specs = root/'s.jsonl'; target = root/'t.db'
            write(src, [row()])
            write(specs, [spec(), spec(test_no=2, model_year=2022, fuel_tank_standard=None, seating=None)])
            receipt = importer.build(src, target, None, specs)
            self.assertEqual(receipt['specs']['rows'], 2)
            with sqlite3.connect(target) as db:
                data = json.loads(db.execute('SELECT data FROM specs WHERE test_no=11490').fetchone()[0])
                self.assertEqual(data['gvwr'], {'value': 7000, 'unit_printed': 'lb'})
                self.assertEqual(data['fuel_tank_standard']['printed'], 23)
                self.assertNotIn('seating', json.loads(db.execute('SELECT data FROM specs WHERE test_no=2').fetchone()[0]))
            before = target.read_bytes()
            bad_rows = [
                spec(fuel_tank_standard={'litres': 87.1, 'printed': 23, 'unit_printed': 'L', 'method': 'x'}),  # litres must match the printed value
                spec(powertrain='battery_electric'),  # no fuel tank on a battery-electric vehicle
                spec(seating={'front': 2, 'rear': 3, 'third': 0, 'total': 6}),  # parts must add up
                spec(gvwr={'value': 3175, 'unit_printed': None}),  # no printed unit needs the checked kg reading
                spec(gvwr={'value': 300, 'unit_printed': 'kg'}),
                spec(vehicle_capacity_weight_kg=0),
                spec(curb_weight_kg={'front': 1250, 'rear': 900, 'total': 2500}),
                spec(report_url='https://example.com/x.pdf'),
                spec(fuel_tank_standard=None, vehicle_capacity_weight_kg=None, seating=None, gvwr=None, gawr_front=None, curb_weight_kg=None),
            ]
            for bad in bad_rows:
                write(specs, [bad])
                with self.assertRaises(ValueError, msg=json.dumps(bad)):
                    importer.build(src, target, None, specs)
            write(specs, [spec(), spec()])  # one row per test
            with self.assertRaises(ValueError):
                importer.build(src, target, None, specs)
            self.assertEqual(target.read_bytes(), before)

    def test_confirmed_corrections_are_kept_with_what_the_report_printed(self):
        conf = [{'check': 'same_report', 'detail': 'its placard row prints 260/260 kPa', 'report': 'test 11490', 'report_url': URL}]
        fix = {'field': 'cold_pressure', 'rule': 'psi_under_kpa_heading', 'printed': {'value': {'front': 38, 'rear': 38}, 'unit': 'kPa'},
               'corrected': {'value': {'front': 38, 'rear': 38}, 'unit': 'psi', 'kpa': {'front': 260, 'rear': 260}},
               'note': 'NHTSA’s report prints 38/38 under a kPa heading; those are psi.', 'confirmed_by': conf}
        good = row(cold_pressure_kpa={'front': 260, 'rear': 260}, cold_pressure_psi={'front': 38, 'rear': 38}, corrections=[fix])
        tank = {'field': 'fuel_tank_standard_l', 'rule': 'gallons_under_litres_heading', 'printed': {'value': 16.3, 'unit': 'L'},
                'corrected': {'value': 16.3, 'unit': 'gal', 'litres': 61.7}, 'note': 'NHTSA’s report prints 16.3 under a litres heading; that is 16.3 US gallons.',
                'confirmed_by': [{'check': 'plausibility', 'detail': '61.7 L is at least 28 L'}]}
        lbkg = {'field': 'gvwr', 'rule': 'pounds_labelled_kg', 'printed': {'value': 3439, 'unit': 'kg'}, 'corrected': {'value': 3439, 'unit': 'lb', 'kg': 1559.9},
                'note': 'NHTSA’s report prints the GVWR 3,439 under a kg heading; that is 3,439 lb.', 'confirmed_by': [{'check': 'plausibility', 'detail': 'x'}, {'check': 'vpic_gvwr_class', 'detail': 'y'}]}
        spec = {'make': 'FORD', 'model': 'F-150', 'model_year': 2021, 'tested_as': '2021 Ford F-150', 'powertrain': 'not_battery_electric', 'test_no': 11490, 'report_url': URL,
                'fuel_tank_standard': {'litres': 61.7, 'printed': 16.3, 'unit_printed': 'L', 'unit': 'gal', 'method': 'x', 'correction': tank},
                'gvwr': {'value': 3439, 'unit_printed': 'kg', 'unit': 'lb', 'correction': lbkg}}
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); src = root/'p.jsonl'; specs = root/'s.jsonl'; target = root/'t.db'
            write(src, [good]); write(specs, [spec])
            importer.build(src, target, None, specs)
            with sqlite3.connect(target) as db:
                self.assertEqual(json.loads(db.execute('SELECT corrections FROM placards').fetchone()[0])[0]['rule'], 'psi_under_kpa_heading')
                data = json.loads(db.execute('SELECT data FROM specs').fetchone()[0])
                self.assertEqual((data['fuel_tank_standard']['unit'], data['gvwr']['unit']), ('gal', 'lb'))
            # a second report's correction: named, its corrected kPa (248) is the shown psi (36) rounded differently
            second = {**fix, 'report': 'test 10553', 'report_url': URL.replace('11490', '10553'),
                      'corrected': {'value': {'front': 36, 'rear': 36}, 'unit': 'psi', 'kpa': {'front': 248, 'rear': 248}}}
            write(src, [row(cold_pressure_kpa={'front': 250, 'rear': 250}, cold_pressure_psi={'front': 36, 'rear': 36}, corrections=[second])])
            importer.build(src, target)
            write(src, [row()]); importer.build(src, target)  # rows without a correction store NULL
            with sqlite3.connect(target) as db:
                self.assertIsNone(db.execute('SELECT corrections FROM placards').fetchone()[0])
            bad_rows = [
                row(corrections=[fix]),  # the shown pressure is not the corrected one
                {**good, 'corrections': [{**fix, 'confirmed_by': []}]},  # no independent check
                {**good, 'corrections': [{**fix, 'confirmed_by': [{'check': 'vpic_gvwr_class', 'detail': 'x'}]}]},  # supporting check alone
                {**good, 'corrections': [{**fix, 'rule': 'looked_wrong'}]},  # unknown rule
                {**good, 'corrections': [{**fix, 'confirmed_by': [{**conf[0], 'report_url': 'https://example.com/r.pdf'}]}]},
                {**good, 'corrections': []},
                {**good, 'corrections': [{**fix, 'report': 'test 1', 'report_url': 'https://example.com/r.pdf'}]},  # corrected report off NHTSA's hosts
                {**good, 'corrections': [{**fix, 'corrected': {**fix['corrected'], 'kpa': {'front': 241, 'rear': 241}}}]},  # 35 psi, not the shown 38
            ]
            for bad in bad_rows:
                write(src, [bad])
                with self.assertRaises(ValueError, msg=json.dumps(bad)):
                    importer.build(src, target)
            write(src, [row()])
            for bad in ({**spec, 'fuel_tank_standard': {**spec['fuel_tank_standard'], 'correction': None}},  # a corrected unit needs its record
                        {**spec, 'fuel_tank_standard': {**spec['fuel_tank_standard'], 'unit': 'L'}},
                        {**spec, 'gvwr': {**spec['gvwr'], 'correction': {**lbkg, 'rule': 'gallons_under_litres_heading'}}},
                        {**spec, 'gvwr': {'value': 3439, 'unit_printed': 'kg', 'correction': lbkg}}):
                write(specs, [bad])
                with self.assertRaises(ValueError, msg=json.dumps(bad)):
                    importer.build(src, target, None, specs)

    def test_shipped_dataset_builds(self):
        src = pathlib.Path(__file__).resolve().parents[1]/'data-src/tire-placards.jsonl'
        meta = src.with_name('tire-placards.meta.json')
        specs = src.with_name('test-vehicle-specs.jsonl')
        if not src.exists():
            self.skipTest('dataset not shipped')
        with tempfile.TemporaryDirectory() as directory:
            receipt = importer.build(src, pathlib.Path(directory)/'tire-placards.db', meta, specs if specs.exists() else None)
            self.assertGreater(receipt['rows'], 0)
            if specs.exists():
                self.assertGreater(receipt['specs']['rows'], 0)


if __name__ == '__main__':
    unittest.main()

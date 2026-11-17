import csv, importlib.util, io, json, pathlib, sqlite3, tempfile, unittest, zipfile

spec = importlib.util.spec_from_file_location('importer', pathlib.Path(__file__).resolve().parents[1]/'scripts/import-fueleconomy.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)

HEADER = ['id', 'year'] + importer.TEXT + importer.NUMBER


def zipped(name, header, rows):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=header)
    w.writeheader()
    for r in rows:
        w.writerow(r)
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as z:
        z.writestr(name, buf.getvalue())
    return out.getvalue()


VEHICLES = [
    {'id': '35922', 'year': '2015', 'make': 'Ford', 'model': 'F150 Pickup 4WD', 'baseModel': 'F150', 'drive': 'Part-time 4-Wheel Drive', 'trany': 'Automatic (S6)',
     'displ': '2.7', 'cylinders': '6', 'atvType': '', 'fuelType': 'Regular', 'tCharger': 'T', 'VClass': 'Standard Pickup Trucks 4WD',
     'city08': '18', 'highway08': '23', 'comb08': '20', 'cityA08': '0', 'range': '0', 'charge240': '0', 'co2TailpipeGpm': '444.4'},
    {'id': '40000', 'year': '2017', 'make': 'Chevrolet', 'model': 'Bolt EV', 'baseModel': 'Bolt', 'drive': 'Front-Wheel Drive', 'trany': 'Automatic (A1)',
     'displ': '', 'cylinders': '', 'atvType': 'EV', 'fuelType': 'Electricity', 'VClass': 'Small Station Wagons', 'city08': '128', 'highway08': '110', 'comb08': '119', 'range': '238', 'co2TailpipeGpm': '0'},
    {'id': 'x', 'year': '2015', 'make': 'Ford', 'model': 'Broken', 'trany': '', 'drive': ''},           # no usable id
    {'id': '41000', 'year': '2016', 'make': '', 'model': 'No make', 'trany': '', 'drive': ''},        # no make
]
EMISSIONS = [
    {'efid': 'FFMXT02.73DH', 'id': '35922', 'salesArea': '7', 'score': '5', 'scoreAlt': '-1', 'smartwayScore': '-1', 'standard': 'T3B70', 'stdText': 'Tier 3 Bin 70'},
    {'efid': 'ffmxt02.73dh', 'id': '35922', 'salesArea': '3', 'score': '5', 'scoreAlt': '-1', 'smartwayScore': '-1', 'standard': 'L3ULEV70', 'stdText': 'LEV III'},  # same group, other sales area
    {'efid': 'HGMXV00.0002', 'id': '40000', 'salesArea': '7', 'score': '10', 'scoreAlt': '-1', 'smartwayScore': '1', 'standard': 'T3B0', 'stdText': 'Tier 3 Bin 0'},
    {'efid': 'ZZZ', 'id': '99999', 'salesArea': '7', 'score': '', 'scoreAlt': '', 'smartwayScore': '', 'standard': '', 'stdText': ''},  # no such vehicle
]


class FuelEconomyImportTest(unittest.TestCase):
    def test_columns_keep_csv_names_empties_stay_unknown_and_test_groups_link(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); target = root/'fueleconomy.db'
            (root/'vehicles.csv.zip').write_bytes(zipped('vehicles.csv', HEADER, VEHICLES))
            (root/'emissions.csv.zip').write_bytes(zipped('emissions.csv', list(EMISSIONS[0]), EMISSIONS))
            receipt = importer.build(root/'vehicles.csv.zip', root/'emissions.csv.zip', target, [{'file': 'vehicles.csv.zip'}])
            self.assertEqual((receipt['vehicle_rows_read'], receipt['configurations'], receipt['test_group_links']), (4, 2, 2))
            self.assertEqual(receipt['rejected'], {'missing_id_year_make_or_model': 2, 'emissions_row_without_vehicle': 1})
            self.assertEqual(receipt['model_years'], [2015, 2017])
            with sqlite3.connect(target) as db:
                db.row_factory = sqlite3.Row
                f150 = db.execute('SELECT * FROM vehicles WHERE id=35922').fetchone()
                self.assertEqual((f150['make_key'], f150['model'], f150['trany'], f150['displ'], f150['comb08'], f150['tCharger']), ('FORD', 'F150 Pickup 4WD', 'Automatic (S6)', 2.7, 20, 'T'))
                self.assertIsNone(f150['atvType'])          # empty cell: unknown, not ''
                self.assertEqual(f150['cityA08'], 0)        # a real 0 stays 0
                bolt = db.execute('SELECT * FROM vehicles WHERE id=40000').fetchone()
                self.assertIsNone(bolt['displ']); self.assertIsNone(bolt['cylinders']); self.assertEqual(bolt['range'], 238)
                self.assertEqual([tuple(r) for r in db.execute('SELECT efid FROM emissions WHERE id=35922')], [('FFMXT02.73DH',)])
                meta = json.loads(db.execute("SELECT value FROM metadata WHERE key='source'").fetchone()[0])
                self.assertEqual(meta['sources'], [{'file': 'vehicles.csv.zip'}])
            # A failed build keeps the old index.
            before = target.read_bytes()
            (root/'bad.zip').write_bytes(zipped('vehicles.csv', ['id', 'year', 'make'], [{'id': '1', 'year': '2015', 'make': 'Ford'}]))
            with self.assertRaises(ValueError):
                importer.build(root/'bad.zip', root/'emissions.csv.zip', target)
            self.assertEqual(target.read_bytes(), before)
            self.assertEqual(list(root.glob('fueleconomy-build-*')), [])

    def test_compact_matches_runtime_rule(self):
        self.assertEqual(importer.compact('Mercedes-Benz'), 'MERCEDESBENZ')
        self.assertEqual(importer.compact('smart'), 'SMART')


if __name__ == '__main__':
    unittest.main(verbosity=1)

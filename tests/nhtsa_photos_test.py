"""NHTSA test-vehicle photos: the file-name rules (real names from NHTSA's crash-test database, several labs and
years), the per-test choice, the manifest stems, the photo index import and the image build's stop rules."""
import importlib.util, io, json, pathlib, shutil, sqlite3, sys, tempfile, unittest, urllib.error
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from nhtsa_photo_select import choose, classify, post_order, struck_side, test_kind  # noqa: E402


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


importer = load('importer', 'import-tire-placards.py')
manifest = load('manifest', 'nhtsa-photo-manifest.py')
try:
    import PIL  # noqa: F401
    build = load('build', 'build-nhtsa-photos.py')
except ImportError:  # the image build runs on a build server; its tests need Pillow
    build = None

# (lab, model year, name as NHTSA lists it) -> (phase, view)
WHOLE_CAR = [
    ('Karco', 2024, 'No. 001 - As-Delivered Right Front 3-4 View of Test Vehicle.jpg', ('pre', 'front_34_right')),
    ('Calspan', 2015, 'Photo #001 - As Delivered Right Front Three-Quarter View of Test Vehicle.JPG', ('pre', 'front_34_right')),
    ('MGA', 2013, 'No. 006 Left Rear 3-4 View, As Received.jpg', ('pre', 'rear_34_left')),
    ('TRC', 2013, 'No. 005   2013 Jeep Patriot Sport 4x4 Frontal As Delivered.JPG', ('pre', 'as_delivered')),
    ('Calspan', 2007, 'pre left front.JPG', ('pre', 'front_34_left')),
    ('Calspan', 2007, 'post left.JPG', ('post', 'side_left')),
    ('Calspan', 2007, 'pre left rear.JPG', ('pre', 'rear_34_left')),
    ('TRC', 2016, 'No. 013   Pre-Test Right Front ¾ View.JPG', ('pre', 'front_34_right')),
    ('Karco', 2012, 'No. 005 - Pre-Test Left Front + View of Test Vehicle.JPG', ('pre', 'front_34_left')),
    ('MGA', 2011, 'Figure A-12, Pre-Test Right Front 3-4 View of Test Vehicle.jpg', ('pre', 'front_34_right')),
    ('Karco', 2011, '014. Post-test Right Front 3-4 View.jpg', ('post', 'front_34_right')),
    ('Karco', 2023, 'No. 003 - Pre-Test Frontal View of the Test Vehicle.JPG', ('pre', 'front')),
    ('MGA', 2014, 'No. 008 Post-Test Front View of Test Vehicle.jpg', ('post', 'front')),
    ('TRC', 2019, 'No. 010 Post-Test Left Rear 3-4 View of Test Vehicle.jpg', ('post', 'rear_34_left')),
    ('Medical College of Wisconsin', 2012, 'No. 013 - Pre - Test Right side View of test vehicle.JPG', ('pre', 'side_right')),
    ('MGA', 2014, '2014 Mercedes-Benz E350 4-Door Sedan As DELIVERED FOR WEB.jpg', ('pre', 'as_delivered')),
    ('TRC', 2017, 'No. 006  2017 Jeep Wrangler Unlimited Frontal As Delivered Right Front 3-4 View.JPG', ('pre', 'front_34_right')),
    ('Karco', 2011, 'No. 002 - 2011 BMW 535i As Delivered Left Rear Three-Quarter View of Test Vehicle.jpg', ('pre', 'rear_34_left')),
    ('MGA', 2019, 'Photo No. 009 - Pre-Test Left Three-Quarter Rear View of Test Vehicle.JPG', ('pre', 'rear_34_left')),
    ('Medical College of Wisconsin', 2011, 'No. 001 - 2011 Mercedes Benz C300 As Delivered Right Front Three-Quarter View of Test Vehicle.JPG', ('pre', 'front_34_right')),
    ('Calspan', 2022, 'No. 014 Pre-Test Right Front 3-4 View.JPG', ('pre', 'front_34_right')),
    ('Calspan', 2022, 'No. 007 Left Rear 3-4 View, as Received.JPG', ('pre', 'rear_34_left')),
    ('MGA', 2016, '2016 Buick Envision AWD Premium II 5-Dr SUV Side NCAP MDB IMPACT FOR WEB.jpg', ('impact', None)),
    ('Calspan', 2011, 'No. 066 - pole IMPACT FOR WEB.jpg', ('impact', None)),
    # vehicle names that contain excluded words must not reject the photo
    ('Karco', 2011, '2011 Dodge Charger RT Frontal As Delivered for Web.jpg', ('pre', 'as_delivered')),
    ('test', 2016, '2016 Subaru Outback All-Wheel Drive Pre-Test Right Front View.jpg', ('pre', 'front_34_right')),
    ('test', 2020, '2020 Chevrolet Trailblazer Pre-Test Front View.jpg', ('pre', 'front')),
]

NOT_WHOLE_CAR = [
    'Pre-Test Right Front Passenger Front View.JPG',  # the passenger dummy, not the car's right side
    'No. 031 Post-Test Driver Dummy Front View.JPG',
    'Photo No. 053 - Pre-Test Passenger Dummy Front View .JPG',
    'No. 088 MDB Onboard Close Impact.jpg',
    'IMG_1234.JPG', 'DSC_0042.jpg', '1234.jpg', 'P1010023.JPG', '',  # camera names say nothing
    'No. 021 Pre-Test Left Front Door Latch Close-up.jpg',
    'Photo No. 017 - Pre-Test Left Side View of MDB Positioned Against Side of Test Vehicle.JPG',
    'No. - 026. Post-test Rear Underbody View.jpg',
    'No. 089 - Post-Test Right Side View of MDB Impactor Face.jpg',
    'No. 024    Pre-Test Front Underbody View.JPG',
    'No. 040 - Pre-Test Close-Up Left Side View of Driver Seat Back.jpg',
    'No. 004 Monroney Label.jpg', 'No. 003 Vehicle Certification Label.JPG', 'No. 005 Tire Placard.jpg',
    'No. 012 Pre-Test Engine Compartment View.JPG', 'Pre-Test Left Front Wheel View.jpg',
    'Pre-Test Right Side View of Barrier.jpg',
    'No. 012 - Post-Test Rear Side View of Test Vehicle.JPG',  # which side?
    'PRE UND FRONT SIDE.JPG',
    'Left Front View.jpg',  # no phase: before or after?
    'Post-Test Frontal.jpg',  # names the test, not a view
    '2012 Chevrolet Silverado 1500 Crew Cab 4WD Frontal Post Test.jpg',
    'No. 064  Pre-Test Placement of Rear Passenger Dummy\'s Feet.JPG',
    'No. 073 - Pre-Test Rear Passenger Inner Door Panel View.JPG',
]


def photo(file, name):
    return {'file': file, 'name': name, 'media': f'https://nrd-static.nhtsa.dot.gov/photos/vehdb/v10000/v10000/{file}'}


class ClassifyTest(unittest.TestCase):
    def test_whole_car_views_from_several_labs_and_years(self):
        for lab, year, name, (phase, view) in WHOLE_CAR:
            got = classify(name)
            self.assertIsNotNone(got, f'{lab} {year}: {name}')
            self.assertEqual((got['phase'], got['view']), (phase, view), f'{lab} {year}: {name}')

    def test_everything_else_is_rejected(self):
        for name in NOT_WHOLE_CAR:
            self.assertIsNone(classify(name), name)

    def test_web_flag_and_odd_spacing(self):
        self.assertTrue(classify('No. 013 Pre-test Right Front 3-4 View AS DELIVERED FOR WEB.JPG')['web'])
        self.assertFalse(classify('No. 013 Pre-test Right Front 3-4 View.JPG')['web'])
        self.assertEqual(classify('No. 051\xa0\xa0\xa0Pre-Test Left Side View of Test Vehicle.JPG')['view'], 'side_left')


class ChooseTest(unittest.TestCase):
    LISTING = [
        photo('v10060P001.jpg', 'No. 001 - As-Delivered Right Front 3-4 View of Test Vehicle.jpg'),
        photo('v10060P002.jpg', 'No. 002 - As-Delivered Left Rear 3-4 View of Test Vehicle.jpg'),
        photo('v10060P003.jpg', 'No. 003 - Pre-Test Frontal View of Test Vehicle.jpg'),
        photo('v10060P004.jpg', 'No. 004 - Monroney Label.jpg'),
        photo('v10060P005.jpg', 'No. 005 - Pre-Test Left Front 3-4 View of Test Vehicle.jpg'),
        photo('v10060P007.jpg', 'No. 007 - Pre-Test Left Side View of Test Vehicle.jpg'),
        photo('v10060P008.jpg', 'No. 008 - Post-Test Left Side View of Test Vehicle.jpg'),
        photo('v10060P013.jpg', 'No. 013 - Pre-Test Right Front 3-4 View of Test Vehicle.jpg'),
        photo('v10060P014.jpg', 'No. 014 - Post-Test Right Front 3-4 View of Test Vehicle.jpg'),
        photo('v10060P020.jpg', 'No. 020 - Pre-Test Driver Dummy Front View.jpg'),
        photo('v10060P066.jpg', '2017 Honda CR-V Side NCAP MDB Impact for Web.jpg'),
    ]

    def test_three_pre_views_one_per_group_then_the_post_view_for_the_test(self):
        got = choose(self.LISTING, 'side', 'left')
        self.assertEqual([(p['file'], p['phase'], p['view']) for p in got], [
            ('v10060P005.jpg', 'pre', 'front_34_left'),  # one front three-quarter: the left one first
            ('v10060P007.jpg', 'pre', 'side_left'),
            ('v10060P002.jpg', 'pre', 'rear_34_left'),
            ('v10060P008.jpg', 'post', 'side_left'),  # the struck side after the test
        ])
        self.assertNotIn('impact', [p['phase'] for p in got])  # the impact moment is recognised but never kept
        frontal = choose(self.LISTING, 'frontal', None)
        self.assertEqual(frontal[-1]['file'], 'v10060P014.jpg')
        self.assertEqual(len(frontal), 4)

    def test_fail_closed(self):
        self.assertEqual([p['phase'] for p in choose(self.LISTING, 'side', None)], ['pre', 'pre', 'pre'])  # struck side unknown
        self.assertEqual([p['phase'] for p in choose(self.LISTING, None, None)], ['pre', 'pre', 'pre'])  # not a crash test
        self.assertEqual(choose([photo('v1P1.jpg', 'IMG_0001.JPG'), photo('v1P2.jpg', None)], 'frontal', None), [])
        self.assertEqual(post_order('pole', None), [])

    def test_web_copy_wins_within_a_view(self):
        got = choose([photo('v1P001.jpg', 'Pre-Test Right Front 3-4 View.jpg'),
                      photo('v1P002.jpg', 'Right Front 3-4 View As Delivered for Web.jpg')], None, None)
        self.assertEqual([p['file'] for p in got], ['v1P002.jpg'])

    def test_test_kind_and_struck_side(self):
        self.assertEqual(test_kind('VEHICLE INTO BARRIER', 0), 'frontal')
        self.assertEqual(test_kind('IMPACTOR INTO VEHICLE', 270), 'side')
        self.assertEqual(test_kind('IMPACTOR INTO VEHICLE', 180), 'rear')
        self.assertIsNone(test_kind('IMPACTOR INTO VEHICLE', 315))
        self.assertEqual(test_kind('VEHICLE INTO POLE', 285), 'pole')
        self.assertIsNone(test_kind('LOW RISK DEPLOYMENT', 0))
        self.assertEqual((struck_side(270), struck_side(285), struck_side(90), struck_side(0), struck_side(None)), ('left', 'left', 'right', None, None))


class ManifestStemTest(unittest.TestCase):
    def test_stems(self):
        self.assertEqual(manifest.stem_of(10060, {'fileName': 'v10060P001.jpg', 'index': 1}), 'v10060P001')
        self.assertEqual(manifest.stem_of(10060, {'fileName': 'v10060P0011.JPG', 'index': 1}), 'v10060P0011')
        # newer listings name the file by the lab's long name: the stem comes from the listing index
        self.assertEqual(manifest.stem_of(14432, {'fileName': 'No. 003 - Pre-Test Frontal View of Test Vehicle.jpg', 'index': 7}), 'v14432N007')
        self.assertIsNone(manifest.stem_of(14432, {'fileName': 'No. 003.jpg'}))


def photo_row(**over):
    url = 'https://nrd-static.nhtsa.dot.gov/reports/vehdb/v10000/v10000/v10060R001.pdf'
    p = lambda stem, phase, view: {'stem': stem, 'phase': phase, 'view': view, 'web': False,
                                   'w960': {'width': 960, 'height': 640, 'bytes': 50000}, 'w320': {'width': 320, 'height': 213, 'bytes': 9000},
                                   'nhtsa_url': f'https://nrd-static.nhtsa.dot.gov/photos/vehdb/v10000/v10000/{stem}.jpg', 'original_file_name': f'{stem} name.jpg'}
    r = {'make': 'HONDA', 'model': 'CR-V', 'model_year': 2017, 'tested_as': '2017 Honda CR-V AWD LX', 'powertrain': 'not_battery_electric',
         'body_class': 'Sport Utility Vehicle (SUV)/Multi-Purpose Vehicle (MPV)', 'report_url': url, 'test_no': 10060, 'test_kind': 'side',
         'struck_side': 'left', 'closing_speed_kmh': 61.9, 'vpic_extra': {'doors': 4},
         'photos': [p('v10060P005', 'pre', 'front_34_left'), p('v10060P007', 'pre', 'side_left'), p('v10060P008', 'post', 'side_left')]}
    r.update(over)
    return r


class PhotoIndexImportTest(unittest.TestCase):
    def build(self, rows, folder=None):
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, True)
        root = pathlib.Path(directory)
        placards = root / 'p.jsonl'
        placards.write_text(json.dumps({'make': 'FORD', 'model': 'F-150', 'model_year': 2021, 'tested_as': '2021 Ford F-150', 'tires': {'front': '275/60R20 115T', 'rear': '275/60R20 115T'},
                                        'powertrain': 'not_battery_electric', 'cold_pressure_kpa': {'front': 240, 'rear': 240}, 'cold_pressure_psi': {'front': 35, 'rear': 35},
                                        'test_no': 11490, 'report_url': 'https://nrd-static.nhtsa.dot.gov/reports/vehdb/v10000/v11400/v11490R001.pdf',
                                        'confidence': 'normal', 'other_reports': []}) + '\n')
        photos = root / 'photos.jsonl'
        photos.write_text(''.join(json.dumps(r) + '\n' for r in rows))
        target = root / 't.db'
        receipt = importer.build(placards, target, None, None, None, photos, None, folder)
        return receipt, target

    def test_rows_are_stored_and_bad_rows_rejected(self):
        receipt, target = self.build([photo_row()])
        self.assertEqual((receipt['photos']['rows'], receipt['photos']['photos'], receipt['photos']['photos_dir_verified']), (1, 3, False))
        with sqlite3.connect(target) as db:
            make, year, kind, photos = db.execute('SELECT make_key, year, test_kind, photos FROM photos').fetchone()
        self.assertEqual((make, year, kind), ('HONDA', 2017, 'side'))
        self.assertEqual([p['stem'] for p in json.loads(photos)], ['v10060P005', 'v10060P007', 'v10060P008'])
        good = photo_row()['photos'][0]
        bad_rows = [
            photo_row(report_url='https://example.com/r.pdf'),
            photo_row(photos=[]),
            photo_row(photos=[{**good, 'stem': '../etc/passwd'}]),
            photo_row(photos=[{**good, 'phase': 'impact'}]),
            photo_row(photos=[{**good, 'view': None}]),
            photo_row(photos=[{**good, 'view': 'interior'}]),
            photo_row(photos=[{**good, 'nhtsa_url': 'https://example.com/a.jpg'}]),
            photo_row(photos=[{**good, 'nhtsa_url': 'https://nrd-static.nhtsa.dot.gov/vehdb/14432/photos/No. 1.jpg'}]),  # not encoded
            photo_row(photos=[{**good, 'w960': {'width': 1200, 'height': 800, 'bytes': 1}}]),
            photo_row(photos=[{**good, 'phase': 'post'}], test_kind=None),  # after which test?
            photo_row(photos=[good, good]),
            photo_row(test_kind='rollover'),
        ]
        for bad in bad_rows:
            with self.assertRaises(ValueError, msg=json.dumps(bad)[:200]):
                self.build([bad])
        with self.assertRaises(ValueError):
            self.build([photo_row(), photo_row()])  # one row per test

    def test_photos_without_files_are_left_out_when_the_folder_is_there(self):
        with tempfile.TemporaryDirectory() as folder:
            d = pathlib.Path(folder) / '10060'
            d.mkdir()
            for stem in ('v10060P005', 'v10060P008'):
                for w in (960, 320):
                    (d / f'{stem}-{w}.webp').write_bytes(b'RIFF')
            (d / 'v10060P007-960.webp').write_bytes(b'RIFF')  # the thumbnail is missing: left out
            receipt, target = self.build([photo_row(), photo_row(test_no=10061, photos=photo_row()['photos'][:1])], folder)
            self.assertEqual((receipt['photos']['rows'], receipt['photos']['photos'], receipt['photos']['photos_missing_files_left_out']), (1, 2, 2))
            with sqlite3.connect(target) as db:
                self.assertEqual([p['stem'] for p in json.loads(db.execute('SELECT photos FROM photos').fetchone()[0])], ['v10060P005', 'v10060P008'])

    def test_shipped_photo_index_is_valid(self):
        src = ROOT / 'data-src/test-vehicle-photos.jsonl'
        if not src.exists():
            self.skipTest('no photo index in this checkout')
        for n, line in enumerate(src.read_text().splitlines(), 1):
            importer.check_photo_row(json.loads(line), n)


class FakeResponse(io.BytesIO):
    headers = {}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@unittest.skipIf(build is None, 'Pillow not installed')
class ImageBuildTest(unittest.TestCase):
    def run_build(self, answers, photos):
        from PIL import Image
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, True)
        root = pathlib.Path(directory)
        man = root / 'manifest.jsonl'
        man.write_text(json.dumps({'test_no': 10060, 'photos': photos}) + '\n')
        seen = []

        def urlopen(req, timeout=None):
            seen.append(req.full_url)
            a = answers.pop(0)
            if isinstance(a, int):
                raise urllib.error.HTTPError(req.full_url, a, 'x', {}, io.BytesIO(b''))
            buf = io.BytesIO()
            Image.new('RGB', a, (90, 120, 160)).save(buf, 'JPEG')
            return FakeResponse(buf.getvalue())
        with mock.patch.object(build, 'GAP', 0), mock.patch.object(build, 'log', lambda m: None), mock.patch.object(build.urllib.request, 'urlopen', urlopen), \
                mock.patch.object(sys, 'argv', ['b', str(man), str(root / 'out'), str(root / 'orig')]):
            code = build.main()
        built = [json.loads(line) for line in (root / 'out/built.jsonl').read_text().splitlines()]
        return code, built, root, seen

    def ph(self, i, name='No. 1.jpg'):
        return {'file': f'v10060P{i:03d}.jpg', 'stem': f'v10060P{i:03d}', 'media': f'https://nrd-static.nhtsa.dot.gov/photos/vehdb/v10000/v10000/v10060P{i:03d}.jpg'}

    def test_resizes_and_skips_narrow_and_missing(self):
        newer = {'file': 'No. 003 - Pre-Test View.jpg', 'stem': 'v10060N003', 'media': 'https://nrd-static.nhtsa.dot.gov/vehdb/10060/photos/No. 003 - Pre-Test View.jpg'}
        code, built, root, seen = self.run_build([(2000, 1500), (222, 127), 403, (1800, 1200)], [self.ph(1), self.ph(2), self.ph(3), newer])
        self.assertEqual(code, 0)
        self.assertTrue((root / 'out/DONE').exists())
        self.assertEqual((built[0]['w960']['width'], built[0]['w960']['height'], built[0]['w320']['width']), (960, 720, 320))
        self.assertEqual(built[1]['skipped'], 'narrow_222x127')
        self.assertTrue(built[2]['skipped'].startswith('missing'))
        self.assertTrue((root / 'out/10060/v10060N003-960.webp').exists())
        self.assertEqual(seen[3], 'https://nrd-static.nhtsa.dot.gov/vehdb/10060/photos/No.%20003%20-%20Pre-Test%20View.jpg')
        from PIL import Image
        with Image.open(root / 'out/10060/v10060P001-960.webp') as im:
            self.assertEqual(im.format, 'WEBP')
            self.assertFalse(im.info.get('exif'))

    def test_stops_on_a_block(self):
        for answers, why in (([429], 'HTTP 429'), ([503], 'HTTP 503'), ([403, 403, 403], '3 HTTP 403')):
            code, built, root, seen = self.run_build(list(answers), [self.ph(i) for i in range(1, 5)])
            self.assertEqual(code, 3, why)
            self.assertIn(why, (root / 'out/FAILED').read_text())
            self.assertLessEqual(len(seen), len(answers))

    def test_only_nrd_static(self):
        with self.assertRaises(ValueError):
            build.fetch('https://example.com/x.jpg', '/dev/null')


if __name__ == '__main__':
    unittest.main()

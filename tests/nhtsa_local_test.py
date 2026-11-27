"""Importers for the local NHTSA copies: recall and complaint flat files, the ratings crawl and its build."""
import datetime, importlib.util, io, json, pathlib, sqlite3, tempfile, unittest, urllib.error, zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


recalls = load('recalls', 'import-nhtsa-recalls.py')
complaints = load('complaints', 'import-nhtsa-complaints.py')
harvest = load('harvest', 'harvest-nhtsa-ratings.py')
campaign_crawl = load('campaign_crawl', 'harvest-nhtsa-recall-campaigns.py')
ratings = load('ratings', 'import-nhtsa-ratings.py')


def rcl(record, campaign, make, model, year, component='STEERING', rtype='V', rcdate='20241003', datea='20241004',
        summary='Defect.', dnd='No', park='No', mfr='Honda (American Honda Motor Co.)', notes='Notes.'):
    r = [''] * 29
    r[0], r[1], r[2], r[3], r[4], r[6], r[7], r[10] = record, campaign, make, model, year, component, mfr, rtype
    r[14], r[15], r[16], r[19], r[20], r[21], r[22], r[27], r[28] = mfr, rcdate, datea, summary, 'Crash risk.', 'Dealers fix.', notes, dnd, park
    return '\t'.join(r)


def cmpl(cmplid, odi, make, model, year, component, text='IT FAILED.', crash='N', fire='N', injured='0', deaths='0',
         faildate='20240105', ldate='20240110', prod='V', city='SECRETVILLE', vin='1HGCM82633A', operator='JANE DOE'):
    r = [''] * 51
    r[0], r[1], r[2], r[3], r[4], r[5] = str(cmplid), str(odi), 'MAKER', make, model, year
    r[6], r[7], r[8], r[9], r[10], r[11] = crash, faildate, fire, injured, deaths, component
    r[12], r[13], r[14], r[16], r[19], r[45], r[50] = city, 'NY', vin, ldate, text, prod, operator
    return '\t'.join(r)


def zip_text(path, member, lines):
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr(member, '\r\n'.join(lines) + '\r\n')


class RecallImportTest(unittest.TestCase):
    def test_campaign_text_once_components_per_vehicle_and_atomic_guard(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            pre, post, out = d / 'FLAT_RCL_PRE_2010.zip', d / 'FLAT_RCL_POST_2010.zip', d / 'nhtsa-recalls.db'
            zip_text(pre, 'FLAT_RCL_PRE_2010.txt', [rcl('1', '04V001000', 'FORD', 'TAURUS', '2004', rcdate='20040105', datea='20040106')])
            zip_text(post, 'FLAT_RCL_POST_2010.txt', [
                rcl('10', '24V744000', 'HONDA', 'CR-V', '2024', component='STEERING ', dnd='Yes'),
                rcl('11', '24V744000', 'HONDA', 'CR-V', '2024', component='STEERING ', dnd='Yes'),  # same part, other row
                rcl('12', '24V744000', 'HONDA', 'CR-V', '2024', component='ELECTRICAL SYSTEM', dnd='Yes'),
                '',
                rcl('13', '24V744000', 'honda', 'cr-v  hybrid ', '2024', dnd='Yes', summary='Other text.'),  # differs: counted, lowest record kept
                rcl('14', '24E001000', 'ACME', 'WIDGET', '2024', rtype='E', notes='line one\nline two'),
            ])
            meta = recalls.build(pre, post, out, 'Thu, 26 Nov 2026 08:04:00 GMT')
            self.assertEqual(meta['counts']['campaigns'], 3)
            self.assertEqual(meta['counts']['source_rows'], 6)
            self.assertEqual(meta['counts']['campaigns_with_differing_rows'], 1)
            self.assertEqual(meta['source_last_modified'], '2026-11-26T08:04:00+00:00')
            self.assertEqual(meta['latest_report_date'], '2024-10-03')
            db = sqlite3.connect(out)
            self.assertEqual(db.execute("SELECT component, first_record FROM vehicles WHERE make='HONDA' AND model='CR-V' ORDER BY first_record").fetchall(),
                             [('STEERING', 10), ('ELECTRICAL SYSTEM', 12)])
            self.assertEqual(db.execute("SELECT COUNT(*) FROM vehicles WHERE make='HONDA' AND model='CR-V HYBRID'").fetchone()[0], 1)
            c = db.execute("SELECT manufacturer, type, report_received, record_created, do_not_drive, park_outside FROM campaigns WHERE campaign='24V744000'").fetchone()
            self.assertEqual(c, ('Honda (American Honda Motor Co.)', 'V', '2024-10-03', '2024-10-04', 1, 0))
            self.assertEqual(db.execute("SELECT summary FROM campaigns WHERE campaign='24V744000'").fetchone()[0], 'Defect.')
            self.assertEqual(db.execute("SELECT notes FROM campaigns WHERE campaign='24E001000'").fetchone()[0], 'line one\nline two')
            db.close()
            # A build that loses most campaigns does not replace the file.
            before = out.read_bytes()
            zip_text(post, 'FLAT_RCL_POST_2010.txt', [rcl('10', '24V744000', 'HONDA', 'CR-V', '2024')])
            zip_text(pre, 'FLAT_RCL_PRE_2010.txt', [rcl('1', '04V001000', 'FORD', 'TAURUS', '2004')])
            with self.assertRaises(ValueError):
                recalls.build(pre, post, out, previous=out)
            self.assertEqual(out.read_bytes(), before)
            # A record with too many fields is a schema error, not a silent skip.
            zip_text(post, 'FLAT_RCL_POST_2010.txt', [rcl('10', '24V744000', 'HONDA', 'CR-V', '2024') + '\textra'])
            with self.assertRaises(ValueError):
                recalls.build(pre, post, out, allow_shrink=True)
            self.assertEqual(out.read_bytes(), before)
            self.assertEqual([p.name for p in d.glob('.nhtsa-recalls.db.*')], [])


class RecallCampaignCrawlTest(unittest.TestCase):
    """The per-campaign API crawl and its merge into the recall build: only values that still fit the flat files."""

    def api_row(self, make, model, year, component, **extra):
        return {'Manufacturer': 'Honda (American Honda Motor Co.)', 'NHTSACampaignNumber': extra.pop('campaign', '24V744000'),
                'ReportReceivedDate': '04/10/2024', 'Component': component, 'Summary': 'Defect.\r\nMore.', 'Consequence': 'Crash risk.',
                'Remedy': 'Dealers fix.', 'Notes': 'Notes.', 'ModelYear': str(year), 'Make': make, 'Model': model, **extra}

    def test_crawl_merge_and_change_detection(self):
        C = campaign_crawl
        C.RETRY_WAITS, C.FINAL_PASS_WAIT = (0, 0, 0), 0
        url = lambda c: C.URL.format(c).replace('https://api.nhtsa.gov', '')
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            pre, post = d / 'FLAT_RCL_PRE_2010.zip', d / 'FLAT_RCL_POST_2010.zip'
            zip_text(pre, 'FLAT_RCL_PRE_2010.txt', [rcl('1', '04V001000', 'FORD', 'TAURUS', '2004', rcdate='20040105')])
            zip_text(post, 'FLAT_RCL_POST_2010.txt', [
                rcl('10', '24V744000', 'HONDA', 'CR-V', '2024', component='STEERING', summary='Defect. More.'),
                rcl('11', '24V744000', 'HONDA', 'CR-V', '2024', component='ELECTRICAL SYSTEM', summary='Defect. More.'),
                rcl('12', '24V744000', 'HONDA', 'CR-V HYBRID', '2024', component='STEERING', summary='Defect. More.'),
                rcl('13', '24E001000', 'ACME', 'WIDGET', '2024', component='EQUIPMENT', rtype='E', rcdate='20240101'),
                rcl('14', '24V500000', 'HONDA', 'CR-V', '2024', component='WHEELS', rcdate='20240601'),
            ])
            routes = {
                url('24V744000'): {'Count': 2, 'results': [
                    self.api_row('HONDA', 'CR-V', 2024, 'ELECTRICAL SYSTEM', overTheAirUpdate=True, parkIt=False, parkOutSide=False),
                    self.api_row('HONDA', 'CR-V HYBRID', 2024, 'STEERING', overTheAirUpdate=True, parkIt=False, parkOutSide=False)]},
                url('24E001000'): {'Count': 1, 'results': [self.api_row('ACME', 'WIDGET', 2024, 'EQUIPMENT', campaign='24E001000',
                                                                        ReportReceivedDate='01/01/2024', Summary='Defect.')]},
                url('04V001000'): {'Count': 0, 'results': []},
                # The API names a component the flat files do not recall in this campaign and a date far off: neither is used.
                url('24V500000'): {'Count': 1, 'results': [self.api_row('HONDA', 'CR-V', 2024, 'ENGINE', campaign='24V500000',
                                                                        ReportReceivedDate='01/07/2024', Summary='Other text.', overTheAirUpdate=False)]},
            }
            state = C.open_state(d / 'campaigns.db')
            flat = C.flat_campaigns(pre, post)
            today = datetime.date(2026, 11, 27)
            work = C.due(state, flat, today)
            self.assertEqual([c for c, _, _ in work], ['24V744000', '24V500000', '24E001000', '04V001000'])  # newest report first
            api = FakeApi(routes, fail={url('24V500000')})
            h = C.Harvester(state, 0, 5, 'run1', lambda m: None, opener=api)
            result = C.harvest(state, h, work)
            self.assertEqual((result['clean'], result['failed']), (3, 1))
            self.assertEqual(dict(state.execute('SELECT campaign, status FROM campaigns').fetchall()),
                             {'24V744000': 'ok', '24E001000': 'ok', '04V001000': 'absent', '24V500000': 'failed'})
            self.assertEqual(state.execute("SELECT ota, park_it, component, vehicle_components IS NOT NULL FROM campaigns WHERE campaign='24E001000'").fetchone(),
                             (None, None, 'EQUIPMENT', 0))
            # Next run: only the failed campaign is due; a capped run stops cleanly.
            self.assertEqual([(c, why) for c, _, why in C.due(state, flat, today)], [('24V500000', 'missing')])
            capped = C.harvest(state, h, C.due(state, flat, today) * 2, max_requests=1)
            self.assertEqual((capped['complete'], capped['reason'], capped['fetched']), (False, 'request cap', 1))
            # An amended campaign (new text in the flat files) is due again; a failed re-fetch keeps the clean answer.
            zip_text(post, 'FLAT_RCL_POST_2010.txt', [
                rcl('10', '24V744000', 'HONDA', 'CR-V', '2024', component='STEERING', summary='Defect. More. Amended.'),
                rcl('11', '24V744000', 'HONDA', 'CR-V', '2024', component='ELECTRICAL SYSTEM', summary='Defect. More. Amended.'),
                rcl('12', '24V744000', 'HONDA', 'CR-V HYBRID', '2024', component='STEERING', summary='Defect. More. Amended.'),
                rcl('13', '24E001000', 'ACME', 'WIDGET', '2024', component='EQUIPMENT', rtype='E', rcdate='20240101'),
                rcl('14', '24V500000', 'HONDA', 'CR-V', '2024', component='WHEELS', rcdate='20240601'),
            ])
            flat2 = C.flat_campaigns(pre, post)
            self.assertEqual([(c, why) for c, _, why in C.due(state, flat2, today)], [('24V744000', 'changed'), ('24V500000', 'missing')])
            C.harvest(state, C.Harvester(state, 0, 5, 'run2', lambda m: None, opener=FakeApi(routes, fail={url('24V744000')})), C.due(state, flat2, today))
            self.assertEqual(state.execute("SELECT status, flat_hash = ? FROM campaigns WHERE campaign='24V744000'", (flat[('24V744000')][1],)).fetchone(), ('ok', 1))
            # Rolling re-checks pick the campaigns checked longest ago.
            self.assertEqual([why for _, _, why in C.due(state, flat2, today, rolling=2)], ['changed', 'rolling', 'rolling'])
            state.close()

            # Merge into the build (with the original flat files).
            zip_text(post, 'FLAT_RCL_POST_2010.txt', [
                rcl('10', '24V744000', 'HONDA', 'CR-V', '2024', component='STEERING', summary='Defect. More.'),
                rcl('11', '24V744000', 'HONDA', 'CR-V', '2024', component='ELECTRICAL SYSTEM', summary='Defect. More.'),
                rcl('12', '24V744000', 'HONDA', 'CR-V HYBRID', '2024', component='STEERING', summary='Defect. More.'),
                rcl('13', '24E001000', 'ACME', 'WIDGET', '2024', component='EQUIPMENT', rtype='E', rcdate='20240101'),
                rcl('14', '24V500000', 'HONDA', 'CR-V', '2024', component='WHEELS', rcdate='20240601'),
            ])
            st = C.open_state(d / 'campaigns.db')
            C.harvest(st, C.Harvester(st, 0, 5, 'run3', lambda m: None, opener=FakeApi(routes)), [('24V500000', flat['24V500000'][1], 'missing')])
            st.close()
            out = d / 'nhtsa-recalls.db'
            meta = recalls.build(pre, post, out, campaign_sheets=d / 'campaigns.db')
            s = meta['counts']['campaign_sheets']
            self.assertEqual((s['campaigns_with_sheet'], s['api_absent'], s['ota_known'], s['ota_true']), (3, 1, 2, 1))
            self.assertEqual((s['component_from_api'], s['component_api_not_in_flat'], s['vehicle_component_rows']), (2, 1, 2))
            self.assertEqual((s['date_from_api'], s['date_api_too_far'], s['texts_from_api'], s['flat_campaigns_without_sheet']), (1, 1, 1, 0))
            db = sqlite3.connect(out)
            self.assertEqual(db.execute("SELECT api_component, ota, api_report_received, summary FROM campaigns WHERE campaign='24V744000'").fetchone(),
                             ('ELECTRICAL SYSTEM', 1, '2024-10-04', 'Defect.\r\nMore.'))
            self.assertEqual(db.execute("SELECT api_component, ota, api_report_received, summary FROM campaigns WHERE campaign='24V500000'").fetchone(),
                             (None, 0, None, 'Defect.'))
            self.assertEqual(db.execute("SELECT model, component FROM api_components WHERE campaign='24V744000' ORDER BY model").fetchall(),
                             [('CR-V', 'ELECTRICAL SYSTEM'), ('CR-V HYBRID', 'STEERING')])
            self.assertEqual(db.execute("SELECT ota FROM campaigns WHERE campaign='24E001000'").fetchone(), (None,))
            db.close()


class ComplaintImportTest(unittest.TestCase):
    def test_grouping_components_of_all_products_and_no_personal_fields(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            z, out = d / 'FLAT_CMPL.zip', d / 'nhtsa-complaints.db'
            zip_text(z, 'FLAT_CMPL.txt', [
                cmpl(1, 11000001, 'HONDA', 'CR-V', '2024', 'SERVICE BRAKES:DISC'),
                cmpl(2, 11000001, 'HONDA', 'CR-V', '2024', 'ENGINE'),
                cmpl(3, 11000001, 'ACME', 'GAS CAN', '9999', 'EQUIPMENT', prod='E'),  # second product of the same complaint
                cmpl(4, 11000002, 'honda', 'cr-v', '2024', 'AIR BAGS', crash='Y', injured='2', faildate='', ldate='20240201'),
                # Before 2002-12-15 one number can hold several complaints (one per vehicle and text).
                cmpl(5, 560000, 'FORD', 'F-150', '1999', 'ENGINE', text='FIRST TRUCK.', ldate='19990101'),
                cmpl(6, 560000, 'FORD', 'F-150', '1999', 'STEERING', text='SECOND TRUCK.', ldate='19990101'),
            ])
            meta = complaints.build(z, out, 'Thu, 26 Nov 2026 10:13:32 GMT')
            self.assertEqual(meta['counts'], {'source_rows': 6, 'complaints': 5, 'complaint_numbers': 3, 'make_model_years': 3})
            self.assertEqual(meta['latest_received_date'], '2024-02-01')
            db = sqlite3.connect(out)
            cols = [r[1] for r in db.execute('PRAGMA table_info(complaints)')]
            for personal in ('city', 'state', 'vin', 'dealer', 'operator'):
                self.assertFalse(any(personal in c for c in cols), personal)
            raw = out.read_bytes()
            for secret in (b'SECRETVILLE', b'1HGCM82633A', b'JANE DOE'):
                self.assertNotIn(secret, raw)
            rows = db.execute("SELECT odi, crash, injured, incident, received, components FROM complaints WHERE make='HONDA' AND model='CR-V' ORDER BY odi").fetchall()
            self.assertEqual(rows, [(11000001, 0, 0, '20240105', '20240110', json.dumps(['SERVICE BRAKES:DISC', 'ENGINE', 'EQUIPMENT'])),
                                    (11000002, 1, 2, None, '20240201', json.dumps(['AIR BAGS']))])
            self.assertEqual(db.execute("SELECT COUNT(*) FROM complaints WHERE make='FORD' AND odi=560000").fetchone()[0], 2)
            db.close()
            self.assertEqual([p.name for p in d.glob('.nhtsa-complaints.db.*')], [])


class FakeApi:
    """Canned SafetyRatings answers; `fail` paths raise a timeout, `bad` paths answer HTTP 400."""
    def __init__(self, routes, fail=(), bad=()):
        self.routes, self.fail, self.bad, self.calls = routes, set(fail), set(bad), []

    def __call__(self, req, timeout=None):
        path = req.full_url.replace('https://api.nhtsa.gov', '')
        self.calls.append(path)
        if path in self.fail:
            raise TimeoutError('timed out')
        if path in self.bad:
            raise urllib.error.HTTPError(req.full_url, 400, 'Bad Request', {}, io.BytesIO(b'{}'))
        body = json.dumps(self.routes[path]).encode()

        class Res(io.BytesIO):
            status = 200
            def __enter__(self): return self
            def __exit__(self, *a): return False
        return Res(body)


def res(rows):
    return {'Count': len(rows), 'Message': 'Results returned successfully', 'Results': rows}


class RatingsCrawlTest(unittest.TestCase):
    def setUp(self):
        harvest.RETRY_WAITS = (0, 0, 0)
        harvest.FINAL_PASS_WAIT = 0
        H = harvest
        self.routes = {
            H.path_years(): res([{'ModelYear': 2024, 'VehicleId': 0}]),
            H.path_makes(2024): res([{'ModelYear': 2024, 'Make': 'HONDA', 'VehicleId': 0}]),
            H.path_models(2024, 'HONDA'): res([{'Model': 'CR-V'}, {'Model': 'PILOT'}, {'Model': 'TRUCK W/ CAB'}]),
            H.path_variants(2024, 'HONDA', 'CR-V'): res([{'VehicleDescription': '2024 Honda CR-V SUV AWD', 'VehicleId': 19599},
                                                         {'VehicleDescription': '2024 Honda CR-V SUV FWD', 'VehicleId': 19598}]),
            H.path_variants(2024, 'HONDA', 'PILOT'): res([{'VehicleDescription': '2024 Honda Pilot', 'VehicleId': 19000}]),
            H.path_detail(19599): res([{'OverallRating': '5', 'VehicleDescription': '2024 Honda CR-V SUV AWD', 'VehicleId': 19599}]),
            H.path_detail(19598): res([{'OverallRating': '4', 'VehicleDescription': '2024 Honda CR-V SUV FWD', 'VehicleId': 19598}]),
            H.path_detail(19000): res([{'OverallRating': '5', 'VehicleDescription': '2024 Honda Pilot', 'VehicleId': 19000}]),
        }

    def test_crawl_order_gaps_and_build(self):
        H = harvest
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            state = H.open_state(d / 'crawl.db')
            api = FakeApi(self.routes, fail={H.path_detail(19000)}, bad={H.path_variants(2024, 'HONDA', 'TRUCK W/ CAB')})
            crawler = H.Crawler(state, 0, 5, 'run1', lambda m: None, opener=api)
            result = H.crawl(state, crawler, 'all', 'none', lambda m: None)
            self.assertTrue(result['complete'])
            # Path segments are encoded like encodeURIComponent, as lib/nhtsa.mjs sends them.
            self.assertEqual(H.path_variants(2024, 'HONDA', 'TRUCK W/ CAB'), '/SafetyRatings/modelyear/2024/make/HONDA/model/TRUCK%20W%2F%20CAB?format=json')
            self.assertIn(H.path_variants(2024, 'HONDA', 'TRUCK W/ CAB'), api.calls)
            never = H.final_pass(state, crawler, lambda m: None)
            self.assertEqual(sorted(never), sorted([H.path_detail(19000), H.path_variants(2024, 'HONDA', 'TRUCK W/ CAB')]))
            state.execute("INSERT INTO runs(run, started_at, finished_at) VALUES('run1', '2026-11-27T00:00:00Z', '2026-11-27T01:00:00Z')")
            state.commit()
            # Resume: clean answers are not fetched again.
            api.calls.clear()
            H.crawl(state, H.Crawler(state, 0, 5, 'run2', lambda m: None, opener=api), 'all', 'none', lambda m: None)
            self.assertEqual(set(api.calls), set(never))
            out = d / 'nhtsa-ratings.db'
            meta = ratings.build(d / 'crawl.db', out)
            self.assertEqual(meta['counts']['rated_variants'], 2)
            self.assertEqual(meta['counts']['gaps'], 2)
            db = sqlite3.connect(out)
            self.assertEqual(db.execute("SELECT vehicle_id FROM variants WHERE model_key='CR-V' ORDER BY ord").fetchall(), [(19599,), (19598,)])
            self.assertEqual(db.execute("SELECT variants_ok FROM models WHERE model_key='TRUCK W/ CAB'").fetchone()[0], 0)
            self.assertIsNone(db.execute('SELECT body FROM ratings WHERE vehicle_id=19000').fetchone())
            db.close()

    def test_refresh_keeps_last_clean_answer_when_a_refetch_fails(self):
        H = harvest
        with tempfile.TemporaryDirectory() as d:
            state = H.open_state(pathlib.Path(d) / 'crawl.db')
            H.crawl(state, H.Crawler(state, 0, 5, 'a', lambda m: None, opener=FakeApi(self.routes)), 'all', 'none', lambda m: None)
            api = FakeApi(self.routes, fail={H.path_detail(19599)})
            H.crawl(state, H.Crawler(state, 0, 5, 'b', lambda m: None, opener=api), 'all', 'all', lambda m: None)
            self.assertIn(H.path_detail(19599), api.calls)
            row = state.execute('SELECT status, body IS NOT NULL, error FROM responses WHERE path=?', (H.path_detail(19599),)).fetchone()
            self.assertEqual(row[:2], ('ok', 1))
            self.assertIn('timed out', row[2])

    def test_year_scope(self):
        import datetime
        years = [2027, 2026, 2025, 2024, 2023, 1990]
        today = datetime.date(2026, 11, 27)
        self.assertEqual(harvest.year_scope('recent', years, today), {2027, 2026, 2025, 2024})
        self.assertEqual(harvest.year_scope('current', years, today), {2027, 2026})
        self.assertEqual(harvest.year_scope('2023-2024', years, today), {2023, 2024})
        self.assertEqual(harvest.year_scope('none', years, today), set())


if __name__ == '__main__':
    unittest.main()

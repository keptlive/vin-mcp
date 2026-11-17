import importlib.util, json, pathlib, sqlite3, tempfile, unittest

spec = importlib.util.spec_from_file_location('importer', pathlib.Path(__file__).resolve().parents[1]/'scripts/import-aala.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)

# Cell rows as pdf_pages() returns them: (y, [(x0, x1, text)]) top to bottom.
NEW_HEADER = [(730, [(50, 80, 'Manufacturers'), (100, 115, 'Makes'), (135, 155, 'Carlines'), (165, 200, 'Vehicle Type on Part'), (213, 229, 'Percent US/ Canada'),
                     (240, 315, 'Major Sources of Foreign Parts Content'), (322, 348, 'Final Assembly Countries'), (356, 389, 'Additional Final Assembly'),
                     (394, 428, 'Country of Origin for the Engine/Motor'), (434, 466, 'Additional country of Engine/Motor'),
                     (472, 504, 'Country of Origin for the Transmission(s)'), (510, 542, 'Additional Country of Transmission(s)')]),
              (768, [(285, 327, 'MY2026 AALA Alphabetical')])]
NEW_PAGE = sorted(NEW_HEADER + [
    (700, [(55, 62, 'Audi'), (102, 109, 'Audi'), (140, 146, 'A5'), (178, 184, 'PC'), (218, 224, '1%'), (250, 262, '41% G'), (288, 300, '21% H'), (333, 336, 'G'), (409, 412, 'H'), (485, 488, 'G')]),
    # carline printed on two lines, above and below the row's baseline
    (692, [(130, 160, 'Q5 Sportback')]),
    (690, [(55, 62, 'Audi'), (102, 109, 'Audi'), (178, 190, 'MPV'), (218, 224, '2%'), (250, 262, '78% M'), (333, 336, 'M'), (409, 412, 'M'), (485, 488, 'G')]),
    (688, [(135, 155, 'S line 45')]),
    # "Truck" in mixed case; a second engine country in the additional column
    (670, [(55, 70, 'Ford'), (102, 109, 'Ford'), (140, 150, 'F150'), (176, 190, 'Truck'), (218, 226, '32%'), (250, 262, '15% M'), (333, 338, 'US'), (400, 420, 'US (2.7L)'), (440, 460, 'M (3.5L)'), (485, 490, 'US')]),
    # two rows ran together: two US/Canada percentages -> rejected
    (650, [(55, 62, 'Kia'), (102, 109, 'Kia'), (140, 150, 'Soul'), (178, 184, 'PC'), (218, 224, '5%'), (250, 262, '90% K'), (333, 336, 'K'), (409, 412, 'K'), (485, 488, 'K')]),
    (647, [(218, 224, '7%')]),
    # percentages above 100 -> rejected
    (630, [(55, 62, 'Kia'), (102, 109, 'Kia'), (140, 150, 'Rio'), (178, 184, 'PC'), (218, 224, '20%'), (250, 262, '90% K'), (333, 336, 'K'), (409, 412, 'K'), (485, 488, 'K')]),
    # legend, names centred
    (500, [(278, 283, 'AU'), (305, 318, 'Australia')]),
    (490, [(278, 283, 'G'), (304, 319, 'Germany')]),
    (480, [(278, 283, 'H'), (304.5, 318.5, 'Hungary')]),
    (470, [(278, 283, 'M'), (305.5, 317.5, 'Mexico')]),
    (460, [(278, 283, 'US'), (301.4, 321.6, 'United States')]),
], key=lambda r: -r[0])

OLD_HEADER = [(735, [(214, 240, 'Vehicle Type'), (245, 262, 'Percent')]),
              (726, [(63, 100, 'Manufacturers'), (214, 240, 'Certification'), (249, 260, 'US/ Canada'), (263, 330, 'Percent Content Other'), (364, 410, 'Final Assembly'),
                     (427, 470, "Sources of Vehicle's Engine/Motor"), (480, 530, "Sources of Vehicle's Transmission(s)")]),
              (720, [(113, 130, 'Makes'), (167, 190, 'Carlines'), (214, 230, 'Label'), (263, 300, 'Countries'), (364, 395, 'Countries')])]
OLD_PAGE = sorted(OLD_HEADER + [
    (700, [(68, 90, 'BMW AG'), (115, 130, 'BMW'), (161, 200, '3 Series Sedan'), (215, 222, 'PC'), (249, 258, '10%'), (278, 300, '35% G'), (327, 350, '25% MX'), (381, 386, 'M'), (434, 455, 'G (3.3)'), (495, 500, 'G')]),
    # a cell printed between Final Assembly and Engine: either column could own it -> both unreadable
    (690, [(68, 90, 'BMW AG'), (115, 130, 'BMW'), (161, 200, '5 Series Sedan'), (215, 222, 'PC'), (249, 256, '5%'), (278, 300, '55% G'), (381, 386, 'G'), (413, 419, 'A'), (439, 444, 'G'), (495, 500, 'G')]),
    # final assembly on the baseline plus a line from the neighbour row -> final unreadable, not joined
    (682, [(380, 410, 'Brampton ON')]),
    (680, [(68, 90, 'FCA'), (115, 130, 'Chrysler'), (161, 190, 'Voyager'), (215, 225, 'MPV'), (249, 258, '62%'), (278, 300, '20% M'), (364, 410, 'Windsor ON Canada'), (439, 444, 'US'), (495, 500, 'US')]),
    # make printed once for the group: filled down and flagged
    (670, [(161, 190, 'Pacifica'), (215, 225, 'MPV'), (249, 258, '64%'), (278, 300, '19% M'), (381, 386, 'US'), (439, 444, 'US'), (495, 500, 'US')]),
    # legend, names left-aligned; "Czech Republic" printed on two lines
    (300, [(379, 385, 'AU'), (403, 430, 'Australia')]),
    (292, [(403, 425, 'Czech')]),
    (286, [(379, 385, 'CZ'), (403, 430, 'Republic')]),
    (278, [(379, 385, 'G'), (403, 430, 'Germany')]),
], key=lambda r: -r[0])


class AalaParseTest(unittest.TestCase):
    def test_new_layout_rows_wraps_rejects_and_centred_legend(self):
        rows, rejects, legend = importer.parse_pages([NEW_PAGE], 2026)
        self.assertEqual(legend, {'AU': 'Australia', 'G': 'Germany', 'H': 'Hungary', 'M': 'Mexico', 'US': 'United States'})
        by = {r['carline']: r for r in rows}
        self.assertEqual(sorted(by), ['A5', 'F150', 'Q5 Sportback S line 45'])
        a5 = by['A5']
        self.assertEqual((a5['manufacturer'], a5['make'], a5['vehicle_type'], a5['us_canada_pct'], a5['final'], a5['engine'], a5['trans']), ('Audi', 'Audi', 'PC', 1, 'G', 'H', 'G'))
        self.assertEqual(a5['foreign'], [{'pct': 41, 'code': 'G'}, {'pct': 21, 'code': 'H'}])
        self.assertEqual(by['Q5 Sportback S line 45']['flags'], ['joined_carline'])
        f150 = by['F150']
        self.assertEqual((f150['vehicle_type'], f150['engine'], f150['engine_add'], f150['trans']), ('TRUCK', 'US (2.7L)', 'M (3.5L)', 'US'))
        self.assertEqual(sorted(x['reason'] for x in rejects), ['percent_over_100', 'unplaced_cells'])
        self.assertEqual(next(x for x in rejects if x['reason'] == 'unplaced_cells')['unplaced'], ['7%'])

    def test_old_layout_gap_cells_neighbour_lines_fill_down_and_wrapped_legend(self):
        rows, rejects, legend = importer.parse_pages([OLD_PAGE], 2021)
        self.assertEqual(rejects, [])
        self.assertEqual(legend, {'AU': 'Australia', 'CZ': 'Czech Republic', 'G': 'Germany'})
        by = {r['carline']: r for r in rows}
        s3 = by['3 Series Sedan']
        self.assertEqual((s3['us_canada_pct'], s3['foreign'], s3['final'], s3['engine'], s3['trans'], s3['flags']), (10, [{'pct': 35, 'code': 'G'}, {'pct': 25, 'code': 'MX'}], 'M', 'G (3.3)', 'G', []))
        s5 = by['5 Series Sedan']
        self.assertEqual((s5['us_canada_pct'], 'final' in s5, 'engine' in s5, s5['trans'], s5['flags']), (5, False, False, 'G', ['unreadable_final', 'unreadable_engine']))
        voyager = by['Voyager']
        self.assertEqual(('final' in voyager, voyager['engine'], voyager['flags']), (False, 'US', ['unreadable_final']))
        pacifica = by['Pacifica']
        self.assertEqual((pacifica['make'], pacifica['manufacturer'], pacifica['flags']), ('Chrysler', 'FCA', ['filled_down_manufacturer', 'filled_down_make']))

    def test_build_is_atomic_and_counts_rejects(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); target = root/'aala.db'
            pages = {'new.pdf': [NEW_PAGE], 'old.pdf': [OLD_PAGE], 'empty.pdf': [[(700, [(10, 20, 'nothing')])]]}
            for name in pages: (root/name).write_bytes(b'%PDF-1.4 ' + name.encode())
            original = importer.pdf_pages
            importer.pdf_pages = lambda path: pages[pathlib.Path(path).name]
            try:
                receipt = importer.build([(2026, 'new.pdf', root/'new.pdf', 'https://example.gov/new.pdf'), (2021, 'old.pdf', root/'old.pdf', 'https://example.gov/old.pdf')], target)
                by = {s['model_year']: s for s in receipt['sources']}
                self.assertEqual((by[2026]['rows'], by[2026]['rejected'], by[2026]['reject_rate'], by[2026]['legend_codes']), (3, {'unplaced_cells': 1, 'percent_over_100': 1}, 0.4, 5))
                self.assertEqual((by[2021]['rows'], by[2021]['flagged']), (4, 3))
                with sqlite3.connect(target) as db:
                    row = db.execute("SELECT make, carline, us_canada_pct, foreign_sources, final_assembly, engine, engine_additional, make_compact, carline_compact FROM aala WHERE carline='F150'").fetchone()
                    self.assertEqual(row, ('Ford', 'F150', 32, '[{"pct": 15, "code": "M"}]', 'US', 'US (2.7L)', 'M (3.5L)', 'FORD', 'F150'))
                    self.assertEqual(db.execute("SELECT final_assembly, flags FROM aala WHERE carline='5 Series Sedan'").fetchone(), (None, '["unreadable_final", "unreadable_engine"]'))
                    self.assertEqual(db.execute('SELECT count(*) FROM rejects').fetchone()[0], 2)
                    self.assertEqual(db.execute("SELECT country FROM legends WHERE model_year=2021 AND code='CZ'").fetchone()[0], 'Czech Republic')
                before = target.read_bytes()
                with self.assertRaises(ValueError):
                    importer.build([(2025, 'empty.pdf', root/'empty.pdf', 'u')], target)
                self.assertEqual(target.read_bytes(), before)
                self.assertEqual(list(root.glob('aala-build-*')), [])
            finally:
                importer.pdf_pages = original


if __name__ == '__main__':
    unittest.main()

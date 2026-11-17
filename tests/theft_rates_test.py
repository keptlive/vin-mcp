import importlib.util, json, pathlib, sqlite3, tempfile, unittest

spec = importlib.util.spec_from_file_location('importer', pathlib.Path(__file__).resolve().parents[1]/'scripts/import-theft-rates.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


def notice(title, rows):
    body = ''.join('<ROW>' + ''.join(f'<ENT>{c}</ENT>' for c in row) + '</ROW>' for row in rows)
    return f'<RULE><PREAMB><P>Final theft data.</P></PREAMB><GPOTABLE COLS="6"><TTITLE>{title}</TTITLE><BOXHD><CHED>Manufacturer</CHED></BOXHD>{body}</GPOTABLE></RULE>'.encode()


class TheftRatesImportTest(unittest.TestCase):
    def test_layouts_corrections_flags_and_totals(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); target = root/'theft-rates.db'
            files = {
                # five-column layout: "rank. manufacturer" in one cell
                'a.xml': notice('Final Report of Theft Rates for Model Year 2004 Passenger Motor Vehicles Stolen in Calendar Year 2004', [
                    ['1. DAIMLERCHRYSLER', 'DODGE INTREPID', '662', '67,289', '9.8382'],
                    ['2. SUBARU', 'IMPREZA', '177', '8,806', '4.5612'],      # printed rate does not equal 177 / 8,806 x 1,000
                    ['3. HONDA', 'ACCORD', 'n/a', '400,000', '1.0'],          # not a number
                    ['A heading row'],
                ]),
                # six-column layout with the all-lines total; an older notice for the same model year
                'b.xml': notice('Theft Rates of Model Year 2012 Passenger Motor Vehicles Stolen in Calendar Year 2012', [
                    ['1', 'VOLKSWAGEN', 'PASSAT', '1', '1,000', '1.0000']]),
                'c.xml': notice('Final Report of Theft Rates for Model Year 2012 Passenger Motor Vehicles Stolen in Calendar Year 2012', [
                    ['57', 'VOLKSWAGEN', 'PASSAT', '107', '95,583', '1.1194'],
                    ['Theft rate per 1,000 vehicles produced = Total theft ÷ Total production × 1000', '12,172', '10,777,418', '1.1294']]),
                'd.xml': b'<RULE><P>Publication of 2011 final theft data.</P></RULE>',  # no table
            }
            for name, payload in files.items(): (root/name).write_bytes(payload)
            notices = [{'document_number': 'A', 'publication_date': '2006-10-10', 'path': root/'a.xml', 'url': 'https://www.federalregister.gov/d/A'},
                       {'document_number': 'B', 'publication_date': '2014-01-01', 'path': root/'b.xml', 'url': 'https://www.federalregister.gov/d/B'},
                       {'document_number': 'C', 'publication_date': '2014-11-25', 'path': root/'c.xml', 'url': 'https://www.federalregister.gov/d/C'},
                       {'document_number': 'D', 'publication_date': '2014-02-06', 'path': root/'d.xml', 'url': 'https://www.federalregister.gov/d/D'}]
            receipt = importer.build(notices, target)
            self.assertEqual(receipt['model_years'], [2004, 2012])
            self.assertEqual(receipt['rows'], 3)
            self.assertEqual(receipt['rows_rejected'], {'not_a_number': 1, 'layout': 1})
            self.assertEqual(receipt['rows_rate_flagged'], 1)
            self.assertEqual(receipt['printed_totals'], {'2012': {'thefts': 12172, 'production': 10777418, 'rate': 1.1294}})
            with sqlite3.connect(target) as db:
                rows = db.execute('SELECT model_year, rank, manufacturer, line, line_compact, thefts, production, rate, rate_check, lines_in_table, document_number FROM theft_rates ORDER BY model_year, rank').fetchall()
            self.assertEqual(rows, [
                (2004, 1, 'DAIMLERCHRYSLER', 'DODGE INTREPID', 'DODGEINTREPID', 662, 67289, 9.8382, 'ok', 2, 'A'),
                (2004, 2, 'SUBARU', 'IMPREZA', 'IMPREZA', 177, 8806, 4.5612, 'printed_rate_differs', 2, 'A'),
                (2012, 57, 'VOLKSWAGEN', 'PASSAT', 'PASSAT', 107, 95583, 1.1194, 'ok', 1, 'C'),  # the newer notice wins
            ])
            before = target.read_bytes()
            with self.assertRaises(ValueError):
                importer.build([notices[3]], target)  # no table anywhere: the old index stays
            self.assertEqual(target.read_bytes(), before)
            self.assertEqual(list(root.glob('theft-rates-build-*')), [])


if __name__ == '__main__':
    unittest.main()

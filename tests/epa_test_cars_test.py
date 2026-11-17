import importlib.util, io, json, pathlib, sqlite3, tempfile, unittest, zipfile

spec = importlib.util.spec_from_file_location('importer', pathlib.Path(__file__).resolve().parents[1]/'scripts/import-epa-test-cars.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)

SHORT = '"yr","mfr name","carline","cid","rhp","trns","drv","etw","axle","n/v","eng family"\n1998,"HONDA","ACCORD",183,200,"L4","F",3500,4.43,30.1,"WHNXV03.0FBP"\n'
CODED = ('MDLYR_DT,VI_MFR_NM,CL_NM,GBE_CID_MSR,VC_RTD_HP_MSR,TRNS,DRV_SYS_CD,VC_DSN_ETW_MSR,VC_AXLE_RAT_MSR,VC_NV_RAT_MSR,EF_ID,VC_CYL_CNT\n'
         '2003,HONDA,ACCORD,183,240,L5,F,3625,4.43,34.6,3HNXV03.0FBP,6\n'
         '2003,HONDA,ACCORD,183,240,L5,F,3625,4.43,34.6,3HNXV03.0FBP,6\n'   # second test of the same car
         '2003,HONDA,ACCORD,183,240,M6,F,3625,3.29,30.0,3HNXV03.0FBP,6\n'
         '2002,HONDA,ACCORD,183,240,M6,F,3625,3.29,30.0,3HNXV03.0FBP,6\n')  # wrong model year for this file
NAMED = ('Model Year,Vehicle Manufacturer Name,Represented Test Veh Make,Represented Test Veh Model,Test Veh Displacement (L),Actual Tested Testgroup,'
         'Rated Horsepower,# of Cylinders and Rotors,Tested Transmission Type Code,Tested Transmission Type,# of Gears,Drive System Code,Drive System Description,'
         'Equivalent Test Weight (lbs.),Axle Ratio,N/V Ratio\n'
         '2015,Ford Motor Company,Ford,F150 4X4 Super Crew,2.7,FFMXT02.73DH,325,6,SA,Semi-Automatic,6,P,Part-time 4-Wheel Drive,5250,3.55,30.2\n'
         '2015,General Motors,Chevrolet,SPARK EV,0.001,FGMXV00.0L13,140,,A,Automatic,1,F,"2-Wheel Drive, Front",3125,3.87,999\n')


def xlsx(rows):
    """A minimal .xlsx with shared strings for text and plain numbers."""
    strings, sheet = [], []
    for i, row in enumerate(rows, 1):
        cells = []
        for j, v in enumerate(row):
            ref = chr(65 + j) + str(i)
            if isinstance(v, str):
                strings.append(v)
                cells.append(f'<c r="{ref}" t="s"><v>{len(strings) - 1}</v></c>')
            else:
                cells.append(f'<c r="{ref}"><v>{v}</v></c>')
        sheet.append(f'<row r="{i}">{"".join(cells)}</row>')
    m = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr('xl/workbook.xml', f'<workbook xmlns="{m}" xmlns:r="{r}"><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr('xl/sharedStrings.xml', f'<sst xmlns="{m}">' + ''.join(f'<si><t>{s}</t></si>' for s in strings) + '</sst>')
        z.writestr('xl/worksheets/sheet1.xml', f'<worksheet xmlns="{m}"><sheetData>{"".join(sheet)}</sheetData></worksheet>')
    return buf.getvalue()


class EpaTestCarImportTest(unittest.TestCase):
    def test_three_layouts_normalise_dedupe_and_keep_unknowns_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); target = root/'epa-test-cars.db'
            z98 = root/'98tstcar.zip'
            with zipfile.ZipFile(z98, 'w') as z: z.writestr('98tstcar.csv', SHORT)
            (root/'03tstcar.csv').write_text(CODED); (root/'15tstcar.csv').write_text(NAMED)
            header = ['Model Year', 'Represented Test Veh Make', 'Represented Test Veh Model', 'Test Veh Displacement (L)', 'Actual Tested Testgroup',
                      'Rated Horsepower', 'Tested Transmission Type', '# of Gears', 'Drive System Description', 'Equivalent Test Weight (lbs.)', 'Axle Ratio']
            (root/'24-testcar.xlsx').write_bytes(xlsx([['EPA test car list'], header,
                [2024, 'Honda', 'CR-V AWD', 1.993, 'RHNXT02.0PWC', 145, 'Continuously Variable', 1, '2-Wheel Drive, Front', 4250, 4.44]]))
            files = [(1998, '98tstcar.zip', z98, 'u98'), (2003, '03tstcar.csv', root/'03tstcar.csv', 'u03'),
                     (2015, '15tstcar.csv', root/'15tstcar.csv', 'u15'), (2024, '24-testcar.xlsx', root/'24-testcar.xlsx', 'u24')]
            receipt = importer.build(files, target)
            self.assertEqual(receipt['source_rows'], 1 + 4 + 2 + 1)
            self.assertEqual(receipt['configurations'], 6)
            by = {s['model_year']: s for s in receipt['sources']}
            self.assertEqual(by[2003]['rows_rejected'], {'model_year_differs_from_file': 1})
            self.assertEqual(by[2015]['values_outside_plausible_range'], {'displacement_l': 1, 'nv_ratio': 1})
            with sqlite3.connect(target) as db:
                db.row_factory = sqlite3.Row
                acc = db.execute("SELECT * FROM test_cars WHERE model_year=2003 AND trans_code='L5'").fetchone()
                self.assertEqual((acc['displacement_l'], acc['trans_type'], acc['gears'], acc['drive'], acc['tests'], acc['make']), (3.0, 'Automatic', 5, '2-Wheel Drive, Front', 2, None))
                self.assertEqual(acc['manufacturer_compact'], 'HONDA')
                spark = db.execute("SELECT * FROM test_cars WHERE carline='SPARK EV'").fetchone()
                self.assertIsNone(spark['displacement_l']); self.assertIsNone(spark['nv_ratio']); self.assertEqual(spark['rated_hp'], 140)
                crv = db.execute('SELECT * FROM test_cars WHERE model_year=2024').fetchone()
                self.assertEqual((crv['make_compact'], crv['carline_compact'], crv['test_group'], crv['axle_ratio']), ('HONDA', 'CRVAWD', 'RHNXT02.0PWC', 4.44))
                self.assertEqual(db.execute('SELECT test_group FROM test_cars WHERE model_year=1998').fetchone()[0], 'WHNXV03.0FBP')
            before = target.read_bytes()
            (root/'bad.csv').write_text('no,header,here\n1,2,3\n')
            with self.assertRaises(ValueError):
                importer.build(files + [(2016, 'bad.csv', root/'bad.csv', 'u16')], target)
            self.assertEqual(target.read_bytes(), before)
            self.assertEqual(list(root.glob('epa-test-cars-build-*')), [])

    def test_compact_matches_runtime_rule(self):
        self.assertEqual(importer.compact('CR-V AWD'), 'CRVAWD')
        self.assertEqual(importer.compact(None), '')


if __name__ == '__main__':
    unittest.main()

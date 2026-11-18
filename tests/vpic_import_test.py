"""The rule-fix step of scripts/import-vpic.py on the small fixture (tests/fixtures/vpic-mini.json): applying the
reviewed changeset, refusing an entry whose NHTSA row changed (reported, exit 4), and undoing the fixes exactly."""
import importlib.util, json, pathlib, sqlite3, subprocess, sys, tempfile, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('importer', ROOT / 'scripts/import-vpic.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)
FIXTURE = json.loads((ROOT / 'tests/fixtures/vpic-mini.json').read_text())
CHANGESET = [json.loads(l) for l in (ROOT / 'data-src/vpic-rule-fixes.jsonl').read_text().splitlines() if l.strip()]
BY_ID = {e['id']: e for e in CHANGESET}


def build(path):
    db = sqlite3.connect(path)
    for sql in FIXTURE['schema']:
        db.execute(sql)
    for t, tab in FIXTURE['tables'].items():
        db.executemany(f"INSERT INTO {t} ({','.join(tab['columns'])}) VALUES ({','.join('?' * len(tab['columns']))})", tab['rows'])
    db.commit()
    return db


def rows(db):
    return {'pattern': db.execute('SELECT * FROM pattern ORDER BY id').fetchall(), 'spec': db.execute('SELECT * FROM spec_pattern ORDER BY id').fetchall()}


class RuleFixTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name)
        self.db = build(self.dir / 'vpic.db')

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def write(self, entries, name='fixes.jsonl'):
        p = self.dir / name
        p.write_text(''.join(json.dumps(e) + '\n' for e in entries))
        return p

    def test_revert_then_apply_gives_the_same_tables(self):
        fixed = rows(self.db)
        importer.revert_rule_fixes(self.db)
        pristine = rows(self.db)
        self.assertFalse(any(r[0] < 0 for r in pristine['pattern']), 'added rows are gone on NHTSA\'s rules')
        # the Atlas premise row and the GR Corolla spec row are NHTSA's own and untouched either way
        self.assertIn((14854,), [(r[0],) for r in pristine['spec']])
        out = importer.apply_rule_fixes(self.db, self.write([BY_ID['rf-008'], BY_ID['rf-023']]), '2026_11')
        self.assertEqual(out['summary']['applied'], 2)
        self.assertEqual(out['summary']['needs_review'], 0)
        self.assertEqual(rows(self.db), fixed)
        new = self.db.execute('SELECT schema_id, keys, attribute_id FROM pattern WHERE id = -103').fetchone()
        self.assertEqual(new, (15825, 'B**CA', '1'))
        rec = self.db.execute("SELECT action, tbl, row_id FROM rule_fix WHERE fix_id = 'rf-008'").fetchall()
        self.assertEqual(rec, [('add', 'pattern', -103)])

    def test_an_entry_whose_nhtsa_row_changed_is_not_applied_and_is_reported(self):
        importer.revert_rule_fixes(self.db)
        # NHTSA changes the vehicle-spec row the Atlas fix relies on (Launch Model AWD -> 4WD)
        self.db.execute("UPDATE spec_pattern SET attribute_id = '2' WHERE id = 14854")
        before = rows(self.db)
        out = importer.apply_rule_fixes(self.db, self.write([BY_ID['rf-008'], BY_ID['rf-023']]), '2026_11')
        self.assertEqual(out['summary']['applied'], 1)
        self.assertEqual(out['summary']['needs_review'], 1)
        stale = [e for e in out['entries'] if e['status'] == 'needs_review']
        self.assertEqual(stale[0]['id'], 'rf-008')
        self.assertIn('spec_pattern row 14854 changed', stale[0]['problems'][0])
        self.assertIsNone(self.db.execute('SELECT 1 FROM pattern WHERE id = -103').fetchone(), 'nothing of a stale entry is applied')
        self.assertNotEqual(rows(self.db)['pattern'], before['pattern'])  # rf-023 did apply
        st = self.db.execute("SELECT status, problem FROM rule_fix_entry WHERE fix_id = 'rf-008'").fetchone()
        self.assertEqual(st[0], 'needs_review')
        # a modified row whose value NHTSA already corrected is reported too
        e = json.loads(json.dumps(BY_ID['rf-023']))
        e['id'] = 'rf-900'
        e['edits'][0]['new']['id'] = -900
        e['premise'][0]['row']['attribute_id'] = '3'
        out = importer.apply_rule_fixes(self.db, self.write([e], 'b.jsonl'), '2026_11')
        self.assertEqual(out['summary']['needs_review'], 1)

    def test_cli_exit_4_and_report_for_review(self):
        self.db.close()
        stale = json.loads(json.dumps(BY_ID['rf-023']))
        stale['premise'][0]['row']['attribute_id'] = '3'  # written against another value than the release has
        p = self.write([BY_ID['rf-008'], stale])
        r = subprocess.run([sys.executable, str(ROOT / 'scripts/import-vpic.py'), '--reapply-rule-fixes', str(self.dir / 'vpic.db'), '--rule-fixes', str(p)],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 4, r.stderr)
        self.assertIn('RULE FIX NEEDS REVIEW rf-023', r.stderr)
        db = sqlite3.connect(self.dir / 'vpic.db')
        self.assertEqual(db.execute("SELECT fix_id, status FROM rule_fix_entry ORDER BY fix_id").fetchall(), [('rf-008', 'applied'), ('rf-023', 'needs_review')])
        self.assertEqual(json.loads(db.execute("SELECT value FROM meta WHERE key = 'rule_fixes'").fetchone()[0])['needs_review'], 1)
        db.close()
        self.db = sqlite3.connect(self.dir / 'vpic.db')

    def test_malformed_changeset_is_refused(self):
        bad = dict(BY_ID['rf-008'])
        del bad['reason']
        with self.assertRaises(SystemExit):
            importer.apply_rule_fixes(self.db, self.write([bad]), '2026_11')
        dup = [BY_ID['rf-008'], BY_ID['rf-008']]
        importer.revert_rule_fixes(self.db)
        with self.assertRaises(SystemExit):
            importer.apply_rule_fixes(self.db, self.write(dup, 'dup.jsonl'), '2026_11')

    def test_every_entry_is_complete_and_names_its_rows(self):
        for e in CHANGESET:
            for k in ('id', 'release', 'case', 'errors', 'edits', 'reason', 'evidence', 'reviewed', 'checks'):
                self.assertTrue(e.get(k), f"{e.get('id')}: {k}")
            for ed in e['edits']:
                src = ed.get('row') or ed.get('new')
                self.assertIn(ed['action'], ('modify', 'delete', 'add'))
                self.assertTrue(src.get('element') and str(src.get('attribute_id')), e['id'])
                if ed['action'] == 'add':
                    self.assertLess(src['id'], 0)
            for v in e['evidence']:
                self.assertRegex(v['url'], r'^https://(nrd-static\.nhtsa\.dot\.gov|static\.nhtsa\.gov)/')


if __name__ == '__main__':
    unittest.main()

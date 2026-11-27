"""The NHTSA data refresh chain on toy data: gate, publish (build server), pull + swap + rollback (web server), check."""
import datetime, hashlib, importlib.util, json, os, pathlib, sqlite3, subprocess, sys, tempfile, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import nhtsa_datasets as nd  # noqa: E402

spec = importlib.util.spec_from_file_location('nhtsa_install', ROOT / 'scripts' / 'nhtsa-install.py')
inst = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inst)

TOY = {'file': 'toy.db', 'mode': 'odi', 'confirm_hours': 24, 'source_days': 1, 'source': 'TOY.zip (test)', 'sources': ['TOY.zip'],
       'tables': {'items': ['id', 'name'], 'metadata': ['key', 'value']},
       'counts': {'items': 'SELECT count(*) FROM items'}, 'floor': {'items': 10}}
T0 = datetime.datetime(2026, 11, 27, 12, 0, tzinfo=datetime.timezone.utc)


def make_db(path, n, tag='a', drop_name=False, lm='Fri, 27 Nov 2026 10:08:54 GMT'):
    path = pathlib.Path(path)
    path.unlink(missing_ok=True)
    db = sqlite3.connect(path)
    db.execute('CREATE TABLE items(id INTEGER' + ('' if drop_name else ', name TEXT') + ')')
    db.execute('CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT)')
    db.executemany('INSERT INTO items VALUES(?' + ('' if drop_name else ', ?') + ')',
                   [(i,) if drop_name else (i, f'{tag}{i}') for i in range(n)])
    db.execute("INSERT INTO metadata VALUES('source', ?)", (json.dumps({'source_last_modified': lm, 'built_at': '2026-11-27T11:00:00+00:00'}),))
    db.commit()
    db.close()
    return path


def sha(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name)
        self.saved = dict(nd.DATASETS), list(nd.ORDER), {k: getattr(inst, k) for k in ('SRC', 'DATA', 'STATE', 'NOTIFY', 'KNOWN', 'MIN_FREE')}
        nd.DATASETS['toy'] = dict(TOY)
        nd.ORDER[:] = ['toy']
        self.pub, self.build, self.dl = self.dir / 'publish', self.dir / 'build', self.dir / 'dl'
        self.data, self.state = self.dir / 'data', self.dir / 'state'
        for d in (self.build, self.dl, self.data):
            d.mkdir()
        inst.SRC, inst.DATA, inst.STATE, inst.NOTIFY, inst.KNOWN, inst.MIN_FREE = str(self.pub) + '/', self.data, self.state, 'off', False, 0

    def tearDown(self):
        datasets, order, attrs = self.saved
        nd.DATASETS.clear(); nd.DATASETS.update(datasets)
        nd.ORDER[:] = order
        for k, v in attrs.items():
            setattr(inst, k, v)
        self.tmp.cleanup()

    def publish(self, n, tag, **kw):
        f = make_db(self.build / 'toy.db', n, tag)
        return nd.publish('toy', f, self.pub, dl=self.dl, known=False, **kw)


class GateTest(Base):
    def test_gate(self):
        good = make_db(self.dir / 'good.db', 20)
        self.assertTrue(nd.gate('toy', good, known=False)['ok'])
        r = nd.gate('toy', make_db(self.dir / 'nocol.db', 20, drop_name=True), known=False)
        self.assertFalse(r['ok']); self.assertIn('items lacks columns', r['failures'][0])
        r = nd.gate('toy', make_db(self.dir / 'small.db', 5), known=False)
        self.assertFalse(r['ok']); self.assertIn('below the floor', r['failures'][0])
        live = make_db(self.dir / 'live.db', 100)
        r = nd.gate('toy', make_db(self.dir / 'drop.db', 90), live=live, known=False)
        self.assertFalse(r['ok']); self.assertIn('fell from 100 to 90', r['failures'][0])
        self.assertTrue(nd.gate('toy', make_db(self.dir / 'ok.db', 98), live=live, known=False)['ok'])
        junk = self.dir / 'junk.db'
        junk.write_bytes(b'not a database at all' * 100)
        self.assertFalse(nd.gate('toy', junk, known=False)['ok'])
        r = nd.gate('toy', self.dir / 'absent.db', known=False)
        self.assertFalse(r['ok'])

    def test_known_answers_step(self):
        repo = self.dir / 'repo'
        (repo / 'scripts').mkdir(parents=True)
        script = repo / 'scripts' / 'nhtsa-known-answers.mjs'
        good = make_db(self.dir / 'good.db', 20)
        script.write_text('console.log(JSON.stringify({ok: true, checks: [{name: "x", ok: true}]}));\n')
        self.assertTrue(nd.gate('toy', good, repo=repo)['ok'])
        script.write_text('console.log(JSON.stringify({ok: false, checks: [{name: "2003 Accord", ok: false}]})); process.exit(1);\n')
        r = nd.gate('toy', good, repo=repo)
        self.assertFalse(r['ok']); self.assertIn('2003 Accord', r['failures'][0])
        script.write_text('throw new Error("cannot load lib")\n')
        self.assertFalse(nd.gate('toy', good, repo=repo)['ok'])


class PublishTest(Base):
    def test_publish_versions_and_status(self):
        (self.dl / 'TOY.zip').write_bytes(b'zip')
        (self.dl / 'TOY.zip.last-modified').write_text('Thu, 26 Nov 2026 10:00:00 GMT\n')
        (self.dl / 'TOY.zip.seen').write_text('Fri, 27 Nov 2026 10:00:00 GMT\n')
        (self.dl / 'TOY.zip.headers').write_text('HTTP/2 200\r\netag: "abc"\r\n')
        ok, m1 = self.publish(20, 'a')
        self.assertTrue(ok)
        self.assertTrue((self.pub / m1['file']).exists())
        self.assertEqual(m1['sha256'], sha(self.pub / m1['file']))
        self.assertEqual(m1['rows'], {'items': 20})
        self.assertEqual(m1['source_files'][0]['etag'], 'abc')
        self.assertEqual(m1['source_date'], '2026-11-26T10:00:00Z')
        b = nd.read_json(self.pub / 'builder-status.json')['datasets']['toy']
        self.assertEqual((b['result'], b['published_sha256'], b['source_modified']), ('published', m1['sha256'], '2026-11-27T10:00:00Z'))
        self.assertIn('confirmed_at', b)
        ok, g = self.publish(5, 'b')  # gate fails: the published copy stays
        self.assertFalse(ok)
        self.assertEqual(nd.read_json(self.pub / 'toy.json')['sha256'], m1['sha256'])
        self.assertEqual(nd.read_json(self.pub / 'builder-status.json')['datasets']['toy']['result'], 'gate_failed')
        ok, m2 = self.publish(21, 'c')
        ok, m3 = self.publish(22, 'd')
        self.assertTrue(ok)
        kept = sorted(p.name for p in self.pub.glob('toy.*.db'))
        self.assertEqual(kept, sorted([m2['file'], m3['file']]))  # this version and the one before
        self.assertTrue((self.build / 'toy.db').exists())  # the build keeps its copy for the next build's comparison
        nd.note(self.pub, 'toy', 'unchanged', confirmed=True, dl=self.dl)
        self.assertEqual(nd.read_json(self.pub / 'builder-status.json')['datasets']['toy']['published_sha256'], m3['sha256'])


class InstallTest(Base):
    def test_pull_swap_rollback(self):
        _, m1 = self.publish(20, 'a')
        self.assertEqual(inst.main(['pull']), 0)
        live = self.data / 'toy.db'
        self.assertEqual(sha(live), m1['sha256'])
        self.assertFalse((self.data / 'toy.db.prev').exists())
        line = [json.loads(l) for l in (self.state / 'status.jsonl').read_text().splitlines()][0]
        self.assertEqual((line['state'], line['sha256'], line['rows']), ('installed', m1['sha256'], {'items': 20}))
        self.assertTrue(line['confirmed_at'])
        _, m2 = self.publish(21, 'b')
        self.assertEqual(inst.main(['pull']), 0)
        self.assertEqual(sha(live), m2['sha256'])
        self.assertEqual(sha(self.data / 'toy.db.prev'), m1['sha256'])
        self.assertEqual(nd.read_json(self.state / 'live' / 'toy.json')['previous_sha256'], m1['sha256'])
        self.assertEqual(list((self.data / '.incoming').glob('toy.*')), [])
        self.assertEqual(inst.main(['pull']), 0)  # nothing new: nothing happens
        self.assertEqual(sha(live), m2['sha256'])
        # one-step rollback; the rolled-back version is not pulled again
        self.assertEqual(inst.main(['rollback', 'toy']), 0)
        self.assertEqual(sha(live), m1['sha256'])
        self.assertEqual(inst.main(['pull']), 0)
        self.assertEqual(sha(live), m1['sha256'])
        self.assertEqual(nd.status_lines(self.data, self.state)[0]['sha256'], m1['sha256'])
        _, m3 = self.publish(22, 'c')
        self.assertEqual(inst.main(['pull']), 0)
        self.assertEqual(sha(live), m3['sha256'])

    def test_bad_pull_keeps_live(self):
        _, m1 = self.publish(20, 'a')
        inst.main(['pull'])
        _, m2 = self.publish(21, 'b')
        with open(self.pub / m2['file'], 'ab') as f:  # damaged after the manifest was written
            f.write(b'x')
        self.assertEqual(inst.main(['pull']), 1)
        self.assertEqual(sha(self.data / 'toy.db'), m1['sha256'])
        st = nd.read_json(self.state / 'install-state.json')
        self.assertIn('sha256', st['datasets']['toy']['last_error'])
        # a file this server's gate refuses (here: a higher floor) is not installed and not pulled again
        _, m3 = self.publish(22, 'c')
        nd.DATASETS['toy']['floor'] = {'items': 1000}
        self.assertEqual(inst.main(['pull']), 1)
        self.assertEqual(sha(self.data / 'toy.db'), m1['sha256'])
        self.assertIn(m3['sha256'], nd.read_json(self.state / 'install-state.json')['datasets']['toy']['rejected'])
        self.assertEqual(inst.main(['pull']), 0)

    def test_unreachable_build_server(self):
        inst.SRC = str(self.dir / 'nowhere') + '/'
        self.assertEqual(inst.main(['pull']), 1)
        st = nd.read_json(self.state / 'install-state.json')
        self.assertIn('rsync', st['last_error'])
        self.assertNotIn('last_ok_at', st)


class CheckTest(Base):
    def topics(self, now):
        return sorted(t for t, _, _ in nd.problems(self.data, self.state, now))

    def test_problems(self):
        self.assertIn('missing-toy', self.topics(T0))
        _, m1 = self.publish(20, 'a')
        inst.main(['pull'])
        now = nd.utcnow()
        self.assertEqual(self.topics(now), [])
        self.assertEqual(self.topics(now + datetime.timedelta(hours=7)), ['pull'])
        self.assertEqual(self.topics(now + datetime.timedelta(hours=47)), ['builder', 'pull'])
        self.assertEqual(self.topics(now + datetime.timedelta(hours=49)), ['builder', 'pull', 'stale-toy'])
        # the source NHTSA publishes stopped changing: reported after 2 x 1 day + 1
        b = nd.read_json(self.pub / 'builder-status.json')
        b['datasets']['toy']['source_modified'] = nd.iso(now - datetime.timedelta(days=4))
        nd.write_json(self.state / 'builder-status.json', b)
        self.assertEqual(self.topics(now), ['source-toy'])
        # a failed build mails right away
        nd.note(self.pub, 'toy', 'failed', 'download of TOY.zip failed', dl=self.dl)
        inst.main(['pull'])
        self.assertEqual(self.topics(nd.utcnow()), ['build-toy'])
        # a published version not installed for 6 hours
        _, m2 = self.publish(21, 'b')
        nd.DATASETS['toy']['floor'] = {'items': 1000}
        inst.main(['pull'])  # refused here: rejected, so not reported as pending
        self.assertNotIn('install-toy', self.topics(nd.utcnow() + datetime.timedelta(hours=7)))
        nd.DATASETS['toy']['floor'] = {'items': 10}
        _, m3 = self.publish(22, 'c')
        inst.SRC = str(self.dir / 'nowhere') + '/'
        inst.main(['pull'])
        st = nd.read_json(self.state / 'install-state.json')
        st['datasets']['toy'].update({'seen_sha256': m3['sha256'], 'seen_at': nd.iso(nd.utcnow())})
        nd.write_json(self.state / 'install-state.json', st)
        nd.write_json(self.state / 'builder-status.json', nd.read_json(self.pub / 'builder-status.json'))
        self.assertNotIn('install-toy', self.topics(nd.utcnow() + datetime.timedelta(hours=5)))
        self.assertIn('install-toy', self.topics(nd.utcnow() + datetime.timedelta(hours=7)))

    def test_hand_installed_file_and_mail(self):
        make_db(self.data / 'toy.db', 20)  # put there by hand: no install manifest; its own metadata dates it
        line = nd.status_lines(self.data, self.state)[0]
        self.assertEqual((line['state'], line['source_date'], line['rows']), ('manual', '2026-11-27T10:08:54Z', {'items': 20}))
        self.assertIn('stale-toy', self.topics(T0 + datetime.timedelta(days=3)))
        out = self.dir / 'mail.txt'
        fake = self.dir / 'notify.py'
        fake.write_text(f"import sys, json\nopen({str(out)!r}, 'a').write(json.dumps(sys.argv[1:]) + '\\n')\n")
        found = nd.check(self.data, self.state, now=T0 + datetime.timedelta(days=3), notify=str(fake))
        mails = [json.loads(l) for l in out.read_text().splitlines()]
        self.assertEqual(len(mails), len(found))
        self.assertTrue(all(m[0:4] == ['--topic', 'nhtsa-' + t, '--cooldown', '72000'] for m, (t, _, _) in zip(mails, found)))
        self.assertTrue(any(m[4].startswith('mcp.vin NHTSA data: toy not refreshed') for m in mails))


class RegistryTest(unittest.TestCase):
    def test_every_dataset_is_complete(self):
        for name, spec in nd.DATASETS.items():
            for k in ('file', 'mode', 'confirm_hours', 'source_days', 'source', 'tables', 'counts', 'floor'):
                self.assertIn(k, spec, f'{name} lacks {k}')
            self.assertEqual(set(spec['floor']), set(spec['counts']), name)
        js = (ROOT / 'scripts' / 'nhtsa-known-answers.mjs').read_text()
        for name in nd.DATASETS:
            self.assertIn(f"'{name}': file =>", js, f'no known answers for {name}')
        files = {spec['file'] for spec in nd.DATASETS.values()}
        lib = '\n'.join(p.read_text() for p in (ROOT / 'lib').glob('*.mjs'))
        for f in files:
            self.assertIn(f"data/{f}", lib, f'the site does not read {f}')

    def test_build_script_modes(self):
        r = subprocess.run(['bash', '-n', str(ROOT / 'scripts' / 'nhtsa-build.sh')], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        modes = {spec['mode'] for spec in nd.DATASETS.values()}
        sh = (ROOT / 'scripts' / 'nhtsa-build.sh').read_text()
        for mode in modes:
            self.assertIn(f'  {mode}) run_{mode} ;;', sh)
        for name in nd.DATASETS:
            self.assertIn(name, sh, f'nhtsa-build.sh never builds {name}')


if __name__ == '__main__':
    unittest.main()

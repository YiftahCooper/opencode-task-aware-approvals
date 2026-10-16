import json
import tempfile
import unittest
from pathlib import Path
from qualification_helpers import latest_results, completed, selected_protocol

class QualificationCompletionTests(unittest.TestCase):
    def test_short_state_lock_absence_does_not_mean_batch_finished(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'batch-locks').mkdir()
            claim=root/'batch-locks/claim-example.json'
            claim.write_text('{}')
            self.assertFalse(completed(root, {'batch': {'pending':['second']}}, stopping=True))
            claim.unlink()
            self.assertFalse(completed(root, {'batch': {'pending':['second']}}, stopping=False))
            self.assertTrue(completed(root, {'batch': {'pending':['second']}}, stopping=True))
            self.assertTrue(completed(root, {}, stopping=False))
    def test_newest_candidate_verdict_supersedes_old_pass(self):
        old={'candidate':{'key':'a'},'errors':0}
        new={'candidate':{'key':'a'},'errors':1}
        self.assertEqual(latest_results([old,new]),[new])
    def test_selected_release_protocol_is_independent_of_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'dist').mkdir()
            (root/'dist/build.json').write_text(json.dumps({'build':'b'*64}))
            self.assertEqual(selected_protocol(root),'task-aware-v1:'+'b'*64)

class NativeFirstUseTests(unittest.TestCase):
    def test_fresh_capture_needs_no_prior_qualification_and_recognizes_fork(self):
        import io
        import runpy
        from contextlib import redirect_stdout
        from unittest.mock import patch, MagicMock
        source=Path(__file__).parent/'native_catalog.py'
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            script=root/'plugin/tests/host/native_catalog.py'
            script.parent.mkdir(parents=True)
            script.write_bytes(source.read_bytes())
            process=MagicMock()
            process.stdout.readline.return_value=b'server listening on http://127.0.0.1:12345\n'
            process.poll.return_value=None
            selector=MagicMock();selector.select.return_value=[True]
            urls=[]
            def response(req,**_):
                urls.append(req.full_url)
                path=req.full_url.split('?')[0]
                value=[] if path.endswith('/api/config') else {'data':[]}
                if path.endswith('/api/plugin'):value={'data':[{'id':'opencode-task-aware-approvals','state':{'status':'active'}}]}
                if path.endswith('/api/provider/opencode-go'):value={'data':{'id':'opencode-go'}}
                return io.BytesIO(json.dumps(value).encode())
            database=MagicMock()
            database.__enter__.return_value.execute.return_value.fetchone.return_value=(json.dumps({'body':json.dumps({'opencode-go':{}})}),)
            calls=[]
            def command(argv,**kwargs):
                calls.append(argv)
                return '2.0.30' if '--version' in argv else json.dumps({'hostVersion':'2.0.30','providerFingerprint':'a'*64,'candidates':[]}).encode()
            clock=iter(range(100))
            with patch('pathlib.Path.home',return_value=root/'home'),patch('subprocess.Popen',return_value=process),patch('subprocess.check_output',side_effect=command),patch('selectors.DefaultSelector',return_value=selector),patch('urllib.request.urlopen',side_effect=response),patch('sqlite3.connect',return_value=database),patch('time.monotonic',side_effect=lambda:next(clock)),patch('time.sleep'),patch('sys.argv',[str(script),'--write-binding','--export-catalog']),redirect_stdout(io.StringIO()) as output:
                runpy.run_path(str(script),run_name='__main__')
            binding=json.loads((root/'qualification/native-binding.json').read_text())
            self.assertTrue(binding['plugins'][0]['isApprover'])
            self.assertEqual(sum('/api/plugin?' in url for url in urls),1)
            self.assertTrue((root/'.backup-scratch/native-models.json').is_file())
            self.assertTrue(json.loads(output.getvalue())['publicCatalogExported'])

class LiveRunnerSerializationTests(unittest.TestCase):
    def test_live_preflight_and_acceptance_cannot_touch_an_active_runner(self):
        import os
        import shutil
        import subprocess
        import time
        source = Path(__file__).parent / 'run-isolated.sh'
        scratch = source.resolve().parents[3] / '.backup-scratch/runner-tests'
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            root = Path(directory)
            runner = root / 'plugin/tests/host/run-isolated.sh'
            runner.parent.mkdir(parents=True)
            shutil.copyfile(source, runner)
            tools = root / 'tools'
            tools.mkdir()
            # Simulate the host boundary only: close inherited descriptors just as
            # bwrap does, touch fixture state, then hold until explicitly released.
            boundary = tools / 'bwrap'
            boundary.write_text('''#!/usr/bin/python3
import os, time
from pathlib import Path
os.closerange(3, 1024)
root = Path(os.environ['RUNNER_FIXTURE'])
already_started = (root / 'ready').exists()
profile = root / '.backup-scratch/host/live/profile'
profile.mkdir(parents=True, exist_ok=True)
(profile / 'server.log').write_text('host started')
with (root / 'calls').open('a') as f: f.write('fake host boundary\\n')
(root / 'qualification/selection.json').unlink(missing_ok=True)
(root / 'ready').touch()
if already_started: raise SystemExit(0)
deadline = time.monotonic() + 15
while not (root / 'release').exists():
    if time.monotonic() > deadline: raise SystemExit(99)
    time.sleep(.02)
''')
            boundary.chmod(0o700)
            catalog = root / 'catalog.json'
            catalog.write_text('{}')
            legacy = root / '.backup-scratch/host/live/profile/home/.local/state/opencode/task-aware-approvals'
            legacy.mkdir(parents=True)
            (legacy / 'selection.json').write_text('{"spend":[123]}')
            environment = {**os.environ, 'HOME': str(root / 'home'),
                           'PATH': str(tools) + ':' + os.environ['PATH'],
                           'RUNNER_FIXTURE': str(root), 'TASK_AWARE_MODEL_CATALOG': str(catalog)}
            environment.pop('TASK_AWARE_RELEASE', None)
            first = subprocess.Popen(['bash', str(runner), 'live'], env=environment,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 5
                while not (root / 'ready').exists():
                    self.assertIsNone(first.poll(), 'first runner exited before fake host startup')
                    self.assertLess(time.monotonic(), deadline, 'fake host did not start')
                    time.sleep(.02)
                profile = root / '.backup-scratch/host/live/profile/server.log'
                profile.write_text('first host owns this log')
                for args in [[], ['--preflight'], ['--acceptance']]:
                    with self.subTest(args=args):
                        second = subprocess.run(['bash', str(runner), 'live', *args], env=environment,
                                                capture_output=True, text=True, timeout=3)
                        self.assertNotEqual(second.returncode, 0)
                        self.assertIn('already running', second.stderr)
                        self.assertIsNone(first.poll())
                        self.assertEqual(profile.read_text(), 'first host owns this log')
                        self.assertFalse((root / 'qualification/selection.json').exists(),
                                         'second invocation migrated evidence before refusal')
                        self.assertEqual((root / 'calls').read_text(), 'fake host boundary\n')
            finally:
                (root / 'release').touch()
                try:
                    output = first.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    first.kill()
                    first.communicate()
                    raise
            self.assertEqual(first.returncode, 0, output)
            # The same lock may be reused after the complete first host lifetime.
            later = subprocess.run(['bash', str(runner), 'live', '--preflight'], env=environment,
                                   capture_output=True, text=True, timeout=3)
            self.assertEqual(later.returncode, 0, later.stderr)
            self.assertEqual(len((root / 'calls').read_text().splitlines()), 2)

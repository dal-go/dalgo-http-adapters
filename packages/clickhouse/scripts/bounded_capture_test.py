"""Real Linux subprocess tests; no SDK, database, browser or dependencies."""
import json
import os
import pathlib
import resource
import selectors
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from bounded_capture import MAX_LOG_BYTES, capture


@unittest.skipUnless(sys.platform == 'linux', 'Exact Linux process/rlimit proof required')
class BoundedCaptureTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='bounded-capture-test-')
        self.root = pathlib.Path(self.directory.name)
        self.raw = self.root / 'raw'
        self.proof = self.root / 'proof'

    def tearDown(self):
        self.directory.cleanup()

    def run_capture(self, code, *args, **options):
        return capture([sys.executable, '-c', code, *map(str, args)], self.raw, self.proof,
                       timeout_seconds=options.pop('timeout_seconds', 3),
                       kill_after_seconds=options.pop('kill_after_seconds', 0.1), **options)

    def test_actual_bash_file_limit_unit_is_one_mib(self):
        # Verify both kernel units and an actual non-log file rejection.
        code = """import errno,resource,signal,sys
print(resource.getrlimit(resource.RLIMIT_FSIZE)[0])
signal.signal(signal.SIGXFSZ,signal.SIG_IGN)
try:
    with open(sys.argv[1],'wb') as stream: stream.truncate(1048577)
except OSError as error:
    assert error.errno==errno.EFBIG
    print('NON_LOG_FILE_LIMIT_PROVED')
else:
    raise SystemExit('Expected legacy non-log file limit was absent.')
"""
        run = subprocess.run(['bash', '-c', 'ulimit -f 1024; exec "$1" -c "$2" "$3"',
                              'legacy-limit-probe', sys.executable, code, str(self.root / 'legacy-profile')], capture_output=True, timeout=3)
        self.assertEqual(run.returncode, 0)
        self.assertEqual(run.stdout.splitlines(), [str(MAX_LOG_BYTES).encode(), b'NON_LOG_FILE_LIMIT_PROVED'])

    def test_exact_merged_log_boundary_is_allowed(self):
        proof = self.run_capture("import os; os.write(1,b'a'*16); os.write(2,b'b'*16)", max_bytes=32)
        self.assertEqual(self.raw.read_bytes(), b'a' * 16 + b'b' * 16)
        self.assertEqual((proof['status'], proof['exitCode'], proof['logBytes']), ('completed', 0, 32))
        self.assertTrue(proof['ownedNoLiveDescendants'])

    def test_browser_profile_file_can_exceed_log_cap_with_unlimited_child_rlimit(self):
        profile = self.root / 'synthetic-profile'
        code = "import json,resource,sys; f=open(sys.argv[1],'wb'); f.seek(1048576+32); f.write(b'x'); f.close(); print(json.dumps(list(resource.getrlimit(resource.RLIMIT_FSIZE))))"
        proof = self.run_capture(code, profile, max_bytes=128)
        self.assertEqual(proof['exitCode'], 0)
        self.assertEqual(profile.stat().st_size, MAX_LOG_BYTES + 33)
        self.assertEqual(json.loads(self.raw.read_bytes()), list(resource.getrlimit(resource.RLIMIT_FSIZE)))
        for field in ['inheritedFileSizeSoft', 'inheritedFileSizeHard', 'childFileSizeSoft', 'childFileSizeHard']:
            self.assertEqual(proof[field], 'unlimited')

    def test_overflow_stops_at_exact_log_cap_and_fails(self):
        proof = self.run_capture("import os,time; os.write(2,b'x'*4096); time.sleep(30)", max_bytes=32)
        self.assertEqual(self.raw.read_bytes(), b'x' * 32)
        self.assertEqual((proof['status'], proof['exitCode'], proof['logBytes']), ('log-overflow', 125, 32))
        self.assertTrue(proof['ownedNoLiveDescendants'])

    def test_child_nonzero_is_preserved_and_payload_does_not_enter_proof(self):
        proof = self.run_capture("import sys; print('PRIVATE_CAPTURE_SENTINEL'); sys.exit(7)")
        self.assertEqual((proof['status'], proof['childReturnCode'], proof['exitCode']), ('child-failed', 7, 7))
        self.assertIn(b'PRIVATE_CAPTURE_SENTINEL', self.raw.read_bytes())
        self.assertNotIn(b'PRIVATE_CAPTURE_SENTINEL', self.proof.read_bytes())

    def test_deadline_kills_own_term_resistant_group(self):
        pid_file = self.root / 'descendant'
        code = "import os,pathlib,signal,subprocess,sys,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); p=subprocess.Popen([sys.executable,'-c','import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(30)']); pathlib.Path(sys.argv[1]).write_text(str(p.pid)); time.sleep(30)"
        proof = self.run_capture(code, pid_file, timeout_seconds=1)
        self.assertEqual((proof['status'], proof['exitCode']), ('deadline', 124))
        self.assertTrue(proof['termSent'])
        self.assertTrue(proof['killSent'])
        self.assertTrue(proof['ownedNoLiveDescendants'])
        self.assertLess(proof['seconds'], 3)
        descendant = pathlib.Path('/proc', pid_file.read_text(), 'stat')
        if descendant.exists():
            self.assertIn(descendant.read_text().rsplit(') ', 1)[1].split()[0], ['Z', 'X'])

    def test_controller_sigterm_cleans_its_child_group(self):
        pid_file = self.root / 'child'
        code = "import json,os,pathlib,sys,time; start=int(pathlib.Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split()[19]); pathlib.Path(sys.argv[1]).write_text(json.dumps({'pid':os.getpid(),'start':start})); time.sleep(30)"
        helper = pathlib.Path(__file__).with_name('bounded_capture.py')
        controller = subprocess.Popen([sys.executable, str(helper), str(self.raw), str(self.proof), '--',
                                       sys.executable, '-c', code, str(pid_file)],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            deadline = time.monotonic() + 3
            while not pid_file.exists() and time.monotonic() < deadline:
                self.assertIsNone(controller.poll())
                time.sleep(0.02)
            self.assertTrue(pid_file.exists())
            controller.send_signal(signal.SIGTERM)
            stdout, stderr = controller.communicate(timeout=4)
            self.assertEqual(controller.returncode, 143)
            self.assertEqual(stdout + stderr, b'')
            proof = json.loads(self.proof.read_text())
            self.assertEqual((proof['status'], proof['interruptSignal']), ('interrupted', 'SIGTERM'))
            self.assertTrue(proof['ownedNoLiveDescendants'])
            identity = json.loads(pid_file.read_text())
            child = pathlib.Path('/proc', str(identity['pid']), 'stat')
            if child.exists():
                self.assertIn(child.read_text().rsplit(') ', 1)[1].split()[0], ['Z', 'X'])
        finally:
            if controller.poll() is None:
                controller.kill()
                controller.wait(timeout=2)
            # Test failure must also remove only this exact test child identity.
            if pid_file.exists():
                identity = json.loads(pid_file.read_text())
                child_id = identity['pid']
                try:
                    fields = pathlib.Path('/proc', str(child_id), 'stat').read_text().rsplit(') ', 1)[1].split()
                    uid = next(line for line in pathlib.Path('/proc', str(child_id), 'status').read_text().splitlines() if line.startswith('Uid:'))
                    if int(fields[19]) == identity['start'] and tuple(map(int, uid.split()[1:])) == (os.getuid(),) * 4 and fields[0] not in ('Z', 'X'):
                        os.kill(child_id, signal.SIGKILL)
                except (FileNotFoundError, ProcessLookupError):
                    pass

    def test_detached_double_fork_is_adopted_killed_and_reaped(self):
        identity_file = self.root / 'detached-identity'
        code = """import json,os,pathlib,signal,sys,time
signal.signal(signal.SIGTERM,signal.SIG_IGN)
root_pid=os.getpid()
root_start=int(pathlib.Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split()[19])
middle=os.fork()
if middle==0:
    os.setsid()
    detached=os.fork()
    if detached: os._exit(0)
    start=int(pathlib.Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split()[19])
    pathlib.Path(sys.argv[1]).write_text(json.dumps({'pid':os.getpid(),'start':start,'group':os.getpgrp(),'session':os.getsid(0),'rootPid':root_pid,'rootStart':root_start}))
    time.sleep(30)
    os._exit(0)
os.waitpid(middle,0)
time.sleep(30)
"""
        try:
            proof = self.run_capture(code, identity_file, timeout_seconds=1.5)
            identity = json.loads(identity_file.read_text())
            self.assertNotEqual(identity['session'], identity['rootPid'])
            self.assertNotEqual(identity['group'], identity['rootPid'])
            self.assertEqual((proof['status'], proof['exitCode']), ('deadline', 124))
            self.assertTrue(proof['killSent'])
            self.assertTrue(proof['ownedNoLiveDescendants'])
            self.assertGreaterEqual(proof['adoptedChildrenReaped'], 1)
            self.assertFalse(pathlib.Path('/proc', str(identity['pid'])).exists())
        finally:
            # Also safe if an older group-only collector incorrectly left it alive.
            if identity_file.exists():
                identity = json.loads(identity_file.read_text())
                for pid, start in [(identity['pid'], identity['start']), (identity['rootPid'], identity['rootStart'])]:
                    try:
                        path = pathlib.Path('/proc', str(pid))
                        fields = (path / 'stat').read_text().rsplit(') ', 1)[1].split()
                        uid = next(line for line in (path / 'status').read_text().splitlines() if line.startswith('Uid:'))
                        if int(fields[19]) == start and tuple(map(int, uid.split()[1:])) == (os.getuid(),) * 4:
                            os.kill(pid, signal.SIGKILL)
                            try:
                                os.waitpid(pid, os.WNOHANG)
                            except ChildProcessError:
                                pass
                    except (FileNotFoundError, ProcessLookupError):
                        pass

    def test_late_final_eof_cannot_accept_a_successful_child(self):
        selector = selectors.DefaultSelector()
        select = selector.select
        delayed = [False]

        def late_ready(timeout=None):
            ready = select(timeout)
            if ready and not delayed[0]:
                delayed[0] = True
                time.sleep(0.6)  # Genuine ready EOF is delivered after the deadline.
            return ready

        with mock.patch('bounded_capture.selectors.DefaultSelector', return_value=selector):
            with mock.patch.object(selector, 'select', side_effect=late_ready):
                proof = self.run_capture('pass', timeout_seconds=0.5)
        self.assertTrue(delayed[0])
        self.assertEqual((proof['status'], proof['childReturnCode'], proof['exitCode']), ('deadline', 0, 124))
        self.assertTrue(proof['ownedNoLiveDescendants'])

    def test_preexisting_unrelated_child_is_never_adopted_or_killed(self):
        unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
        try:
            proof = self.run_capture("raise SystemExit('must never launch')")
            self.assertNotEqual(proof['exitCode'], 0)
            self.assertFalse(proof['preexistingChildrenAbsent'])
            self.assertFalse(proof['subreaperEnabled'])
            self.assertIsNone(proof['childReturnCode'])
            self.assertIsNone(unrelated.poll())
        finally:
            unrelated.terminate()
            unrelated.wait(timeout=2)


if __name__ == '__main__':
    unittest.main()

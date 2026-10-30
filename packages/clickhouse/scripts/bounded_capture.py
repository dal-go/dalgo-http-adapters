"""Bound only a fixture's combined log, never its browser/profile files.

Linux-only: one admitted subreaper owns the child tree, including new sessions.
No shell or rlimit mutation.
The CLI policy is fixed. Smaller function arguments exist for focused tests.
"""
import ctypes
import json
import os
import pathlib
import resource
import selectors
import signal
import subprocess
import sys
import time

MAX_LOG_BYTES = 1024 * 1024
TIMEOUT_SECONDS = 120
KILL_AFTER_SECONDS = 2


def _limit(value):
    return 'unlimited' if value == resource.RLIM_INFINITY else int(value)


def _process(pid):
    try:
        path = pathlib.Path('/proc', str(pid))
        fields = (path / 'stat').read_text().rsplit(') ', 1)[1].split()
        uid_line = next(line for line in (path / 'status').read_text().splitlines() if line.startswith('Uid:'))
        return {'parent': int(fields[1]), 'start': int(fields[19]),
                'state': fields[0], 'uid': tuple(map(int, uid_line.split()[1:]))}
    except (FileNotFoundError, ProcessLookupError):
        return None


def _children():
    return {int(value) for value in pathlib.Path('/proc', str(os.getpid()), 'task', str(os.getpid()), 'children').read_text().split()}


def _subreaper(value=None):
    prctl = ctypes.CDLL(None, use_errno=True).prctl
    prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    prctl.restype = ctypes.c_int
    result = ctypes.c_int()
    option, argument = (37, ctypes.addressof(result)) if value is None else (36, int(value))
    if prctl(option, argument, 0, 0, 0) != 0:
        raise RuntimeError('Owned Linux supervisor admission failed.')
    return result.value if value is None else None


class _Supervisor:
    """Private synchronous API: no preexisting child/thread or foreign reaper.

    Only our Popen can create children after admission. Linux reparents escaped
    orphan descendants to this subreaper regardless of their process group/SID.
    """
    def __init__(self, proof):
        self.proof = proof
        self.known = {}
        self.enabled = False

    def admit(self):
        self.proof['singleThread'] = len(list(pathlib.Path('/proc/self/task').iterdir())) == 1
        self.proof['preexistingChildrenAbsent'] = not _children()
        if not self.proof['singleThread'] or not self.proof['preexistingChildrenAbsent'] or signal.getsignal(signal.SIGCHLD) != signal.SIG_DFL or _subreaper() != 0:
            raise RuntimeError('Dedicated owned supervisor required.')
        _subreaper(True)
        self.enabled = True
        if _subreaper() != 1:
            raise RuntimeError('Owned Linux subreaper was not enabled.')
        self.proof['subreaperEnabled'] = True

    def discover(self, child):
        child.poll()  # Popen alone reaps its direct child and preserves its status.
        snapshot = {}
        for path in pathlib.Path('/proc').iterdir():
            if path.name.isdecimal():
                try:
                    info = _process(int(path.name))
                    if info is not None:
                        snapshot[int(path.name)] = info
                except PermissionError:
                    # Unknown foreign processes are never candidates for killing.
                    if int(path.name) in self.known or int(path.name) in _children():
                        raise RuntimeError('Owned process identity is unreadable.') from None
        owned = set()
        for pid, record in list(self.known.items()):
            info = snapshot.get(pid)
            if info is None or info['start'] != record['start']:
                del self.known[pid]  # Never signal a reused PID.
            elif info['uid'] != (os.getuid(),) * 4:
                raise RuntimeError('Owned process UID changed.')
            else:
                owned.add(pid)
        changed = True
        while changed:
            changed = False
            for pid, info in snapshot.items():
                if info['parent'] != os.getpid() and info['parent'] not in owned:
                    continue
                if info['uid'] != (os.getuid(),) * 4:
                    raise RuntimeError('Owned descendant UID mismatch.')
                if pid not in owned:
                    if len(self.known) >= 128:
                        raise RuntimeError('Owned descendant identity bound exceeded.')
                    self.known[pid] = {'start': info['start']}
                    self.proof['ownedProcessesSeen'] = min(10_000, self.proof['ownedProcessesSeen'] + 1)
                    owned.add(pid)
                    changed = True
        for pid in list(owned):
            info = snapshot[pid]
            if pid != child.pid and info['parent'] == os.getpid() and info['state'] in ('Z', 'X'):
                # Only a lineage-proven/adopted child is reaped; never waitpid(-1).
                current = _process(pid)
                if current is not None and current['start'] == self.known[pid]['start'] and current['uid'] == (os.getuid(),) * 4:
                    reaped, _ = os.waitpid(pid, os.WNOHANG)
                    if reaped:
                        self.proof['adoptedChildrenReaped'] = min(10_000, self.proof['adoptedChildrenReaped'] + 1)
                        del self.known[pid]
                        owned.remove(pid)
        return [(pid, self.known[pid]['start']) for pid in owned if snapshot[pid]['state'] not in ('Z', 'X')]

    def signal(self, identity, number):
        pid, start = identity
        current = _process(pid)
        if current is not None and current['start'] == start:
            if current['uid'] != (os.getuid(),) * 4:
                raise RuntimeError('Owned signal target UID mismatch.')
            try:
                os.kill(pid, number)
            except ProcessLookupError:
                pass

    def stop(self, child, grace):
        term_at = time.monotonic() + grace
        reap_until = term_at + 0.5
        terminated = set()
        while True:
            live = self.discover(child)
            if not live and not _children():
                return True
            now = time.monotonic()
            if now >= reap_until:
                return False
            for identity in live:
                if now >= term_at:
                    self.signal(identity, signal.SIGKILL)
                    self.proof['killSent'] = True
                elif identity not in terminated:
                    self.signal(identity, signal.SIGTERM)
                    terminated.add(identity)
                    self.proof['termSent'] = True
            time.sleep(0.01)

    def restore(self):
        if self.enabled:
            if _children():
                raise RuntimeError('Owned children survived supervisor cleanup.')
            _subreaper(False)
            self.enabled = False


def capture(command, output, proof_file, *, max_bytes=MAX_LOG_BYTES,
            timeout_seconds=TIMEOUT_SECONDS, kill_after_seconds=KILL_AFTER_SECONDS):
    if sys.platform != 'linux' or not command or not (0 < max_bytes <= MAX_LOG_BYTES) or not (0 < timeout_seconds <= TIMEOUT_SECONDS) or not (0 < kill_after_seconds <= KILL_AFTER_SECONDS):
        raise ValueError('Bounded capture requires its fixed Linux policy.')
    started = time.monotonic()
    inherited = resource.getrlimit(resource.RLIMIT_FSIZE)
    proof = {'format': 'bounded-process-capture', 'version': 1, 'status': 'collector-error',
             'maxLogBytes': max_bytes, 'logBytes': 0, 'timeoutSeconds': timeout_seconds,
             'killAfterSeconds': kill_after_seconds,
             'inheritedFileSizeSoft': _limit(inherited[0]), 'inheritedFileSizeHard': _limit(inherited[1]),
             'childFileSizeSoft': 'not-observed', 'childFileSizeHard': 'not-observed',
             'childReturnCode': None, 'exitCode': 125, 'ownedNoLiveDescendants': False,
             'singleThread': False, 'preexistingChildrenAbsent': False, 'subreaperEnabled': False,
             'ownedProcessesSeen': 0, 'adoptedChildrenReaped': 0,
             'termSent': False, 'killSent': False, 'interruptSignal': 'none'}
    child = None
    supervisor = _Supervisor(proof)
    interrupted = [0]
    prior_handlers = {}
    selector = selectors.DefaultSelector()
    raw_fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            prior_handlers[number] = signal.signal(number, lambda signum, _frame: interrupted.__setitem__(0, interrupted[0] or signum))
        if inherited != (resource.RLIM_INFINITY, resource.RLIM_INFINITY):
            proof['status'] = 'finite-inherited-file-limit'
        else:
            supervisor.admit()
            try:
                child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                         stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
            except OSError:
                proof['status'] = 'spawn-error'
                proof['exitCode'] = 127
            if child is not None:
                try:
                    actual = resource.prlimit(child.pid, resource.RLIMIT_FSIZE)
                    proof['childFileSizeSoft'], proof['childFileSizeHard'] = map(_limit, actual)
                except ProcessLookupError:
                    pass
                os.set_blocking(child.stdout.fileno(), False)
                selector.register(child.stdout, selectors.EVENT_READ)
                proof['status'] = 'running'
                deadline = started + timeout_seconds
                eof = False
                while True:
                    if interrupted[0]:
                        proof['status'] = 'interrupted'
                        break
                    remaining_time = deadline - time.monotonic()
                    if remaining_time <= 0:
                        proof['status'] = 'deadline'
                        proof['exitCode'] = 124
                        break
                    supervisor.discover(child)
                    if child.poll() is not None and eof:
                        # Recheck after the real process observation, before acceptance.
                        if time.monotonic() >= deadline:
                            proof['status'], proof['exitCode'] = 'deadline', 124
                        else:
                            proof['status'] = 'completed' if child.returncode == 0 else 'child-failed'
                            proof['exitCode'] = child.returncode if child.returncode >= 0 else 128 - child.returncode
                        break
                    remaining_time = deadline - time.monotonic()
                    if remaining_time <= 0:
                        proof['status'], proof['exitCode'] = 'deadline', 124
                        break
                    for key, _ in selector.select(min(0.05, remaining_time)):
                        chunk = os.read(key.fd, 65_536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            eof = True
                            continue
                        remaining = max_bytes - proof['logBytes']
                        kept = chunk[:remaining]
                        if kept:
                            view = memoryview(kept)
                            while view:
                                written = os.write(raw_fd, view)
                                view = view[written:]
                            proof['logBytes'] += len(kept)
                        if len(chunk) > remaining:
                            proof['status'] = 'log-overflow'
                            proof['exitCode'] = 125
                            break
                    if proof['status'] == 'log-overflow':
                        break
                    if time.monotonic() >= deadline:
                        proof['status'], proof['exitCode'] = 'deadline', 124
                        break
    except BaseException:
        proof['status'] = 'collector-error'
        proof['exitCode'] = 125
    finally:
        # Owned process cleanup precedes any possibly failing log/FD close.
        try:
            if child is not None:
                if proof['status'] == 'completed' and supervisor.discover(child):
                    proof['status'] = 'descendants-remained'
                    proof['exitCode'] = 125
                proof['ownedNoLiveDescendants'] = supervisor.stop(child, kill_after_seconds)
                child.poll()
                proof['childReturnCode'] = child.returncode
                child.stdout.close()
            else:
                proof['ownedNoLiveDescendants'] = True
            supervisor.restore()
        except BaseException:
            # Only exact recorded identities may receive an emergency signal.
            for pid, record in list(supervisor.known.items()):
                try:
                    supervisor.signal((pid, record['start']), signal.SIGKILL)
                    proof['killSent'] = True
                except (OSError, RuntimeError):
                    pass
            proof['ownedNoLiveDescendants'] = False
        try:
            selector.close()
            os.close(raw_fd)
        except OSError:
            proof['status'] = 'collector-error'
            proof['exitCode'] = 125
        if interrupted[0]:
            proof['status'] = 'interrupted'
            proof['exitCode'] = 128 + interrupted[0]
            proof['interruptSignal'] = signal.Signals(interrupted[0]).name
        if not proof['ownedNoLiveDescendants']:
            proof['status'] = 'cleanup-failed'
            proof['exitCode'] = 125
        proof['seconds'] = round(time.monotonic() - started, 3)
        try:
            fd = os.open(proof_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w') as stream:
                stream.write(json.dumps(proof, separators=(',', ':')) + '\n')
        finally:
            for number, handler in prior_handlers.items():
                signal.signal(number, handler)
    return proof


def main():
    if len(sys.argv) < 5 or sys.argv[3] != '--':
        raise SystemExit('Use bounded_capture.py RAW PROOF -- COMMAND [ARGS].')
    try:
        proof = capture(sys.argv[4:], pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))
    except BaseException:
        raise SystemExit('Bounded fixture capture failed; inspect its owned private proof.') from None
    raise SystemExit(proof['exitCode'])


if __name__ == '__main__':
    main()

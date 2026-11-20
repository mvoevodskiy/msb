"""Quiescence boundary for explicit legacy metadata adoption; no service writes.

The caller holds the new engine lock, then this module acquires the old helper's
existing lock and checks old units twice. An unrelated root operator can still
start an old setup manually; operators must keep the old stack quiescent.
Checks: tests/test_legacy_gate.py.
"""
import fcntl
import os
import stat
import subprocess

from client_fs import open_dir
from util import Refused

SERVICES = ('jarvis-engine.service', 'jarvis-engine-tick.service', 'jarvis-engine-update.service')
WATCHERS = ('jarvis-engine.path', 'jarvis-engine-tick.timer', 'jarvis-engine-update.path')


def _refuse(reason):
    raise Refused('NOT_AVAILABLE', detail={'reason': reason})


def _query(args):
    try:
        return subprocess.run(['/usr/bin/systemctl', *args], stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        _refuse('LEGACY_STATUS_UNKNOWN')


def assert_quiet():
    for unit in (*SERVICES, *WATCHERS):
        result = _query(['show', unit, '--property=LoadState', '--property=ActiveState', '--property=UnitFileState'])
        props = dict(line.split('=', 1) for line in (result.stdout or '').splitlines() if '=' in line)
        if result.returncode:
            _refuse('LEGACY_STATUS_UNKNOWN')
        if props.get('LoadState') == 'not-found':
            continue
        if props.get('LoadState') != 'loaded' or props.get('ActiveState') not in ('inactive', 'failed'):
            _refuse('LEGACY_UNIT_ACTIVE_OR_UNKNOWN')
        if unit in WATCHERS and props.get('UnitFileState') not in ('disabled', 'masked', 'masked-runtime'):
            _refuse('LEGACY_WATCHER_ENABLED_OR_UNKNOWN')
    result = _query(['list-units', 'jarvis-engine-oc-*.service', '--all', '--no-legend', '--plain', '--no-pager'])
    if result.returncode or (result.stdout or '').strip():
        _refuse('LEGACY_SANDBOX_ACTIVE_OR_UNKNOWN')


def acquire_old_lock(run_dir):
    try:
        directory = open_dir(run_dir)
    except OSError:
        _refuse('LEGACY_LOCK_UNAVAILABLE')
    try:
        dst = os.fstat(directory)
        if dst.st_uid != os.geteuid() or dst.st_mode & 0o022:
            _refuse('LEGACY_LOCK_UNAVAILABLE')
        try:
            fd = os.open('lock', os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
        except OSError:
            _refuse('LEGACY_LOCK_UNAVAILABLE')
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_nlink != 1 or st.st_mode & 0o022:
                _refuse('LEGACY_LOCK_UNAVAILABLE')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Refused('BUSY', detail={'reason': 'LEGACY_LOCK_BUSY'})
            return fd
        except BaseException:
            os.close(fd)
            raise
    finally:
        os.close(directory)

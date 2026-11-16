"""Run deletion-trash operations as client, not as the root request worker.

Consumers: state.compute_state (list) and actions.archives (restore).
The worker never opens a live profile. Checks: tests/test_archive_restore.py.
"""
import json
import os
import subprocess
import sys

from const import CLIENT_ROOT
from util import Refused, gid_of, uid_of


def _run(action, name=None):
    uid, gid = uid_of('client'), gid_of('client')
    if uid is None or uid == 0 or gid is None:
        raise Refused('HOST_NOT_READY', detail={'reason': 'NO_CLIENT'})
    args = [sys.executable, '-IS', os.path.join(os.path.dirname(__file__), 'client_archive.py'),
            action, CLIENT_ROOT]
    if name is not None:
        args.append(name)
    try:
        result = subprocess.run(args, user=uid, group=gid, extra_groups=(),
                                env={'PATH': '/usr/bin:/bin'}, stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=10 if action == 'list' else 120,
                                check=False)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise Refused('FAILED', 'failed', {'reason': 'ARCHIVE_WORKER'}) from e
    if result.returncode == 3:
        raise Refused('NOTHING_TO_RESTORE')
    if result.returncode != 0:
        raise Refused('FAILED', 'failed', {'reason': 'ARCHIVE_WORKER'})
    try:
        return json.loads(result.stdout)
    except (TypeError, ValueError) as e:
        raise Refused('FAILED', 'failed', {'reason': 'ARCHIVE_RESULT'}) from e


def list_trash():
    try:
        result = _run('list')
        return result if isinstance(result, list) else None
    except Refused:
        return None


def restore(name):
    result = _run('restore', name)
    if not isinstance(result, dict) or result.get('archive') != name or \
            type(result.get('restored')) is not int or result['restored'] < 0:
        raise Refused('FAILED', 'failed', {'reason': 'ARCHIVE_RESULT'})
    return {'archive': name, 'restored': result['restored']}

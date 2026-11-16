"""Identify the dedicated OS-user OpenClaw profile before any mutation.

Uses [system service facts](state.py), root install markers, and the read-only
[command transport](openclaw_exec.py). The CLI/Gateway belongs to that user:
its replies are routing evidence, not a cryptographic attestation. Checks:
tests/test_openclaw_profile.py. No IPC action calls this module yet.
"""
from dataclasses import dataclass
import json
import os
import re
import stat
import subprocess
import sys

from client_fs import open_dir
from const import OC_HOME, OC_MARKER, OC_SETUP
from openclaw_exec import run_cli
from openclaw_readiness import UUID_RE, _properties
from state import openclaw_info
from util import Refused, gid_of, uid_of


@dataclass(frozen=True)
class Profile:
    uid: int
    gid: int
    installation_id: str
    port: int
    version: str
    config_id: tuple


def _refuse(reason):
    raise Refused('NOT_AVAILABLE', detail={'reason': reason})


def _identity():
    uid, gid = uid_of('openclaw'), gid_of('openclaw')
    if not isinstance(uid, int) or uid <= 0 or not isinstance(gid, int) or gid <= 0:
        _refuse('OC_USER')
    info = openclaw_info()
    if (info.get('installed') is not True or info.get('enabled') is not True or
            info.get('incomplete') is not False or info.get('gateway') != 'active' or info.get('scope') != 'user' or
            info.get('unit') != 'openclaw-gateway.service' or info.get('adoption_pending')):
        _refuse('OC_TARGET')
    kind, marker = _properties(OC_MARKER)
    if kind != 'present' or not marker or marker.get('uid') != str(uid) or marker.get('complete') != '1':
        _refuse('OC_INSTALLATION')
    iid, port = marker.get('installation_id', ''), marker.get('port', '')
    if not UUID_RE.fullmatch(iid) or not port.isdecimal() or not 19300 <= int(port) <= 19410:
        _refuse('OC_INSTALLATION')
    kind, setup = _properties(OC_SETUP)
    if kind == 'invalid' or (kind == 'present' and
            (not setup or setup.get('installation_id') != iid or setup.get('configured') != '1')):
        _refuse('OC_SETUP')
    return uid, gid, iid, int(port), marker.get('version', '')


def _config_id(uid, gid):
    """Stat only; root never reads a user-owned config or follows its links."""
    try:
        home = open_dir(OC_HOME)
        try:
            st = os.fstat(home)
            if st.st_uid != uid or st.st_mode & 0o022:
                _refuse('OC_HOME')
        finally:
            os.close(home)
        directory = open_dir(os.path.join(OC_HOME, '.openclaw'))
        try:
            st = os.fstat(directory)
            if st.st_uid != uid or st.st_mode & 0o022:
                _refuse('OC_PROFILE')
            item = os.stat('openclaw.json', dir_fd=directory, follow_symlinks=False)
            if not stat.S_ISREG(item.st_mode) or item.st_uid != uid or item.st_nlink != 1 or item.st_mode & 0o022:
                _refuse('OC_CONFIG')
            metadata = item.st_dev, item.st_ino, item.st_ctime_ns, item.st_size
        finally:
            os.close(directory)
    except OSError:
        _refuse('OC_CONFIG')
    # Hash as the profile owner; the root process receives only the digest.
    identity = {}
    if os.geteuid() == 0:
        identity = {'user': uid, 'group': gid, 'extra_groups': ()}
    elif uid != os.geteuid() or gid != os.getegid():
        _refuse('OC_USER')
    try:
        result = subprocess.run([sys.executable, '-IS', os.path.join(os.path.dirname(__file__), 'openclaw_config_digest.py'),
                                 os.path.join(OC_HOME, '.openclaw', 'openclaw.json')],
                                env={'PATH': '/usr/bin:/bin', 'LANG': 'C'}, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, check=False, **identity)
    except (OSError, subprocess.TimeoutExpired):
        _refuse('OC_CONFIG')
    digest = result.stdout.decode('ascii', 'replace').strip()
    if result.returncode != 0 or not re.fullmatch(r'[0-9a-f]{64}', digest):
        _refuse('OC_CONFIG')
    return (*metadata, digest)


def unchanged(proof):
    try:
        return _identity() == (proof.uid, proof.gid, proof.installation_id, proof.port, proof.version) and \
            _config_id(proof.uid, proof.gid) == proof.config_id
    except Refused:
        return False


def capture():
    uid, gid, iid, port, version = _identity()
    proof = Profile(uid, gid, iid, port, version, _config_id(uid, gid))
    mode, data = run_cli(['config', 'get', 'gateway.mode', '--json'], uid=uid, gid=gid, home=OC_HOME, timeout=30)
    if mode != 0 or data != b'"local"':
        _refuse('OC_GATEWAY_MODE')
    code, data = run_cli(['gateway', 'call', 'config.get', '--json'], uid=uid, gid=gid, home=OC_HOME, timeout=30)
    try:
        value = json.loads(data) if code == 0 else None
    except (ValueError, UnicodeError):
        value = None
    if value != {'path': os.path.join(OC_HOME, '.openclaw', 'openclaw.json')}:
        _refuse('OC_GATEWAY_IDENTITY')
    if not unchanged(proof):
        _refuse('OC_PROFILE_CHANGED')
    return proof

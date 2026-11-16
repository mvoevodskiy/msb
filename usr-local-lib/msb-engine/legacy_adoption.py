"""Explicitly preserve legacy OpenClaw facts for an operator-selected user unit.

Only called by the operator CLI, not by ordinary status or startup. Old files
stay untouched. Caller must quiesce the old helper and hold the engine lock.
Checks: tests/test_legacy_adoption.py.
"""
import os
import re
import stat
import hashlib

from openclaw_readiness import UUID_RE, _properties
from util import Refused, ensure_root_dir, write_file

VERSION_RE = re.compile(r'[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(?:-[0-9A-Za-z.]{1,20})?')


def _fail(reason):
    raise Refused('NOT_AVAILABLE', detail={'reason': reason})


def _text(values, keys):
    return ''.join(f'{key}={values[key]}\n' for key in keys if key in values).encode('ascii')


def adopt(old_dir, new_dir, home, target, uid):
    old_marker = os.path.join(old_dir, 'openclaw.installed')
    kind, marker = _properties(old_marker)
    if kind == 'absent':
        pending_kind, _ = _properties(os.path.join(new_dir, 'openclaw-adoption.pending'))
        if pending_kind != 'absent':
            _fail('ADOPTION_SOURCE_MISSING')
        return 'absent'
    if kind != 'present' or not marker:
        _fail('LEGACY_MARKER')
    iid = marker.get('installation_id', '')
    if (not isinstance(uid, int) or uid <= 0 or marker.get('uid') != str(uid) or
            not UUID_RE.fullmatch(iid) or marker.get('complete') not in ('0', '1') or
            target != {'unit': 'openclaw-gateway.service', 'scope': 'user'}):
        _fail('LEGACY_IDENTITY')
    if ('owner' in marker and not re.fullmatch(r'[0-9]{1,20}', marker['owner'])) or \
       ('port' in marker and (not marker['port'].isdigit() or not 19300 <= int(marker['port']) <= 19410)) or \
       ('version' in marker and marker['version'] and not VERSION_RE.fullmatch(marker['version'])):
        _fail('LEGACY_MARKER')
    try:
        info = os.lstat(home)
    except OSError:
        _fail('LEGACY_HOME')
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid:
        _fail('LEGACY_HOME')

    kind, setup = _properties(os.path.join(old_dir, 'openclaw.setup'))
    if kind == 'invalid':
        _fail('LEGACY_SETUP')
    setup_data = None
    if kind == 'present':
        if not setup or setup.get('installation_id') != iid or setup.get('configured') not in ('0', '1') or \
           ('beside_adapter' in setup and setup['beside_adapter'] not in ('0', '1')):
            _fail('LEGACY_SETUP')
        setup_data = _text(setup, ('installation_id', 'configured', 'beside_adapter'))

    new_marker = os.path.join(new_dir, 'openclaw.installed')
    new_setup = os.path.join(new_dir, 'openclaw.setup')
    pending = os.path.join(new_dir, 'openclaw-adoption.pending')
    marker_data = _text(marker, ('uid', 'installation_id', 'owner', 'port', 'version', 'complete'))
    legacy_off = os.path.lexists(os.path.join(old_dir, 'openclaw.off'))
    fingerprint = hashlib.sha256(marker_data + b'\0' + (setup_data or b'') + b'\0' + str(legacy_off).encode()).hexdigest()
    pending_data = _text({'installation_id': iid, 'fingerprint': fingerprint}, ('installation_id', 'fingerprint'))
    current_kind, current = _properties(new_marker)
    if current_kind == 'invalid' or (current_kind == 'present' and (
            not current or current.get('installation_id') != iid or current.get('uid') != str(uid) or
            current.get('complete') != marker.get('complete') or current.get('adopted_legacy') != '1' or
            current.get('adoption_hash') != fingerprint)):
        _fail('CURRENT_INSTALLATION')
    existing_kind, existing = _properties(new_setup)
    pending_kind, pending_values = _properties(pending)
    if pending_kind == 'invalid' or (pending_kind == 'present' and
            _text(pending_values, ('installation_id', 'fingerprint')) != pending_data):
        _fail('ADOPTION_PENDING_CONFLICT')
    if existing_kind == 'invalid':
        _fail('CURRENT_SETUP')
    if existing_kind == 'present':
        if setup_data is None or _text(existing, ('installation_id', 'configured', 'beside_adapter')) != setup_data:
            _fail('CURRENT_SETUP')
    if current_kind == 'present':
        if (setup_data is not None) != (existing_kind == 'present'):
            _fail('CURRENT_SETUP')
        if pending_kind == 'present':
            if legacy_off and not os.path.lexists(os.path.join(new_dir, 'openclaw.off')):
                _fail('ADOPTION_OFF_CONFLICT')
            os.unlink(pending)
        # A later explicit start may have removed off intent. A repeat never
        # copies an older off marker back over that decision.
        return 'already'

    ensure_root_dir(new_dir, 0o700)
    if pending_kind == 'absent':
        write_file(pending, pending_data, 0o600)
    # Publish off and setup before complete marker. A partial copy cannot make
    # an incomplete install look ready; old files remain available for retry.
    if legacy_off and not os.path.lexists(os.path.join(new_dir, 'openclaw.off')):
        write_file(os.path.join(new_dir, 'openclaw.off'), b'legacy_off=1\n', 0o600)
    if setup_data is not None and existing_kind == 'absent':
        write_file(new_setup, setup_data, 0o600)
    marker_data = _text(marker, ('uid', 'installation_id', 'owner', 'port', 'version', 'complete'))
    write_file(new_marker, marker_data + f'adopted_legacy=1\nadoption_hash={fingerprint}\n'.encode(), 0o600)
    os.unlink(pending)
    return 'adopted'

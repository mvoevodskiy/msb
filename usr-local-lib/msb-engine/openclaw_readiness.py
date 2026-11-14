"""Read root-owned OpenClaw install/setup facts for state and switch guards.

An unrecorded installation or untrusted facts are unknown. An established
complete marker without a separate setup record keeps the old pre-record rule;
it is not a live Telegram channel probe.
Checks: tests/test_switch_safety.py; caller: state.openclaw_info.
"""
import os
import re
import stat

UUID_RE = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')


def _properties(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except FileNotFoundError:
        return 'absent', None
    except OSError:
        return 'invalid', None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_nlink != 1 or \
                st.st_mode & 0o022 or st.st_size > 4096:
            return 'invalid', None
        data = bytearray()
        while len(data) <= 4096:
            chunk = os.read(fd, 4097 - len(data))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > 4096:
            return 'invalid', None
        values = {}
        for line in data.decode('ascii').splitlines():
            if '=' not in line:
                continue
            key, value = line.split('=', 1)
            if key in values:
                return 'invalid', None
            values[key] = value
        return 'present', values
    except (OSError, UnicodeError):
        return 'invalid', None
    finally:
        os.close(fd)


def incomplete(marker_path, setup_path):
    kind, marker = _properties(marker_path)
    if kind != 'present' or not marker or 'complete' not in marker:
        return None
    if marker['complete'] != '1':
        return True
    kind, setup = _properties(setup_path)
    if kind == 'invalid':
        return None
    if kind == 'absent':
        return False  # Old complete installs predate the separate setup record.
    iid = setup.get('installation_id', '')
    if not UUID_RE.fullmatch(iid) or iid != marker.get('installation_id') or setup.get('configured') not in ('0', '1'):
        return None
    return setup['configured'] == '0'

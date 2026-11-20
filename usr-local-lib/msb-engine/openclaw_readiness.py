"""Read root-owned OpenClaw install/setup facts for state and switch guards.

An unrecorded installation or untrusted facts are unknown. An established
complete marker without a separate setup record keeps the old pre-record rule;
it is not a live Telegram channel probe.
Checks: tests/test_switch_safety.py; caller: state.openclaw_info.
"""
import os
import re
import stat
from client_fs import open_dir

UUID_RE = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')


def _properties(path):
    try:
        directory = open_dir(os.path.dirname(path))
    except FileNotFoundError:
        return 'absent', None
    except OSError:
        return 'invalid', None
    try:
        dst = os.fstat(directory)
        if dst.st_uid != os.geteuid() or dst.st_mode & 0o022:
            return 'invalid', None
        try:
            fd = os.open(os.path.basename(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                         dir_fd=directory)
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
        finally:
            os.close(fd)
    except (OSError, UnicodeError):
        return 'invalid', None
    finally:
        os.close(directory)


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
        return None if marker.get('adopted_legacy') == '1' else False
    iid = setup.get('installation_id', '')
    if not UUID_RE.fullmatch(iid) or iid != marker.get('installation_id') or setup.get('configured') not in ('0', '1'):
        return None
    if setup['configured'] == '0':
        return True
    return None if marker.get('adopted_legacy') == '1' else False


def legacy_adopted(marker_path):
    kind, marker = _properties(marker_path)
    return kind == 'present' and marker.get('adopted_legacy') == '1'

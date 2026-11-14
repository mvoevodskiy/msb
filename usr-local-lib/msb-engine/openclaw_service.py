"""Select one OpenClaw system/user unit and execute its service operations.

State, actions and tick share this routing. Old installs use the dedicated
openclaw user's systemd manager; open-core also supports existing system units.
Never execute a user-owned program as root. See tests/test_openclaw_service.py.
"""
import os
import subprocess
import time

from const import OC_HOME, OC_UNITS
from util import gid_of, systemctl_ok, systemctl_word, uid_of

SYSTEM_DIRS = ('/etc/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system')
USER_UNIT = 'openclaw-gateway.service'


def _user_run(args, timeout=60):
    uid, gid = uid_of('openclaw'), gid_of('openclaw')
    if uid is None or uid == 0 or gid is None:
        return None
    runtime = f'/run/user/{uid}'
    env = {
        'HOME': OC_HOME,
        'USER': 'openclaw',
        'LOGNAME': 'openclaw',
        'PATH': '/usr/bin:/bin',
        'XDG_RUNTIME_DIR': runtime,
        'DBUS_SESSION_BUS_ADDRESS': f'unix:path={runtime}/bus',
    }
    try:
        return subprocess.run(['/usr/bin/systemctl', '--user', *args],
                              user=uid, group=gid, extra_groups=(), env=env,
                              stdin=subprocess.DEVNULL, capture_output=True, text=True,
                              timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None


def discover():
    """Return a known target or an explicit ambiguous/unknown scope."""
    system = next((u for u in OC_UNITS
                   if any(os.path.lexists(os.path.join(base, u)) for base in SYSTEM_DIRS)), None)
    uid = uid_of('openclaw')
    user_dirs = [os.path.join(OC_HOME, '.config/systemd/user'), '/etc/systemd/user',
                 '/run/systemd/user', '/usr/lib/systemd/user', '/lib/systemd/user']
    if uid is not None:
        user_dirs.append(f'/run/user/{uid}/systemd/generator')
    user = any(os.path.lexists(os.path.join(base, USER_UNIT)) for base in user_dirs)
    uncertain = False
    if not user and uid is not None:
        probe = _user_run(['show', '--property=LoadState', '--value', USER_UNIT], timeout=5)
        load = (probe.stdout or '').strip() if probe and probe.returncode == 0 else ''
        user = load == 'loaded'
        uncertain = load not in ('loaded', 'not-found')
        # An inactive user manager cannot currently be running a second unit.
        # Preserve the existing system target if no user unit file was found.
        if system and uncertain and systemctl_word('is-active', f'user@{uid}.service', timeout=5) in ('inactive', 'failed'):
            uncertain = False
    if system and (user or uncertain):
        return {'unit': None, 'scope': 'ambiguous'}
    if system:
        return {'unit': system, 'scope': 'system'}
    if user:
        return {'unit': USER_UNIT, 'scope': 'user'}
    if uncertain:
        return {'unit': None, 'scope': 'unknown'}
    return None


def word(service, *args, timeout=60):
    if not service or not service.get('unit'):
        return ''
    if service.get('scope') == 'system':
        return systemctl_word(*args, service['unit'], timeout=timeout)
    if service.get('scope') == 'user':
        result = _user_run([*args, service['unit']], timeout=timeout)
        return (result.stdout or '').strip().split('\n')[0] if result else ''
    return ''


def ok(service, *args, timeout=60):
    if not service or not service.get('unit'):
        return False
    if service.get('scope') == 'system':
        return systemctl_ok(*args, service['unit'], timeout=timeout)
    if service.get('scope') == 'user':
        result = _user_run([*args, service['unit']], timeout=timeout)
        return bool(result and result.returncode == 0)
    return False


def wait_stopped(service, timeout=360, interval=2):
    """Allow the old gateway drain window; empty/unknown is not confirmation."""
    deadline = time.monotonic() + timeout
    while True:
        gateway = word(service, 'is-active', timeout=10)
        if gateway in ('inactive', 'failed'):
            return gateway
        if gateway not in ('active', 'activating', 'deactivating'):
            return None
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        time.sleep(min(interval, remaining))

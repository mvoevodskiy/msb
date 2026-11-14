"""Bounded transport to the dedicated OpenClaw OS user, not the bot profile.

This module does not decide which installation to trust and is not wired to an
IPC action. Callers must prove the profile/target before invoking it. A secret
may travel on stdin only; no child output is logged. The engine lock must be
held by the caller. Synthetic checks: tests/test_openclaw_exec.py.
"""
import os
import re
import json
import selectors
import subprocess
import time

from const import OC_HOME, STATE_DIR
from openclaw_readiness import _properties
from util import Refused, ensure_root_dir, gid_of, uid_of, write_file

SYSTEMD_RUN = '/usr/bin/systemd-run'
SYSTEMCTL = '/usr/bin/systemctl'
PENDING = 'oc-sandbox.pending'
UNIT_RE = re.compile(r'msb-engine-oc-[0-9a-f]{32}\.service')
PROVIDERS = frozenset(('anthropic', 'openai', 'google', 'openrouter', 'xai', 'kimi', 'moonshot'))
STOP_WAIT_SEC = 10


def _allowed(args, data):
    fixed = {
        ('--version',),
        ('config', 'get', 'gateway.mode', '--json'),
        ('gateway', 'call', 'config.get', '--json'),
        ('models', 'status', '--check'),
    }
    if not data and tuple(args) in fixed:
        return True
    return (len(args) == 5 and args[:4] == ['models', 'auth', 'paste-api-key', '--provider'] and
            args[4] in PROVIDERS and bool(data))


def _failed(reason):
    raise Refused('FAILED', 'failed', {'reason': reason})


def _project(args, code, output, home):
    """Return only fields callers need, never a config dump or auth output."""
    if code != 0 or args[:2] in (['models', 'auth'], ['models', 'status']):
        return code, b''
    if args == ['--version']:
        match = re.search(rb'(?<![0-9])[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(?:-[0-9A-Za-z.]{1,20})?', output)
        if not match:
            _failed('OC_VERSION_RESULT')
        return code, match.group(0)
    try:
        obj = json.loads(output)
    except (ValueError, UnicodeError):
        _failed('OC_COMMAND_RESULT')
    if args == ['gateway', 'call', 'config.get', '--json']:
        expected = home + '/.openclaw/openclaw.json'
        if not isinstance(obj, dict) or obj.get('path') != expected:
            _failed('OC_GATEWAY_IDENTITY')
        return code, json.dumps({'path': expected}).encode()
    if args == ['config', 'get', 'gateway.mode', '--json']:
        if obj not in ('local', 'remote'):
            _failed('OC_GATEWAY_MODE')
        return code, json.dumps(obj).encode()
    _failed('OC_COMMAND_RESULT')


def _unit_state(unit):
    try:
        result = subprocess.run([SYSTEMCTL, 'show', unit, '--property=LoadState', '--property=ActiveState'],
                                env={'PATH': '/usr/bin:/bin', 'LANG': 'C'}, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode or len(result.stdout) > 4096:
        return None
    values = dict(line.split('=', 1) for line in result.stdout.decode('ascii', 'replace').splitlines() if '=' in line)
    return values.get('LoadState'), values.get('ActiveState')


def _stop_unit(unit):
    deadline = time.monotonic() + STOP_WAIT_SEC
    while True:
        try:
            stopped = subprocess.run([SYSTEMCTL, 'stop', unit],
                                     env={'PATH': '/usr/bin:/bin', 'LANG': 'C'}, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
                                     check=False).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            stopped = False
        state = _unit_state(unit)
        # A not-found result is not proof: the killed wrapper's start request
        # may still be queued in PID 1 and register the unit afterwards.
        if stopped and state and state[0] == 'loaded' and state[1] in ('inactive', 'failed'):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.1)


def recover_pending():
    """Stop a possibly orphaned unit before another operation uses the profile."""
    path = os.path.join(STATE_DIR, PENDING)
    kind, values = _properties(path)
    if kind == 'absent':
        return
    if kind != 'present' or not values or set(values) != {'unit'} or not UNIT_RE.fullmatch(values['unit']):
        _failed('OC_SANDBOX_UNCERTAIN')
    if not _stop_unit(values['unit']):
        _failed('OC_SANDBOX_UNCERTAIN')
    os.unlink(path)


def _exchange(process, data, timeout, output_limit):
    deadline = time.monotonic() + timeout
    output = bytearray()
    sent = 0
    with selectors.DefaultSelector() as selector:
        os.set_blocking(process.stdout.fileno(), False)
        selector.register(process.stdout, selectors.EVENT_READ)
        if data:
            os.set_blocking(process.stdin.fileno(), False)
            selector.register(process.stdin, selectors.EVENT_WRITE)
        else:
            process.stdin.close()
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _failed('OC_COMMAND_TIMEOUT')
            for key, _ in selector.select(remaining):
                if key.fileobj is process.stdout:
                    chunk = os.read(process.stdout.fileno(), min(65536, output_limit + 1 - len(output)))
                    if not chunk:
                        selector.unregister(process.stdout)
                        process.stdout.close()
                    else:
                        output.extend(chunk)
                        if len(output) > output_limit:
                            _failed('OC_COMMAND_OUTPUT')
                else:
                    try:
                        written = os.write(process.stdin.fileno(), data[sent:])
                    except BrokenPipeError:
                        written = 0
                    if written == 0:
                        _failed('OC_COMMAND_INPUT')
                    sent += written
                    if sent == len(data):
                        selector.unregister(process.stdin)
                        process.stdin.close()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _failed('OC_COMMAND_TIMEOUT')
        try:
            code = process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            _failed('OC_COMMAND_TIMEOUT')
    return code, bytes(output)


def run_cli(args, *, uid, gid, home=OC_HOME, data=b'', timeout=60, output_limit=1 << 20):
    """Run one OpenClaw CLI command under a transient, recorded user service."""
    if (not isinstance(uid, int) or uid <= 0 or uid != uid_of('openclaw') or
            not isinstance(gid, int) or gid <= 0 or gid != gid_of('openclaw') or home != OC_HOME or
            not isinstance(args, (tuple, list)) or not 0 < len(args) <= 64 or
            any(not isinstance(arg, str) or len(arg) > 2048 or '\x00' in arg for arg in args) or
            not isinstance(data, bytes) or len(data) > 8192 or not 0 < timeout <= 2400 or
            not 0 < output_limit <= 4 * 1024 * 1024):
        raise Refused('BAD_REQUEST')
    args = list(args)
    if not _allowed(args, data):
        raise Refused('BAD_REQUEST')
    ensure_root_dir(STATE_DIR, 0o700)
    recover_pending()
    unit = 'msb-engine-oc-' + os.urandom(16).hex() + '.service'
    pending = os.path.join(STATE_DIR, PENDING)
    write_file(pending, f'unit={unit}\n'.encode(), 0o600)
    runtime = f'/run/user/{uid}'
    prefix = home + '/.openclaw'
    command = [SYSTEMD_RUN, f'--unit={unit}', '--quiet', '--wait', '--pipe',
               '--expand-environment=no', f'--uid={uid}', f'--gid={gid}', f'--slice=user-{uid}.slice',
               '-p', f'RuntimeMaxSec={max(1, int(timeout) + 1)}', '-p', 'TimeoutStopSec=10s',
               '-p', 'ProtectProc=invisible', '-p', 'PrivateTmp=yes', '-p', 'NoNewPrivileges=yes',
               '-p', f'WorkingDirectory={home}', '--', '/usr/bin/env', '-i',
               f'HOME={home}', 'USER=openclaw', 'LOGNAME=openclaw', 'LANG=C.UTF-8',
               f'PATH=/usr/bin:/bin:{prefix}/bin:{prefix}/tools/node/bin',
               f'XDG_RUNTIME_DIR={runtime}', f'DBUS_SESSION_BUS_ADDRESS=unix:path={runtime}/bus',
               f'OPENCLAW_STATE_DIR={prefix}', f'OPENCLAW_CONFIG_PATH={prefix}/openclaw.json',
               prefix + '/bin/openclaw', *args]
    process = None
    settled = False
    try:
        process = subprocess.Popen(command, env={'PATH': '/usr/bin:/bin', 'LANG': 'C'},
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   close_fds=True, start_new_session=True)
        result = _exchange(process, data, timeout, output_limit)
        # --wait returns only after the transient service has finished.
        # A nonzero wrapper exit may also mean the systemd bus failed while
        # the unit continued; explicitly stop/verify it in that case.
        if result[0] != 0 and not _stop_unit(unit):
            _failed('OC_SANDBOX_UNCERTAIN')
        settled = True
        projected = _project(args, result[0], result[1], home)
        os.unlink(pending)
        return projected
    except BaseException as exc:
        if process is None:
            # Popen did not execute systemd-run, so it could not submit a job.
            settled = True
        if process is not None and not settled:
            try:
                process.kill()
                process.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                pass
        if not settled and not _stop_unit(unit):
            _failed('OC_SANDBOX_UNCERTAIN')
        try:
            os.unlink(pending)
        except FileNotFoundError:
            pass
        if isinstance(exc, Refused) or not isinstance(exc, Exception):
            raise
        _failed('OC_COMMAND_START')
    finally:
        if process is not None:
            for stream in (process.stdin, process.stdout):
                if stream and not stream.closed:
                    stream.close()

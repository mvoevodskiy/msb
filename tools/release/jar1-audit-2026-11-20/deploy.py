#!/usr/bin/env python3
"""Install one verified code-only bot/system-engine bundle with rollback."""
import argparse
import ctypes
import fcntl
import hashlib
import grp
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import signal
import stat
import subprocess
import sys
import time

UNIT = 'msb-bot@default.service'
SYSTEM_UNITS = ('msb-engine.path', 'msb-engine.service', 'msb-engine-tick.timer', 'msb-engine-tick.service')
SUPPORT = {'/usr/local/sbin/msb-engine', '/etc/systemd/system/msb-engine.service',
           '/etc/systemd/system/msb-engine.path', '/etc/systemd/system/msb-engine-tick.service',
           '/etc/systemd/system/msb-engine-tick.timer', '/etc/systemd/system/msb-bot@.service'}
RELEASE_ORDER = [('bot', name) for name in (
    'src/autonomy/run-journal.mjs', 'src/agent/bootstrap-workspace.mjs', 'src/agent/codex-bootstrap.mjs',
    'src/autonomy/reminder-runs.mjs', 'src/autonomy/reminder-schedule.mjs', 'src/autonomy/task-removal.mjs',
    'src/monitor/store.mjs', 'src/monitor/poll.mjs', 'src/telegram/attachments.mjs', 'src/telegram/inbox.mjs',
    'src/telegram/response.mjs', 'src/telegram/steer-action.mjs', 'src/telegram/task-control-markers.mjs',
    'src/telegram/voice.mjs', 'ext/adapters/codex-app-server.mjs', 'ext/adapters/codex.mjs',
    'ext/shim/run-turn.mjs', 'src/autonomy/scheduler.mjs', 'src/telegram/bot.mjs')]
ALLOWED = {'lib': set(), 'bin': set(), 'engine': set(), 'bot': {path for _, path in RELEASE_ORDER}}
ADDED = {('bot', 'src/autonomy/run-journal.mjs')}
ANCHOR = {'bot': 'src/engines/client.mjs'}

def bot_owner():
    return (pwd.getpwnam('client').pw_uid, grp.getgrnam('client').gr_gid, 0o664)



def digest(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError('Expected regular file: ' + str(path))
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


NATIVE_CLI = '/home/client/.msb/ext-tools/bin/codex'
NATIVE_WRAPPER = '/home/client/.msb/ext-tools/lib/node_modules/@openai/codex/bin/codex.js'
NATIVE_BINARY = '/home/client/.msb/ext-tools/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'

def cli_fingerprint():
    if str(Path(NATIVE_CLI).resolve(strict=True)) != NATIVE_WRAPPER: raise RuntimeError('Unexpected Codex wrapper target')
    out = {}
    for name, file in (('wrapper_sha256', NATIVE_WRAPPER), ('binary_sha256', NATIVE_BINARY)):
        p = Path(file)
        if str(p.resolve(strict=True)) != file or not p.is_file(): raise RuntimeError('Unexpected Codex file target')
        before = p.stat(); value = digest(p); after = p.stat()
        if any(getattr(before, key) != getattr(after, key) for key in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')):
            raise RuntimeError('Codex file changed during hashing')
        out[name] = value
    return out

def sync_dir(path):
    fd = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def info(path):
    st = Path(path).lstat()
    if not stat.S_ISREG(st.st_mode):
        raise ValueError('Managed file is not regular: ' + str(path))
    return {'sha256': digest(path), 'uid': st.st_uid, 'gid': st.st_gid, 'mode': stat.S_IMODE(st.st_mode)}


def safe_file(root, relative, allow_absent=False):
    root, rel = Path(root), Path(relative)
    if rel.is_absolute() or not rel.parts or any(p in ('', '.', '..') for p in rel.parts):
        raise ValueError('Invalid managed path')
    current = root
    for parent in (root, *root.parents):
        if parent.is_symlink() or not parent.is_dir():
            raise ValueError('Invalid managed root')
    for part in rel.parts:
        current /= part
        try: st = current.lstat()
        except FileNotFoundError:
            if allow_absent and current == root / rel: return current
            raise
        if stat.S_ISLNK(st.st_mode):
            raise ValueError('Symlink in managed path: ' + str(current))
        if current != root / rel and not stat.S_ISDIR(st.st_mode):
            raise ValueError('Managed parent is not a directory')
    if not stat.S_ISREG(current.lstat().st_mode):
        raise ValueError('Managed file is not regular')
    return current


def open_directory(path):
    path = Path(path)
    if not path.is_absolute(): raise ValueError('Directory must be absolute')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
        return fd
    except BaseException:
        os.close(fd); raise


def open_parent(root, relative):
    rel = Path(relative)
    if rel.is_absolute() or not rel.parts or any(part in ('', '.', '..') for part in rel.parts):
        raise ValueError('Invalid managed path')
    fd = open_directory(root)
    try:
        for part in rel.parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
        return fd
    except BaseException:
        os.close(fd); raise


def read_entry(directory, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode): raise RuntimeError('Managed entry is not regular')
        chunks = []
        while True:
            data = os.read(fd, 1024 * 1024)
            if not data: break
            chunks.append(data)
        after = os.fstat(fd)
        if any(getattr(before, key) != getattr(after, key) for key in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')):
            raise RuntimeError('Managed entry changed while reading')
        content = b''.join(chunks)
        return {'sha256': hashlib.sha256(content).hexdigest(), 'uid': after.st_uid, 'gid': after.st_gid,
                'mode': stat.S_IMODE(after.st_mode), 'dev': after.st_dev, 'ino': after.st_ino}, content
    finally: os.close(fd)


def rename_atomic(source_fd, source, target_fd, target, *, exchange=False):
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'darwin':
        func, flags = getattr(libc, 'renameatx_np', None), 2 if exchange else 4
    elif sys.platform.startswith('linux'):
        func, flags = getattr(libc, 'renameat2', None), 2 if exchange else 1
    else: func, flags = None, 0
    if func is None: raise OSError('Atomic rename is unavailable')
    func.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    func.restype = ctypes.c_int
    if func(source_fd, os.fsencode(source), target_fd, os.fsencode(target), flags) != 0:
        code = ctypes.get_errno(); raise OSError(code, os.strerror(code))
    os.fsync(source_fd); os.fsync(target_fd)


def expected_info(owner, identity, sha):
    return {**owner, 'sha256': sha, **identity}


def item_key(item):
    return hashlib.sha256((item['root'] + '/' + item['relative']).encode()).hexdigest()


def atomic_write(root, relative, data, owner, *, create, prepared, before_identity, after_identity):
    live = open_parent(root, relative)
    staged = open_directory(prepared.parent)
    name = Path(relative).name
    try:
        candidate, _ = read_entry(staged, prepared.name)
        after = expected_info(owner, after_identity, hashlib.sha256(data).hexdigest())
        if candidate != after: raise RuntimeError('Prepared candidate changed')
        if create:
            # The staged inode stays in a root-only directory for recovery.
            os.link(prepared.name, name, src_dir_fd=staged, dst_dir_fd=live, follow_symlinks=False)
            os.fsync(live)
        else:
            old, _ = read_entry(live, name)
            before = expected_info(owner, before_identity, owner['sha256'])
            if old != before: raise RuntimeError('Code changed before atomic exchange')
            rename_atomic(staged, prepared.name, live, name, exchange=True)
            quarantined, _ = read_entry(staged, prepared.name)
            if quarantined != before:
                raise RuntimeError('Independent code moved to protected quarantine')
        current, _ = read_entry(live, name)
        if current != after: raise RuntimeError('Published code changed')
    finally:
        os.close(staged); os.close(live)


def restore_existing(root, relative, prepared, owner, before_identity, after_identity, after_sha):
    live, staged = open_parent(root, relative), open_directory(prepared.parent)
    name = Path(relative).name
    try:
        current, _ = read_entry(live, name)
        before = expected_info(owner, before_identity, owner['sha256'])
        after = expected_info(owner, after_identity, after_sha)
        if current == before: return
        if current != after: raise RuntimeError('Refusing to replace independently changed code')
        original, _ = read_entry(staged, prepared.name)
        if original != before: raise RuntimeError('Original code is not in protected quarantine')
        rename_atomic(staged, prepared.name, live, name, exchange=True)
        restored, _ = read_entry(live, name)
        quarantine, _ = read_entry(staged, prepared.name)
        if restored != before or quarantine != after: raise RuntimeError('Rollback exchange mismatch')
    finally: os.close(staged); os.close(live)


def remove_created(root, relative, quarantine, owner, after_identity, after_sha):
    live, qdir = open_parent(root, relative), open_directory(quarantine.parent)
    name = Path(relative).name
    expected = expected_info(owner, after_identity, after_sha)
    try:
        try: current, _ = read_entry(live, name)
        except FileNotFoundError:
            try: held, _ = read_entry(qdir, quarantine.name)
            except FileNotFoundError: return
            if held != expected: raise RuntimeError('Unexpected quarantined file')
            return
        if current != expected: raise RuntimeError('Refusing removal of independently changed new code')
        rename_atomic(live, name, qdir, quarantine.name)
        held, _ = read_entry(qdir, quarantine.name)
        if held != expected: raise RuntimeError('Independent code moved to protected quarantine')
        try: read_entry(live, name)
        except FileNotFoundError: return
        raise RuntimeError('Another file appeared while removing created code')
    finally: os.close(qdir); os.close(live)


def command(*args):
    try:
        return subprocess.run(args, capture_output=True, text=True, check=True, timeout=90).stdout
    except (subprocess.SubprocessError, OSError) as exc:
        raise RuntimeError('System command failed: ' + ' '.join(args[:3])) from exc


def unit_properties(unit, *names):
    text = command('systemctl', 'show', unit, *['-p' + name for name in names])
    return dict(line.split('=', 1) for line in text.splitlines() if '=' in line)


class Host:
    def __init__(self, home=Path('/home/client')):
        self.home = Path(home)
        self.live = self.home / '.msb'

    def admin_idle(self, proc=Path('/proc')):
        # A previously started bot-ctl could otherwise reach a removed helper.
        targets = {'bot-ctl.sh', 'msb-fstab.py'}
        for process in proc.iterdir():
            if not process.name.isdigit(): continue
            try: args = (process / 'cmdline').read_bytes().split(b'\0')
            except FileNotFoundError: continue  # Process exited during the scan.
            if any(Path(os.fsdecode(arg)).name in targets for arg in args if arg):
                raise RuntimeError('An administrative bot-ctl or fstab helper is active')

    def system_idle(self):
        self.admin_idle()
        for unit in SYSTEM_UNITS:
            state = unit_properties(unit, 'ActiveState', 'UnitFileState')
            if state.get('ActiveState') != 'inactive':
                raise RuntimeError('System engine is not inactive: ' + unit)
            if unit.endswith(('.path', '.timer')) and state.get('UnitFileState') != 'disabled':
                raise RuntimeError('System engine trigger is not disabled: ' + unit)
        jobs = command('systemctl', 'list-jobs', '--no-legend')
        if any('msb-engine' in row for row in jobs.splitlines()):
            raise RuntimeError('A system engine job is pending')

    def trusted_admin_directories(self):
        for path in (Path('/'), Path('/usr'), Path('/usr/local'), Path('/usr/local/bin'),
                     Path('/usr/local/lib')):
            st = path.lstat()
            if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
                raise RuntimeError('Untrusted administrative parent directory')

    def marker_absent(self):
        directory = self.live / 'engine'
        if os.path.lexists(directory / 'sleep.default'):
            raise RuntimeError('Existing sleep marker requires separate review')
        lock = directory / 'sleep.default.lock.sqlite'
        if os.path.lexists(lock):
            st = lock.lstat()
            if not stat.S_ISREG(st.st_mode) or st.st_uid != pwd.getpwnam('client').pw_uid or \
               stat.S_IMODE(st.st_mode) != 0o600 or st.st_nlink != 1 or st.st_size != 0:
                raise RuntimeError('Unexpected existing sleep lock')
        if any(os.path.lexists(Path(str(lock) + suffix)) for suffix in ('-journal', '-wal', '-shm')):
            raise RuntimeError('Sleep lock has an active or unexpected sidecar')

    def pending_status(self):
        path = self.live / 'engine/request'
        if not os.path.lexists(path): return None
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            try:
                st = os.fstat(fd)
                if not stat.S_ISREG(st.st_mode) or st.st_uid != pwd.getpwnam('client').pw_uid or \
                   st.st_nlink != 1 or st.st_size > 4096:
                    raise RuntimeError('Unexpected pending system request')
                raw = os.read(fd, 4097)
                if len(raw) > 4096: raise RuntimeError('Unexpected pending system request')
            finally: os.close(fd)
        finally: os.close(directory)
        try:
            def unique(pairs):
                result = {}
                for key, value in pairs:
                    if key in result: raise ValueError('duplicate')
                    result[key] = value
                return result
            request = json.loads(raw, object_pairs_hook=unique)
            if not isinstance(request, dict) or request.get('v') != 1 or isinstance(request.get('v'), bool) or \
               request.get('action') != 'status' or not set(request) <= {'v', 'id', 'action', 'bot_id'} or \
               not isinstance(request.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,64}', request['id']) or \
               ('bot_id' in request and (not isinstance(request['bot_id'], str) or
                not re.fullmatch(r'[A-Za-z0-9_-]{1,32}', request['bot_id']))):
                raise ValueError('not an isolated status request')
        except (ValueError, UnicodeError) as exc:
            raise RuntimeError('Unexpected pending system request') from exc
        return {'sha256': hashlib.sha256(raw).hexdigest(), 'uid': st.st_uid,
                'gid': st.st_gid, 'mode': stat.S_IMODE(st.st_mode)}

    def runtime_identity(self, stage):
        spec = importlib.util.spec_from_file_location('release_runtime', stage / 'runtime.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.runtime_info(stage / 'source/.msb/bot/package-lock.json', self.live / 'bot/node_modules')

    def support_inventory(self, entries):
        if {item['path'] for item in entries} != SUPPORT or len(entries) != len(SUPPORT):
            raise RuntimeError('Unexpected service support inventory')
        for item in entries:
            if digest(item['path']) != item['sha256']:
                raise RuntimeError('System launcher or unit changed: ' + item['path'])

    def network_inode(self, bot=True):
        if not bot: return os.stat('/proc/self/ns/net').st_ino
        pid = int(unit_properties(UNIT, 'MainPID').get('MainPID', '0'))
        if pid <= 0: raise RuntimeError('Bot process is absent')
        return os.stat(f'/proc/{pid}/ns/net').st_ino

    def bot_node_sha(self):
        pid = int(unit_properties(UNIT, 'MainPID').get('MainPID', '0'))
        if pid <= 0: raise RuntimeError('Bot process is absent')
        return hashlib.sha256((Path('/proc') / str(pid) / 'exe').read_bytes()).hexdigest()

    def bot_idle(self, frozen=False):
        fields = unit_properties(UNIT, 'ActiveState', 'MainPID', 'ControlGroup', 'FreezerState')
        pid = int(fields.get('MainPID', '0'))
        if fields.get('ActiveState') != 'active' or pid <= 0:
            raise RuntimeError('Bot is not active')
        if frozen and fields.get('FreezerState') != 'frozen':
            raise RuntimeError('Bot did not freeze')
        group = Path('/sys/fs/cgroup') / fields['ControlGroup'].lstrip('/')
        for procfile in (group / 'cgroup.procs', *group.rglob('cgroup.procs')):
            if any(int(item) != pid for item in procfile.read_text().split()):
                raise RuntimeError('Bot has an active child process')

    def call(self, action):
        command('systemctl', action, UNIT)

    def guard_startup(self):
        override = Path('/etc/systemd/system') / UNIT
        state = unit_properties(UNIT, 'UnitFileState')
        if os.path.lexists(override) or state.get('UnitFileState') != 'enabled':
            raise RuntimeError('Bot instance is already masked or overridden')
        self.call('mask')
        if not override.is_symlink() or os.readlink(override) != '/dev/null':
            raise RuntimeError('Bot startup guard not established')
        sync_dir(override.parent)

    def ensure_guard_startup(self):
        override = Path('/etc/systemd/system') / UNIT
        if os.path.lexists(override):
            if not override.is_symlink() or os.readlink(override) != '/dev/null' or \
               unit_properties(UNIT, 'UnitFileState').get('UnitFileState') != 'masked':
                raise RuntimeError('Bot startup guard is not trustworthy')
            sync_dir(override.parent)
        else:
            self.guard_startup()

    def unguard_startup(self):
        override = Path('/etc/systemd/system') / UNIT
        if os.path.lexists(override):
            if not override.is_symlink() or os.readlink(override) != '/dev/null':
                raise RuntimeError('Bot startup guard was independently changed')
            self.call('unmask')
            sync_dir(override.parent)
        if os.path.lexists(override) or unit_properties(UNIT, 'UnitFileState').get('UnitFileState') != 'enabled':
            raise RuntimeError('Bot startup configuration not restored')

    def bot_active(self):
        state = unit_properties(UNIT, 'ActiveState').get('ActiveState')
        if state not in ('active', 'inactive', 'failed'):
            raise RuntimeError('Unexpected bot state: ' + str(state))
        return state == 'active'

    def bot_stopped(self):
        state = unit_properties(UNIT, 'ActiveState', 'MainPID')
        if state.get('ActiveState') not in ('inactive', 'failed') or int(state.get('MainPID', '0')) != 0:
            raise RuntimeError('Bot did not stop')

    def thaw_if_needed(self):
        if unit_properties(UNIT, 'FreezerState').get('FreezerState') != 'running':
            self.call('thaw')

    def ready(self):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            fields = unit_properties(UNIT, 'MainPID', 'ActiveState')
            pid = int(fields.get('MainPID', '0'))
            if pid and fields.get('ActiveState') == 'active':
                logs = command('journalctl', '_PID=' + str(pid), '-o', 'cat', '--no-pager', '-n', '50')
                if '[msb/bot] @AgentsMania_bot ready' in logs:
                    return
            time.sleep(1)
        raise RuntimeError('Bot polling did not become ready')

    def backup_profile(self, destination):
        spec = importlib.util.spec_from_file_location('release_profile_backup', Path(__file__).with_name('profile_backup.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.backup_profile(self.home, destination)

    def verify_active_session(self, destination):
        spec = importlib.util.spec_from_file_location('release_profile_backup', Path(__file__).with_name('profile_backup.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.assert_active_session_matches(self.home, destination)

    def protected(self):
        files = [self.live / '.env', self.home / '.codex/auth.json', self.home / '.codex/config.toml',
                 self.home / '.claude/.credentials.json', self.home / 'pult-secrets/web.env',
                 self.home / 'pult-secrets/collector.env', self.live / 'engine/request',
                 self.live / 'engine/sleep.default', self.live / 'engine/sleep.default.lock.sqlite',
                 self.live / 'autonomy/tasks.json', self.live / 'monitor/config.json']
        files.extend(self.home / 'workspace' / name for name in ('SOUL.md', 'USER.md', 'MEMORY.md',
                     'MISSION.md', 'GOALS.md', 'PROJECTS.md', 'PREFERENCES.md', 'LEARNED.md', '.iia-bootstrapped'))
        roots = [self.live / 'bots/default', self.home / '.codex/sessions']
        out = {}
        for root in roots:
            if not root.exists():
                out[str(root)] = None
                continue
            for base, dirs, names in os.walk(root, followlinks=False):
                dirs.sort(); names.sort()
                if any((Path(base) / name).is_symlink() for name in dirs):
                    raise RuntimeError('Symlinked protected directory')
                files.extend(Path(base) / name for name in names
                             if name != '.heartbeat-ok' and not name.startswith('ext-providers.json.lock.sqlite'))
        for file in files:
            if file.is_symlink():
                out[str(file)] = {'link': os.readlink(file), 'target': digest(file.resolve())}
            elif file.exists():
                out[str(file)] = info(file)
            else:
                out[str(file)] = None
        return out


class Deployment:
    def __init__(self, stage, backup, roots, host, manifest_sha, report_sha):
        self.stage, self.backup = Path(stage), Path(backup)
        self.roots, self.host = {k: Path(v) for k, v in roots.items()}, host
        if digest(self.stage / 'manifest.json') != manifest_sha:
            raise ValueError('Manifest hash mismatch')
        self.manifest = json.loads((self.stage / 'manifest.json').read_text())
        report = self.stage / 'test-home/results/verification.json'
        if digest(report) != report_sha:
            raise ValueError('Verification report hash mismatch')
        verified = json.loads(report.read_text())
        if not verified.get('passed') or verified.get('manifest_sha256') != manifest_sha or \
           verified.get('source_commit') != self.manifest['source_commit'] or \
           verified.get('source_archive_sha256') != self.manifest['source_archive_sha256']:
            raise ValueError('Candidate has no matching scoped verification')
        self.native_proof = verified.get('native_isolated_verification')
        proof = self.native_proof
        if not isinstance(proof, dict) or set(proof) != {'interfaces', 'cli_path', 'cli_version', 'host_netns_inode', 'test_netns_inode', 'wrapper_sha256', 'binary_sha256'} or \
           proof['interfaces'] != ['lo'] or proof['cli_path'] != NATIVE_CLI or proof['cli_version'] != 'codex-cli 0.166.0' or \
           any(type(proof[k]) is not int or proof[k] <= 0 for k in ('host_netns_inode', 'test_netns_inode')) or proof['host_netns_inode'] == proof['test_netns_inode'] or \
           any(not isinstance(proof[k], str) or not re.fullmatch(r'[0-9a-f]{64}', proof[k]) for k in ('wrapper_sha256', 'binary_sha256')):
            raise ValueError('Required isolated native steer verification is absent')
        required = {'node-0', 'node-1', 'node-2', 'node-3', 'service-labels', 'bot-status-view',
                    'steer-targeted', 'steer-native-isolated', 'intro-safe', 'audit-targeted', 'scheduler-safe', 'legacy-timer-conversation-safe', 'backlog-targeted', 'recurring-safe', 'menu-safe', 'test_bot_off_marker', 'test_ipc_reference',
                    'test_private_state', 'test_pult_routing', 'test_client_markers', 'fstab-compat'}
        required.update('syntax-' + item['relative'].replace('/', '_') for item in self.manifest['files'])
        checks = verified.get('checks', [])
        if len(checks) != len(required) or {item.get('suite') for item in checks} != required or \
           any(item.get('exit_code') != 0 or (not item['suite'].startswith('syntax-') and item['suite'] != 'test_client_markers' and
               (not isinstance(item.get('passed'), int) or item['passed'] <= 0)) for item in checks):
            raise ValueError('Scoped verification is incomplete')
        native = next(item for item in checks if item['suite'] == 'steer-native-isolated')
        if (native.get('tests'), native.get('passed'), native.get('skipped')) != (1, 1, 0):
            raise ValueError('Native steer verification is incomplete')
        focused = next(item for item in checks if item['suite'] == 'steer-targeted')
        if (focused.get('tests'), focused.get('passed'), focused.get('skipped')) != (95, 95, 0):
            raise ValueError('Steer and journal verification is incomplete')
        for suite, count in (('intro-safe', 43), ('audit-targeted', 133), ('scheduler-safe', 19)):
            row = next(item for item in checks if item['suite'] == suite)
            if (row.get('tests'), row.get('passed'), row.get('skipped')) != (count, count, 0):
                raise ValueError('Audited regression verification is incomplete: ' + suite)
        root_cases = next(item for item in checks if item['suite'] == 'test_client_markers')
        if (root_cases.get('tests'), root_cases.get('passed'), root_cases.get('skipped')) != (7, 0, 7):
            raise ValueError('Distinct-UID target skips are not accounted for')
        counts = {item['suite']: item.get('passed') for item in checks}
        if counts['service-labels'] != 3 or counts['bot-status-view'] != 1 or \
           counts['legacy-timer-conversation-safe'] != 23 or counts['backlog-targeted'] != 291 or counts['recurring-safe'] != 8 or counts['menu-safe'] != 10 or counts['test_bot_off_marker'] != 9:
            raise ValueError('Focused verification did not run expected tests')
        fstab = next(item for item in checks if item['suite'] == 'fstab-compat')
        fstab_skips = fstab.get('skipped_cases')
        if fstab.get('tests') != 16 or fstab.get('passed', 0) < 15 or fstab.get('skipped', 0) > 1 or \
           fstab.get('passed', 0) + fstab.get('skipped', 0) != 16 or \
           fstab_skips not in ([], ['test_rewrite_preserves_posix_acl']) or len(fstab_skips) != fstab.get('skipped'):
            raise ValueError('fstab compatibility verification is incomplete')
        if digest(self.stage / 'source.tar.gz') != self.manifest['source_archive_sha256']:
            raise ValueError('Source archive changed')
        if digest(self.stage / 'verify.py') != self.manifest['verify_sha256'] or \
           digest(self.stage / 'deploy.py') != self.manifest['deploy_sha256'] or \
           digest(self.stage / 'runtime.py') != self.manifest['runtime_sha256'] or \
           digest(self.stage / 'profile_backup.py') != self.manifest['profile_backup_sha256'] or \
           digest(self.stage / 'launcher.py') != self.manifest['launcher_sha256']:
            raise ValueError('Operator code changed')
        self.environment = verified.get('environment')
        if not isinstance(self.environment, dict): raise ValueError('No verified runtime identity')
        by_root = {root: set() for root in ALLOWED}
        for item in self.manifest['files']:
            root, relative = item['root'], item['relative']
            if root not in by_root or relative in by_root[root]: raise ValueError('Duplicate or unknown target')
            by_root[root].add(relative)
            if digest(self.stage / 'payload' / root / relative) != item['after_sha256']:
                raise ValueError('Payload hash mismatch')
        if [(item['root'], item['relative']) for item in self.manifest['files']] != RELEASE_ORDER:
            raise ValueError('Unsafe publication order')
        if by_root != ALLOWED:
            raise ValueError('Release target list changed')
        if {(item['root'], item['relative']) for item in self.manifest['files'] if item['before_sha256'] is None} != ADDED:
            raise ValueError('Unexpected added-file list')
        inventory = self.manifest.get('baseline_inventory', [])
        inventory_map = {(item.get('root'), item.get('relative')): item.get('sha256') for item in inventory}
        if not inventory or len(inventory_map) != len(inventory) or any(
            (item['root'], item['relative']) in inventory_map if item['before_sha256'] is None else
            inventory_map.get((item['root'], item['relative'])) != item['before_sha256']
            for item in self.manifest['files']):
            raise ValueError('Incomplete baseline inventory')

    def check_native_identity(self, bot=True):
        if self.host.network_inode(bot=bot) != self.native_proof['host_netns_inode']:
            raise RuntimeError('Host network namespace changed since verification')
        if cli_fingerprint() != {key: self.native_proof[key] for key in ('wrapper_sha256', 'binary_sha256')}:
            raise RuntimeError('Codex executable changed since verification')

    def check(self):
        self.check_native_identity()
        self.host.system_idle()
        self.host.trusted_admin_directories()
        self.host.marker_absent()
        self.host.bot_idle()
        self.host.support_inventory(self.manifest['support_files'])
        self.pending = self.host.pending_status()
        if self.host.runtime_identity(self.stage) != self.environment:
            raise RuntimeError('Runtime or dependency identity changed since testing')
        if self.host.bot_node_sha() != self.environment.get('node_sha256'):
            raise RuntimeError('Bot is running a different Node executable')
        self.check_inventory()
        anchor = info(safe_file(self.roots['bot'], ANCHOR['bot']))
        if (anchor['uid'], anchor['gid'], anchor['mode']) != bot_owner():
            raise RuntimeError('Unexpected bot anchor ownership or mode')
        if info(safe_file(self.roots['bin'], 'bot-ctl.sh'))['uid'] != os.geteuid() or \
           info(safe_file(self.roots['bin'], 'bot-ctl.sh'))['gid'] != os.getegid() or \
           info(safe_file(self.roots['bin'], 'bot-ctl.sh'))['mode'] != 0o755:
            raise RuntimeError('Unexpected administrative script owner or mode')
        backup_fd = open_directory(self.backup.parent)
        try: backup_dev = os.fstat(backup_fd).st_dev
        finally: os.close(backup_fd)
        for item in self.manifest['files']:
            target = safe_file(self.roots[item['root']], item['relative'], allow_absent=item['before_sha256'] is None)
            if (item['before_sha256'] is None and os.path.lexists(target)) or \
               (item['before_sha256'] is not None and digest(target) != item['before_sha256']):
                raise RuntimeError('Live code differs from expected baseline: ' + item['source'])
            directory = open_parent(self.roots[item['root']], item['relative'])
            try:
                if os.fstat(directory).st_dev != backup_dev:
                    raise RuntimeError('Rollback quarantine is on another filesystem')
            finally: os.close(directory)

    def check_inventory(self, after=False):
        changed = {(item['root'], item['relative']): item for item in self.manifest['files']}
        known = {(item['root'], item['relative']) for item in self.manifest['baseline_inventory']}
        if after: known |= ADDED
        for item in self.manifest.get('baseline_inventory', []):
            root, relative = item['root'], item['relative']
            if root not in self.roots: raise ValueError('Unknown inventory root')
            target = safe_file(self.roots[root], relative)
            update = changed.get((root, relative))
            expected = update['after_sha256'] if after and update else item['sha256']
            if digest(target) != expected:
                raise RuntimeError('Installed code differs from verified inventory: ' + relative)
        if after:
            for key in ADDED:
                item = changed[key]
                if digest(safe_file(self.roots[key[0]], key[1])) != item['after_sha256']:
                    raise RuntimeError('Installed new code differs from verified payload: ' + key[1])
        paused = re.compile(r'openclaw|native.?oc|(?:^|[/_-])oc(?:[/_.-]|$)', re.I)
        for root, subdir in (('bot', 'src'), ('bot', 'shared'), ('bot', 'ext'), ('engine', '')):
            base = self.roots[root] / subdir
            if not base.exists(): continue
            for directory, dirs, names in os.walk(base, followlinks=False):
                dirs[:] = [d for d in dirs if d not in ('tests', '__pycache__', 'node_modules') and not paused.search(d)]
                if any((Path(directory) / name).is_symlink() for name in dirs):
                    raise RuntimeError('Symlinked runtime code directory')
                for name in names:
                    path = Path(directory) / name
                    relative = path.relative_to(self.roots[root]).as_posix()
                    if paused.search(relative): continue
                    if path.suffix not in ('.mjs', '.cjs', '.js', '.py', '.json', '.md') and relative != 'ext/shim/bin/claude':
                        continue
                    if (root, relative) not in known:
                        raise RuntimeError('Unexpected runtime code: ' + root + '/' + relative)

    def save_backup(self):
        self.backup.mkdir(mode=0o700, parents=False, exist_ok=False)
        sync_dir(self.backup.parent)
        (self.backup / 'prepared').mkdir(mode=0o700)
        (self.backup / 'quarantine').mkdir(mode=0o700)
        entries = []
        for item in self.manifest['files']:
            added = item['before_sha256'] is None
            target = safe_file(self.roots[item['root']], item['relative'], allow_absent=added)
            if added:
                if os.path.lexists(target): raise RuntimeError('New code target appeared before backup')
                if (item['root'], item['relative']) not in ADDED: raise RuntimeError('Unexpected added target')
                uid, gid, mode = bot_owner()
                old = {'sha256': None, 'uid': uid, 'gid': gid, 'mode': mode}
                before_identity = None
            else:
                directory = open_parent(self.roots[item['root']], item['relative'])
                try: observed, content = read_entry(directory, target.name)
                finally: os.close(directory)
                old = {key: observed[key] for key in ('sha256', 'uid', 'gid', 'mode')}
                before_identity = {key: observed[key] for key in ('dev', 'ino')}
                if old['sha256'] != item['before_sha256']:
                    raise RuntimeError('Code changed before backup')
                if item['root'] == 'bin' and (old['uid'], old['gid'], old['mode']) != (os.geteuid(), os.getegid(), 0o755):
                    raise RuntimeError('Administrative script ownership changed before backup')
                copy = self.backup / 'code' / item['root'] / item['relative']
                copy.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with copy.open('xb') as f:
                    f.write(content)
                    f.flush()
                    os.fchmod(f.fileno(), 0o600)
                    os.fsync(f.fileno())
                sync_dir(copy.parent)
                if digest(copy) != old['sha256']: raise RuntimeError('Backup verification failed')
            payload = self.stage / 'payload' / item['root'] / item['relative']
            if digest(payload) != item['after_sha256']: raise RuntimeError('Payload changed before backup')
            prepared = self.backup / 'prepared' / item_key(item)
            with prepared.open('xb') as f:
                f.write(payload.read_bytes()); f.flush()
                os.fchown(f.fileno(), old['uid'], old['gid']); os.fchmod(f.fileno(), old['mode'])
                os.fsync(f.fileno())
            directory = open_directory(prepared.parent)
            try: staged, _ = read_entry(directory, prepared.name)
            finally: os.close(directory)
            if any(staged[key] != old[key] for key in ('uid', 'gid', 'mode')) or staged['sha256'] != item['after_sha256']:
                raise RuntimeError('Prepared file mismatch')
            after_identity = {key: staged[key] for key in ('dev', 'ino')}
            entries.append({**item, 'owner': old, 'before_identity': before_identity, 'after_identity': after_identity})
        record = {'source_commit': self.manifest['source_commit'], 'files': entries}
        file = self.backup / 'metadata.json'
        with file.open('x') as f:
            f.write(json.dumps(record, indent=2) + '\n')
            f.flush()
            os.fchmod(f.fileno(), 0o600)
            os.fsync(f.fileno())
        for directory in sorted((p for p in self.backup.rglob('*') if p.is_dir()),
                                key=lambda p: len(p.parts), reverse=True):
            sync_dir(directory)
        sync_dir(self.backup)
        return record

    def record_guard(self, restart_after=True):
        marker = self.backup / 'guard.pending'
        temporary = self.backup / ('.guard-' + secrets.token_hex(12))
        try:
            with temporary.open('x') as f:
                f.write(json.dumps({'restart_after': bool(restart_after)}) + '\n')
                f.flush()
                os.fchmod(f.fileno(), 0o600)
                os.fsync(f.fileno())
            os.link(temporary, marker, follow_symlinks=False)
            sync_dir(self.backup)
        finally:
            try: temporary.unlink()
            except FileNotFoundError: pass
            sync_dir(self.backup)

    def guard_startup(self, restart_after=True):
        self.record_guard(restart_after=restart_after)
        self.host.guard_startup()

    def unguard_startup(self):
        marker = self.backup / 'guard.pending'
        if marker.exists():
            self.host.unguard_startup()

    def finish_guard(self):
        marker = self.backup / 'guard.pending'
        if marker.exists():
            marker.unlink()
            sync_dir(self.backup)

    def validate_backup(self, record):
        st = self.backup.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o077:
            raise RuntimeError('Untrusted backup directory')
        if record.get('source_commit') != self.manifest['source_commit'] or \
           len(record.get('files', [])) != len(self.manifest['files']):
            raise RuntimeError('Backup record does not match release')
        for name in ('prepared', 'quarantine'):
            folder = self.backup / name
            mode = folder.lstat()
            if not stat.S_ISDIR(mode.st_mode) or mode.st_uid != os.geteuid() or mode.st_mode & 0o077:
                raise RuntimeError('Untrusted transaction directory')
        expected = {(item['root'], item['relative']): item for item in self.manifest['files']}
        seen = set()
        for item in record['files']:
            key = (item.get('root'), item.get('relative'))
            if key not in expected or key in seen:
                raise RuntimeError('Unexpected backup record')
            seen.add(key)
            if any(item.get(name) != value for name, value in expected[key].items()):
                raise RuntimeError('Backup metadata changed')
            if set(item) != set(expected[key]) | {'owner', 'before_identity', 'after_identity'}:
                raise RuntimeError('Unexpected backup metadata fields')
            owner = item.get('owner', {})
            if set(owner) != {'sha256', 'uid', 'gid', 'mode'} or owner['sha256'] != item['before_sha256'] or \
               any(not isinstance(owner[key], int) or owner[key] < 0 for key in ('uid', 'gid', 'mode')) or owner['mode'] > 0o7777:
                raise RuntimeError('Invalid backup ownership')
            added = item['before_sha256'] is None
            if added and (owner['uid'], owner['gid'], owner['mode']) != bot_owner():
                raise RuntimeError('Invalid new bot file ownership')
            if key[0] in ('bin', 'lib') and (owner['uid'], owner['gid'], owner['mode']) != \
               (os.geteuid(), os.getegid(), 0o755 if key[0] == 'bin' else 0o644):
                raise RuntimeError('Invalid privileged backup ownership')
            for name in ('before_identity', 'after_identity'):
                value = item.get(name)
                if name == 'before_identity' and added:
                    if value is not None: raise RuntimeError('Unexpected prior file identity')
                elif not isinstance(value, dict) or set(value) != {'dev', 'ino'} or \
                     any(not isinstance(value[k], int) or value[k] < 0 for k in value):
                    raise RuntimeError('Invalid file identity')
            prepared = self.backup / 'prepared' / item_key(item)
            staged_fd = open_directory(prepared.parent)
            live_fd = open_parent(self.roots[item['root']], item['relative'])
            try:
                staged, _ = read_entry(staged_fd, prepared.name)
                try: current, _ = read_entry(live_fd, Path(item['relative']).name)
                except FileNotFoundError: current = None
            finally: os.close(staged_fd); os.close(live_fd)
            after = expected_info(owner, item['after_identity'], item['after_sha256'])
            if added:
                if staged != after or current not in (None, after):
                    raise RuntimeError('Refusing rollback of independently changed new code')
                qdir = open_directory(self.backup / 'quarantine')
                try:
                    try: quarantined, _ = read_entry(qdir, item_key(item))
                    except FileNotFoundError: quarantined = None
                finally: os.close(qdir)
                if quarantined is not None and quarantined != after:
                    raise RuntimeError('Unexpected quarantined file')
            else:
                before = expected_info(owner, item['before_identity'], item['before_sha256'])
                if not ((current == before and staged == after) or (current == after and staged == before)):
                    raise RuntimeError('Refusing rollback of independently changed code')
            if not added:
                copy = safe_file(self.backup / 'code' / item['root'], item['relative'])
                copy_info = info(copy)
                if copy_info['sha256'] != item['before_sha256'] or copy_info['uid'] != os.geteuid() or copy_info['mode'] & 0o077:
                    raise RuntimeError('Rollback backup is corrupt')

    def restore(self, record):
        self.host.trusted_admin_directories()
        self.validate_backup(record)
        if [(item['root'], item['relative']) for item in record['files']] != RELEASE_ORDER:
            raise RuntimeError('Unsafe rollback order')
        for item in reversed(record['files']):
            prepared = self.backup / 'prepared' / item_key(item)
            if item['before_sha256'] is None:
                quarantine = self.backup / 'quarantine' / item_key(item)
                remove_created(self.roots[item['root']], item['relative'], quarantine,
                               item['owner'], item['after_identity'], item['after_sha256'])
            else:
                restore_existing(self.roots[item['root']], item['relative'], prepared, item['owner'],
                                 item['before_identity'], item['after_identity'], item['after_sha256'])

    def verify_restored(self, record):
        self.validate_backup(record)
        self.check_inventory()
        for item in record['files']:
            directory = open_parent(self.roots[item['root']], item['relative'])
            try:
                try: current, _ = read_entry(directory, Path(item['relative']).name)
                except FileNotFoundError: current = None
            finally: os.close(directory)
            if item['before_sha256'] is None:
                if current is not None: raise RuntimeError('New code remains after rollback')
            elif current != expected_info(item['owner'], item['before_identity'], item['before_sha256']):
                raise RuntimeError('Original code identity changed after rollback')

    def verify_applied(self, record):
        # The inventory fixes the expected contents; backup validation also
        # checks each published inode and its protected counterpart.
        self.validate_backup(record)
        self.check_inventory(after=True)

    def rollback(self):
        metadata = safe_file(self.backup, 'metadata.json')
        meta_info = info(metadata)
        if meta_info['uid'] != os.geteuid() or meta_info['mode'] & 0o077:
            raise RuntimeError('Untrusted backup metadata')
        record = json.loads(metadata.read_text())
        self.host.system_idle()
        self.validate_backup(record)
        active = self.host.bot_active()
        pending_guard = (self.backup / 'guard.pending').exists()
        restart_after = active
        if pending_guard:
            guard = safe_file(self.backup, 'guard.pending')
            guard_info = info(guard)
            if guard_info['uid'] != os.geteuid() or guard_info['mode'] & 0o077:
                raise RuntimeError('Untrusted startup guard')
            pending = json.loads(guard.read_text())
            if set(pending) != {'restart_after'} or not isinstance(pending['restart_after'], bool):
                raise RuntimeError('Invalid startup guard')
            restart_after = pending['restart_after']
        frozen = stopped = modified = created_guard = False
        try:
            if active:
                if pending_guard: self.host.thaw_if_needed()
                self.host.bot_idle()
                if not pending_guard:
                    self.record_guard(restart_after=True)
                    pending_guard = created_guard = True
                frozen = True
                self.host.call('freeze')
                self.host.bot_idle(frozen=True)
                snapshot = self.host.protected()
                self.host.call('thaw')
                frozen = False
                self.host.bot_idle()
                stopped = True
                self.host.call('stop')
                self.host.bot_stopped()
                if self.host.protected() != snapshot:
                    raise RuntimeError('Protected data changed while stopping for rollback')
            else:
                self.host.bot_stopped()
                snapshot = self.host.protected()
            if not pending_guard:
                pending_guard = True
                self.guard_startup(restart_after=active)
            else:
                self.host.ensure_guard_startup()
            self.host.system_idle()
            self.host.bot_stopped()
            modified = True
            self.restore(record)
            self.verify_restored(record)
            if self.host.protected() != snapshot:
                raise RuntimeError('Protected data changed during rollback')
            self.unguard_startup()
            if restart_after:
                self.host.call('start')
                self.host.ready()
                self.verify_restored(record)
                if self.host.protected() != snapshot:
                    raise RuntimeError('Protected data changed after rollback startup')
            self.finish_guard()
            return {'restored': len(record['files']), 'polling': 'ready' if restart_after else 'unchanged-inactive'}
        except BaseException as original:
            if frozen: self.host.thaw_if_needed()
            if modified:
                guard_errors = []
                try:
                    if not (self.backup / 'guard.pending').exists():
                        self.record_guard(restart_after=restart_after)
                    self.host.ensure_guard_startup()
                except BaseException as exc:
                    guard_errors.append('startup guard: ' + str(exc))
                try:
                    self.host.call('stop'); self.host.bot_stopped()
                except BaseException as exc:
                    guard_errors.append('stop: ' + str(exc))
                if guard_errors:
                    raise RuntimeError('Rollback failed; ' + '; '.join(guard_errors)) from original
            elif active and stopped:
                try:
                    restart_snapshot = self.host.protected()
                    # A failed recovery may only restart a complete known tree,
                    # never an independently changed or partially restored one.
                    try:
                        self.verify_applied(record)
                        verify_restart_code = self.verify_applied
                    except (RuntimeError, ValueError, OSError):
                        self.verify_restored(record)
                        verify_restart_code = self.verify_restored
                    if pending_guard: self.unguard_startup()
                    self.host.call('start')
                    self.host.ready()
                    verify_restart_code(record)
                    if self.host.protected() != restart_snapshot:
                        raise RuntimeError('Protected data changed after rollback startup')
                    if pending_guard: self.finish_guard()
                except BaseException as restart_error:
                    guard_errors = []
                    try:
                        if not (self.backup / 'guard.pending').exists(): self.record_guard(restart_after=True)
                        self.host.ensure_guard_startup()
                    except BaseException as guard_error:
                        guard_errors.append('startup guard: ' + str(guard_error))
                    try:
                        self.host.call('stop'); self.host.bot_stopped()
                    except BaseException as stop_error:
                        guard_errors.append('stop: ' + str(stop_error))
                    if guard_errors:
                        raise RuntimeError('Rollback restart guard failed: ' + '; '.join(guard_errors)) from restart_error
                    raise RuntimeError('Rollback restart failed; bot stopped with guard') from restart_error
            elif active and created_guard:
                self.unguard_startup()
                self.finish_guard()
            # A partly restored tree must not be started; the same command can
            # be retried after the cause is fixed, with the complete backup.
            raise

    def apply(self):
        self.check()
        record = self.save_backup()
        stopped = frozen = modified = guarded = False
        try:
            guarded = True
            self.record_guard()
            frozen = True
            self.host.call('freeze')
            self.host.bot_idle(frozen=True)
            if self.host.bot_node_sha() != self.environment.get('node_sha256'):
                raise RuntimeError('Bot Node executable changed during preflight')
            snapshot = self.host.protected()
            if self.host.pending_status() != self.pending:
                raise RuntimeError('Pending request changed during preflight')
            self.host.call('thaw')
            frozen = False
            self.host.bot_idle()
            self.host.system_idle()
            self.host.support_inventory(self.manifest['support_files'])
            self.check_native_identity()
            stopped = True
            self.host.call('stop')
            self.host.bot_stopped()
            if self.host.protected() != snapshot:
                raise RuntimeError('Protected data changed while stopping')
            self.host.backup_profile(self.backup / 'profile')
            if self.host.protected() != snapshot:
                raise RuntimeError('Protected data changed during profile backup')
            self.host.system_idle()
            self.host.marker_absent()
            if self.host.pending_status() != self.pending or self.host.runtime_identity(self.stage) != self.environment:
                raise RuntimeError('Pending request or runtime changed before installation')
            self.check_inventory()
            self.host.guard_startup()
            self.host.bot_stopped()
            self.host.trusted_admin_directories()
            self.host.system_idle()
            for item in record['files']:
                added = item['before_sha256'] is None
                target = safe_file(self.roots[item['root']], item['relative'], allow_absent=added)
                if (added and os.path.lexists(target)) or (not added and info(target) != item['owner']):
                    raise RuntimeError('Code drift before installation')
                payload = self.stage / 'payload' / item['root'] / item['relative']
                if digest(payload) != item['after_sha256']: raise RuntimeError('Payload changed')
                modified = True  # publication may succeed before a later fsync fails
                atomic_write(self.roots[item['root']], item['relative'], payload.read_bytes(), item['owner'],
                             create=added, prepared=self.backup / 'prepared' / item_key(item),
                             before_identity=item['before_identity'], after_identity=item['after_identity'])
                expected = {**item['owner'], 'sha256': item['after_sha256']}
                if info(target) != expected: raise RuntimeError('Installed file verification failed')
            if self.host.protected() != snapshot:
                raise RuntimeError('Protected data changed during installation')
            self.host.system_idle()
            self.host.support_inventory(self.manifest['support_files'])
            self.verify_applied(record)
            self.host.marker_absent()
            if self.host.pending_status() != self.pending or self.host.runtime_identity(self.stage) != self.environment:
                raise RuntimeError('Pending request or runtime changed during installation')
            self.verify_applied(record)
            self.check_native_identity(bot=False)
            self.unguard_startup()
            self.host.call('start')
            self.host.ready()
            self.check_native_identity()
            self.host.verify_active_session(self.backup / 'profile')
            if self.host.protected() != snapshot:
                raise RuntimeError('Protected data changed during startup')
            self.host.system_idle()
            self.host.support_inventory(self.manifest['support_files'])
            if self.host.bot_node_sha() != self.environment.get('node_sha256'):
                raise RuntimeError('Bot started with a different Node executable')
            if self.host.pending_status() != self.pending:
                raise RuntimeError('Pending request changed after startup')
            self.verify_applied(record)
            self.finish_guard()
            guarded = False
            return {'source_commit': record['source_commit'], 'files': len(record['files']),
                    'backup': str(self.backup), 'polling': 'ready'}
        except BaseException as original:
            errors = []
            thawed = True
            if frozen:
                try: self.host.thaw_if_needed()
                except BaseException as exc:
                    thawed = False
                    errors.append('thaw failed: ' + str(exc))
            if stopped:
                try:
                    self.host.call('stop')
                    self.host.bot_stopped()
                    self.host.system_idle()
                    if modified:
                        if not (self.backup / 'guard.pending').exists(): self.record_guard()
                        guarded = True
                        self.host.ensure_guard_startup()
                        self.host.bot_stopped()
                        self.restore(record)
                        self.verify_restored(record)
                        if self.host.protected() != snapshot:
                            raise RuntimeError('Protected data changed during automatic rollback')
                    else:
                        # Before any code write, retain an independent profile
                        # change and compare restart against its current state.
                        # A code drift must not be mistaken for profile-only drift.
                        self.verify_restored(record)
                        snapshot = self.host.protected()
                    if guarded: self.unguard_startup()
                    self.host.call('start')
                    self.host.ready()
                    self.verify_restored(record)
                    if modified: self.host.verify_active_session(self.backup / 'profile')
                    if self.host.protected() != snapshot:
                        raise RuntimeError('Protected data changed after automatic rollback startup')
                    if guarded: self.finish_guard()
                except BaseException as exc:
                    errors.append('rollback failed: ' + str(exc))
                    try:
                        if not (self.backup / 'guard.pending').exists(): self.record_guard()
                        self.host.ensure_guard_startup()
                    except BaseException as guard_error:
                        errors.append('startup guard failed: ' + str(guard_error))
                    try:
                        self.host.call('stop'); self.host.bot_stopped()
                    except BaseException as stop_error:
                        errors.append('stop failed: ' + str(stop_error))
            elif guarded and thawed:
                try:
                    self.unguard_startup()
                    self.finish_guard()
                except BaseException as exc: errors.append('guard cleanup failed: ' + str(exc))
            if errors:
                raise RuntimeError('Installation failed: ' + str(original) + '; ' + '; '.join(errors)) from original
            raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', required=True)
    parser.add_argument('--backup', required=True)
    parser.add_argument('--manifest-sha', required=True)
    parser.add_argument('--report-sha', required=True)
    operation = parser.add_mutually_exclusive_group()
    operation.add_argument('--apply', action='store_true')
    operation.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    stage, backup = Path(args.stage).absolute(), Path(args.backup).absolute()
    if os.geteuid() != 0 or os.getegid() != 0 or stage.parent != Path('/var/tmp') or backup.parent != Path('/var/lib/msb-ops/releases'):
        raise RuntimeError('Unexpected deployment context')
    for directory in (stage, Path('/'), Path('/var'), Path('/var/lib'), Path('/var/lib/msb-ops'), backup.parent):
        st = directory.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError('Untrusted deployment directory')
    allowed_links = {
        'source/.msb/bot/node_modules': '/home/client/.msb/bot/node_modules',
        'source/overlay/bot/node_modules': '/home/client/.msb/bot/node_modules',
        'source/overlay/bot/shared': '../../.msb/bot/shared',
    }
    for file in stage.rglob('*'):
        st = file.lstat()
        if file.name == '__pycache__': raise RuntimeError('Unexpected Python cache in stage')
        if stat.S_ISLNK(st.st_mode) and allowed_links.get(file.relative_to(stage).as_posix()) != os.readlink(file):
            raise RuntimeError('Unexpected stage symlink: ' + str(file))
        if st.st_uid != 0 or (not stat.S_ISLNK(st.st_mode) and st.st_mode & 0o022):
            raise RuntimeError('Unsealed stage: ' + str(file))
    def interrupt(signum, _frame):
        raise InterruptedError('signal ' + str(signum))
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGHUP, interrupt)
    release = Deployment(stage, backup, {'bot': '/home/client/.msb/bot',
        'engine': '/usr/local/lib/msb-engine', 'bin': '/usr/local/bin', 'lib': '/usr/local/lib'}, Host(), args.manifest_sha, args.report_sha)
    if args.rollback:
        print(json.dumps(release.rollback()))
    elif not args.apply:
        release.check()
        print(json.dumps({'operation': 'read-only plan', 'files': len(release.manifest['files'])}))
    else:
        print(json.dumps(release.apply()))


if __name__ == '__main__':
    if os.geteuid() != 0: raise RuntimeError('Root is required')
    lock = open_directory('/var/lib/msb-ops/releases')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        main()
    finally:
        os.close(lock)

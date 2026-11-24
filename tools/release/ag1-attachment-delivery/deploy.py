#!/usr/bin/env python3
"""AG1-only guarded publication and recovery of three reviewed code files."""

import argparse
import fcntl
import grp
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import signal
import socket
import stat
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import contract
import protected
import stage as stage_checks
import transaction
import verify

P = transaction.P


def host_identity(*, allow_masked=False):
    if os.geteuid() != 0 or socket.gethostname() != contract.HOST:
        raise RuntimeError('This operator requires root on AG1')
    props = P.unit_properties(contract.UNIT, 'User', 'EnvironmentFiles', 'UnitFileState')
    masked = allow_masked and props.get('UnitFileState') == 'masked'
    override = Path('/etc/systemd/system') / contract.UNIT
    if masked and (not override.is_symlink() or os.readlink(override) != '/dev/null'):
        raise RuntimeError('Masked AG1 unit does not have the expected guard')
    if not masked and (props.get('User') != contract.OWNER or not re.search(
        r'(?<!\S)/home/client/\.msb/bots/default/\.env(?=\s|$)', props.get('EnvironmentFiles', ''))):
        raise RuntimeError('AG1 unit owner or per-bot environment changed')
    output = P.command('systemctl', 'list-units', '--type=service', '--all', '--plain',
                       '--no-legend', '--no-pager', 'msb-bot@*')
    units = {row.split()[0] for row in output.splitlines() if row.strip()}
    if units != {contract.UNIT} and not (masked and not units):
        raise RuntimeError('Unexpected bot instances on AG1')


def check_code_processes(bot_pid):
    """Reject visible competing bot processes and open code writers.

    This snapshot cannot prove that Telegram's in-memory queue is empty or that
    an unrelated writer cannot start after the scan.
    """
    prefixes = tuple(str(contract.BOT / part) + '/' for part in ('src', 'shared', 'ext'))
    protected_prefixes = tuple(str(protected.HOME / part) + '/' for part in protected.DIRECTORIES)
    protected_files = {str(protected.HOME / part) for part in protected.FILES}
    for process in Path('/proc').iterdir():
        if not process.name.isdigit(): continue
        pid = int(process.name)
        try:
            args = (process / 'cmdline').read_bytes().split(b'\0')
            if pid != bot_pid and any(os.fsencode(str(contract.BOT)) in value for value in args):
                raise RuntimeError('Another process refers to the AG1 bot runtime')
            fd_dir = process / 'fd'
            for fd in fd_dir.iterdir():
                try:
                    target = os.readlink(fd)
                    if not target.startswith(prefixes + protected_prefixes) and target not in protected_files:
                        continue
                    if protected.is_transient(target): continue
                    info = (process / 'fdinfo' / fd.name).read_text()
                    match = re.search(r'^flags:\s*([0-7]+)', info, re.MULTILINE)
                    if not match: raise RuntimeError('Cannot inspect code file access mode')
                    if int(match.group(1), 8) & os.O_ACCMODE:
                        raise RuntimeError('A process has scoped code or protected data open for writing')
                except FileNotFoundError:
                    continue
        except FileNotFoundError:
            continue
        except PermissionError as exc:
            raise RuntimeError('Cannot inspect processes and code writers') from exc


def ready(previous_pid):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        fields = P.unit_properties(contract.UNIT, 'MainPID', 'ActiveState')
        pid = int(fields.get('MainPID', '0'))
        if fields.get('ActiveState') == 'active' and pid > 0 and pid != previous_pid:
            logs = P.command('journalctl', '_PID=' + str(pid), '-o', 'cat', '--no-pager', '-n', '100')
            if re.search(r'^\[msb/bot\] @[A-Za-z0-9_]+ ready\s*$', logs, re.MULTILINE):
                return pid
        time.sleep(1)
    raise RuntimeError('AG1 startup ready marker was not observed')


def proof_check(stage, manifest, manifest_sha, report_sha):
    path = stage / 'verification.json'
    st = path.lstat()
    if st.st_uid != 0 or stat.S_IMODE(st.st_mode) != 0o600 or stage_checks.checked_file(path) != report_sha:
        raise RuntimeError('Untrusted or changed test proof')
    proof = json.loads(path.read_text())
    counts = proof.get('counts', {})
    if proof.get('format') != 'ag1-targeted-v1' or proof.get('passed') is not True or \
       proof.get('host') != contract.HOST or proof.get('source_commit') != manifest['source_commit'] or \
       proof.get('manifest_sha256') != manifest_sha or proof.get('tests') != list(contract.TESTS) or \
       proof.get('codex_transport') != 'exec' or counts.get('tests', 0) <= 0 or \
       counts.get('operator_pass') != contract.OPERATOR_TEST_COUNT or \
       counts.get('pass') != counts.get('tests') or any(counts.get(k) != 0 for k in
                                                         ('fail', 'cancelled', 'skipped', 'todo')):
        raise RuntimeError('Targeted test proof does not match this release')
    return proof


def current_matches_proof(stage, proof):
    pid, net = verify.host_process()
    if pid != proof.get('bot_pid') or net != proof.get('host_netns_inode') or \
       verify.runtime_identity(stage, pid) != proof.get('runtime'):
        raise RuntimeError('AG1 bot or dependencies changed since testing')
    return pid


def private_backup_root():
    for path in (Path('/var'), Path('/var/lib'), Path('/var/lib/msb-ops'), contract.BACKUPS):
        if not os.path.lexists(path):
            path.mkdir(mode=0o700)
            P.sync_dir(path.parent)
        st = path.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError('Untrusted backup parent')
        if path == contract.BACKUPS and st.st_mode & 0o077:
            raise RuntimeError('AG1 backup root is not private')
    return contract.BACKUPS


def validate_backup(backup, manifest, manifest_sha):
    backup = Path(backup)
    if not backup.is_absolute() or backup.parent != contract.BACKUPS or backup.is_symlink():
        raise RuntimeError('Unexpected backup path')
    for directory in (backup, backup / 'prepared', backup / 'originals'):
        st = directory.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o077:
            raise RuntimeError('Untrusted code backup')
    meta = backup / 'metadata.json'
    st = meta.lstat()
    if st.st_uid != 0 or stat.S_IMODE(st.st_mode) != 0o600:
        raise RuntimeError('Untrusted backup metadata')
    stage_checks.checked_file(meta)
    record = json.loads(meta.read_text())
    if record.get('source_commit') != manifest['source_commit'] or record.get('manifest_sha256') != manifest_sha:
        raise RuntimeError('Backup belongs to another release')
    entries = record.get('files')
    if not isinstance(entries, list) or len(entries) != len(manifest['files']):
        raise RuntimeError('Incomplete backup record')
    uid = pwd.getpwnam(contract.OWNER).pw_uid
    gid = grp.getgrnam(contract.OWNER).gr_gid
    for item, expected in zip(entries, manifest['files']):
        if any(item.get(key) != value for key, value in expected.items()):
            raise RuntimeError('Backup file list differs from manifest')
        key = P.item_key({'root': 'bot', 'relative': item['relative']})
        if item.get('key') != key or item.get('owner') != {'sha256': expected['before_sha256'],
                                                           'uid': uid, 'gid': gid, 'mode': contract.MODE}:
            raise RuntimeError('Backup ownership or key changed')
        for identity in (item.get('before_identity'), item.get('after_identity')):
            if not isinstance(identity, dict) or set(identity) != {'dev', 'ino'} or \
               any(type(value) is not int or value <= 0 for value in identity.values()):
                raise RuntimeError('Invalid backup inode identity')
        original = backup / 'originals' / key
        ost = original.lstat()
        if ost.st_uid != 0 or stat.S_IMODE(ost.st_mode) != 0o600 or \
           stage_checks.checked_file(original) != expected['before_sha256']:
            raise RuntimeError('Code backup changed')
        current, _ = transaction.read_live(contract.BOT, item['relative'])
        fd = P.open_directory(backup / 'prepared')
        try:
            held, _ = P.read_entry(fd, key)
        finally:
            os.close(fd)
        before = P.expected_info(item['owner'], item['before_identity'], expected['before_sha256'])
        after = P.expected_info(item['owner'], item['after_identity'], expected['after_sha256'])
        if (current, held) not in ((before, after), (after, before)):
            raise RuntimeError('Live code or recovery inode changed independently')
    return record


def marker(backup):
    path = backup / 'guard.pending'
    if not path.exists():
        transaction.write_file(path, b'code-only recovery pending\n')
        P.sync_dir(backup)


def finish(backup):
    path = backup / 'guard.pending'
    if path.exists():
        path.unlink()
        P.sync_dir(backup)


def stop_quiet(host):
    fields = P.unit_properties(contract.UNIT, 'MainPID', 'FreezerState')
    pid = int(fields.get('MainPID', '0'))
    if fields.get('FreezerState') != 'frozen': host.call('freeze')
    try:
        host.bot_idle(frozen=True)
        check_code_processes(pid)
    finally:
        host.thaw_if_needed()
    host.bot_idle()
    check_code_processes(pid)
    host.call('stop')
    host.bot_stopped()
    check_code_processes(None)
    return pid


def recover(stage, manifest, manifest_sha, backup, host):
    record = validate_backup(backup, manifest, manifest_sha)
    marker(backup)
    previous_pid = 0
    if host.bot_active():
        # systemd cannot freeze, thaw or stop an active masked instance. If a
        # prior operator died in that state, restore the expected unit first.
        if P.unit_properties(contract.UNIT, 'UnitFileState').get('UnitFileState') == 'masked':
            host.unguard_startup()
        previous_pid = stop_quiet(host)
    else:
        host.bot_stopped()
        check_code_processes(None)
    host.ensure_guard_startup()
    stage_checks.check_live_inventory(contract.BOT, manifest, after=None)
    validate_backup(backup, manifest, manifest_sha)
    transaction.rollback(contract.BOT, backup, record)
    stage_checks.check_live_inventory(contract.BOT, manifest, after=False)
    host.unguard_startup()
    host_identity()
    host.call('start')
    ready(previous_pid)
    stage_checks.check_live_inventory(contract.BOT, manifest, after=False)
    finish(backup)


def apply(stage, manifest, manifest_sha, proof):
    host = P.Host()
    pid = current_matches_proof(stage, proof)
    stage_checks.check_live_inventory(contract.BOT, manifest, after=False)
    host.bot_idle()
    check_code_processes(pid)
    backup = private_backup_root() / ('release-' + secrets.token_hex(12))
    uid = pwd.getpwnam(contract.OWNER).pw_uid
    gid = grp.getgrnam(contract.OWNER).gr_gid
    record = transaction.prepare(contract.BOT, stage, backup, manifest['files'], uid=uid, gid=gid,
                                 mode=contract.MODE, commit=manifest['source_commit'], manifest_sha=manifest_sha)
    frozen = stopped = False
    try:
        marker(backup)
        host.call('freeze')
        frozen = True
        host.bot_idle(frozen=True)
        check_code_processes(pid)
        snapshot = protected.snapshot()
        host.call('thaw')
        frozen = False
        host.bot_idle()
        check_code_processes(pid)
        stopped = True
        host.call('stop')
        host.bot_stopped()
        check_code_processes(None)
        host.guard_startup()
        if protected.snapshot() != snapshot:
            raise RuntimeError('Protected data changed while stopping; no data was restored')
        stage_checks.validate(stage, manifest_sha)
        stage_checks.check_live_inventory(contract.BOT, manifest, after=False)
        validate_backup(backup, manifest, manifest_sha)
        host.ensure_guard_startup()
        transaction.publish(contract.BOT, stage, backup, record)
        stage_checks.check_live_inventory(contract.BOT, manifest, after=True)
        if protected.snapshot() != snapshot:
            raise RuntimeError('Protected data changed during installation; no data was restored')
        host.unguard_startup()
        host_identity()
        host.call('start')
        ready(pid)
        stage_checks.check_live_inventory(contract.BOT, manifest, after=True)
        if protected.snapshot() != snapshot:
            raise RuntimeError('Protected data changed during startup; no data was restored')
        finish(backup)
        return backup
    except BaseException as original:
        try:
            if frozen: host.thaw_if_needed()
            if stopped or (backup / 'guard.pending').exists():
                recover(stage, manifest, manifest_sha, backup, host)
        except BaseException as recovery:
            raise RuntimeError('Deployment failed; recovery is pending. Check the startup guard before any restart. Backup: '
                               + str(backup) + '; recovery error: ' + str(recovery)) from original
        raise RuntimeError('Deployment failed; previous code restored. Backup: ' + str(backup)) from original


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', required=True)
    parser.add_argument('--manifest-sha', required=True)
    parser.add_argument('--report-sha', required=True)
    parser.add_argument('--quiet-window-confirmed', action='store_true')
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--plan', action='store_true')
    action.add_argument('--apply', action='store_true')
    action.add_argument('--rollback')
    args = parser.parse_args()
    stage = Path(args.stage).absolute()
    host_identity(allow_masked=bool(args.rollback))
    manifest = stage_checks.validate(stage, args.manifest_sha)
    proof = proof_check(stage, manifest, args.manifest_sha, args.report_sha)
    root = private_backup_root()
    fd = os.open(root / 'operator.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        lockstat = os.fstat(fd)
        if not stat.S_ISREG(lockstat.st_mode) or lockstat.st_uid != 0 or lockstat.st_nlink != 1 or \
           stat.S_IMODE(lockstat.st_mode) != 0o600:
            raise RuntimeError('Untrusted operator lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.plan:
            current_matches_proof(stage, proof)
            stage_checks.check_live_inventory(contract.BOT, manifest, after=False)
            print('AG1 candidate:', manifest['source_commit'])
            print('Code-only targets:', ', '.join(contract.FILES))
            print('Targeted test scope only; validate the quiet window and JAR1 live acceptance separately.')
        elif args.apply:
            if not args.quiet_window_confirmed: raise RuntimeError('A verified quiet window is required')
            backup = apply(stage, manifest, args.manifest_sha, proof)
            print('AG1 code installed; backup:', backup)
            print('Telegram live acceptance remains required.')
        else:
            if not args.quiet_window_confirmed: raise RuntimeError('A verified quiet window is required')
            backup = Path(args.rollback)
            recover(stage, manifest, args.manifest_sha, backup, P.Host())
            print('Previous AG1 code restored from:', backup)
    finally:
        os.close(fd)


if __name__ == '__main__':
    def terminated(_signum, _frame):
        raise SystemExit('Interrupted')
    signal.signal(signal.SIGTERM, terminated)
    main()

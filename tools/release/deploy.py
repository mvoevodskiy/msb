#!/usr/bin/env python3
"""JAR1-only release transaction. Plan first; change code only, with exact rollback."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import socket
import subprocess
import time
from manifest import digest, inventory, plan, validate_release, verify_plan, validate_test_snapshot
from verify import dependency_check
from transaction import backup_code, install_code, restore_code, validate_backup

LIVE = Path('/home/client/.iia')
UNIT = 'iia-bot@default.service'
BACKUPS = Path('/var/lib/agentsmania-ops/releases')
PROTECTED = [LIVE / 'bots/default/state.json', LIVE / 'bots/default/ext-providers.json',
    Path('/home/client/.codex/config.toml'), Path('/home/client/.codex/auth.json'),
    LIVE / 'bots/default/.env', LIVE / '.env', LIVE / 'monitor/config.json']


def command(args, timeout=60):
    value = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
    if value.returncode:
        raise RuntimeError(f'{args[0]} failed with code {value.returncode}')
    return value.stdout.strip()


def assert_host():
    if os.geteuid() != 0 or socket.gethostname() != 'VM-105504':
        raise RuntimeError('This operator is pinned to root on JAR1')


def idle_service():
    pid = int(command(['systemctl', 'show', UNIT, '-p', 'MainPID', '--value']))
    group = command(['systemctl', 'show', UNIT, '-p', 'ControlGroup', '--value'])
    if not pid or not group:
        raise RuntimeError('Expected the existing live bot service')
    members = (Path('/sys/fs/cgroup') / group.lstrip('/') / 'cgroup.procs').read_text().split()
    if any(int(member) != pid for member in members):
        raise RuntimeError('Bot has active child processes; wait for its current turn')
    for unit in ['iia-sync.service', 'iia-tick@puller.service']:
        if command(['systemctl', 'show', unit, '-p', 'ActiveState', '--value']) in ['active', 'activating']:
            raise RuntimeError('An updater is running; retry when it finishes')
    return pid


def verify_checks(stage, release):
    checks = json.loads((stage / 'checks/results/verification.json').read_text())
    required = {'core', 'overlay', 'reference', 'syntax', 'dependencies', 'profile-smoke', 'test-snapshot', 'release-tools'}
    if checks.get('source_commit') != release['source_commit'] or checks.get('release_sha256') != digest(stage / 'release.json'):
        raise RuntimeError('Verification does not belong to this release')
    if checks.get('environment', {}).get('platform') != 'linux':
        raise RuntimeError('This release requires verification on Linux')
    validate_test_snapshot(stage, release)
    suites = checks.get('checks', [])
    if not checks.get('passed') or not required <= {r['suite'] for r in suites} or any(r['exit_code'] for r in suites):
        raise RuntimeError('Release verification has not passed')
    return checks


def check_external_runtime(stage, release, checks):
    node = command(['node', '--version'])
    if int(node.lstrip('v').split('.')[0]) < release['external_runtime']['node_min_major']:
        raise RuntimeError('Node runtime is older than the verified minimum')
    if node != checks['environment']['node']:
        raise RuntimeError('Node differs from the verified Linux runtime')
    if dependency_check(stage, LIVE / 'bot/node_modules') != checks['environment']['dependencies']:
        raise RuntimeError('Live dependencies differ from those tested')
    cli = command(['runuser', '-u', 'client', '--', 'env', 'HOME=/home/client',
        'PATH=/home/client/.iia/ext-tools/bin:/home/client/.local/bin:/usr/local/bin:/usr/bin:/bin', 'codex', '--version'])
    if not re.search(r'\b' + re.escape(release['external_runtime']['codex']) + r'\b', cli):
        raise RuntimeError('Codex CLI differs from the pinned runtime contract')
    return {'node': node, 'codex': cli}


def start_and_check():
    command(['systemctl', 'start', UNIT])
    deadline = time.monotonic() + 35
    pid = 0
    while time.monotonic() < deadline:
        command(['systemctl', 'is-active', '--quiet', UNIT])
        current = int(command(['systemctl', 'show', UNIT, '-p', 'MainPID', '--value']))
        if pid and current != pid:
            raise RuntimeError('Bot restarted during readiness check')
        pid = current
        logs = command(['journalctl', '-u', UNIT, f'_PID={pid}', '--no-pager', '-o', 'cat', '--since', '-1 minute'])
        if re.search(r'\[\w+/open\] boot version=', logs) and re.search(r'\[\w+/bot\] @\S+ ready', logs):
            time.sleep(2)
            command(['systemctl', 'is-active', '--quiet', UNIT])
            if int(command(['systemctl', 'show', UNIT, '-p', 'MainPID', '--value'])) != pid:
                raise RuntimeError('Bot restarted immediately after ready')
            return pid
        time.sleep(1)
    raise RuntimeError('No polling-ready signal from the new process')


def preserve_profiles(backup):
    values = {str(p): digest(p) for p in PROTECTED}
    for index, file in enumerate(PROTECTED):
        if file.exists():
            target = backup / f'private-profile-{index}'
            shutil.copyfile(file, target)
            target.chmod(0o600)
    return values


def assert_profiles(before):
    if any(digest(file) != before[str(file)] for file in PROTECTED):
        raise RuntimeError('Protected profile changed during release startup')


def apply(stage):
    assert_host()
    stage = stage.resolve()
    release, expected = validate_release(stage)
    value = json.loads((stage / 'install-plan.json').read_text())
    verify_plan(stage, LIVE, value)
    checks = verify_checks(stage, release)
    versions = check_external_runtime(stage, release, checks)
    old_pid = idle_service()
    BACKUPS.mkdir(parents=True, exist_ok=True, mode=0o700)
    BACKUPS.chmod(0o700)
    backup = BACKUPS / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + release['source_commit'][:12])
    stopped, code_started, profiles = False, False, None
    try:
        stopped = True
        command(['systemctl', 'stop', UNIT], timeout=120)
        verify_plan(stage, LIVE, value)
        ownership = backup_code(LIVE, backup, value)
        profiles = preserve_profiles(backup)
        user = pwd.getpwnam('client')
        code_started = True
        install_code(stage, LIVE, value, ownership, user.pw_uid, user.pw_gid)
        assert_profiles(profiles)
        new_pid = start_and_check()
        assert_profiles(profiles)
        if inventory(LIVE) != expected:
            raise RuntimeError('Runtime code changed during startup')
        result = {'source_commit': release['source_commit'], 'profile': release['profile'],
            'applied_at_utc': datetime.now(timezone.utc).isoformat(), 'backup': str(backup),
            'old_pid': old_pid, 'new_pid': new_pid, 'runtime_files': len(expected),
            'inventory_matches': True, 'startup_ready': True, 'live_telegram_acceptance_required': True, 'external_runtime': versions,
            'protected_unchanged': {str(p): digest(p) == profiles[str(p)] for p in PROTECTED}}
        (backup / 'applied.json').write_text(json.dumps(result, indent=2) + '\n')
        (backup / 'applied.json').chmod(0o600)
        (stage / 'applied.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result))
    except BaseException:
        if stopped:
            command(['systemctl', 'stop', UNIT], timeout=120)
            if code_started:
                restore_code(LIVE, backup)
            # Deliberately leave newer owner/session/auth data in place.
            start_and_check()
        raise


def rollback(backup):
    assert_host()
    backup = backup.resolve()
    if backup.parent != BACKUPS or backup.is_symlink():
        raise ValueError('Rollback must name a recorded JAR1 release backup')
    value = json.loads((backup / 'plan.json').read_text())['plan']
    if inventory(LIVE) != value['after']:
        raise RuntimeError('The live code differs from this release; inspect before rollback')
    validate_backup(LIVE, backup)
    idle_service()
    command(['systemctl', 'stop', UNIT], timeout=120)
    before = {str(p): digest(p) for p in PROTECTED}
    restore_code(LIVE, backup)
    pid = start_and_check()
    assert_profiles(before)
    print(json.dumps({'rolled_back': str(backup), 'new_pid': pid, 'original_inventory_restored': True, 'profile_preserved': True}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path)
    parser.add_argument('--plan', action='store_true')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--rollback', type=Path)
    args = parser.parse_args()
    if sum([args.plan, args.apply, bool(args.rollback)]) != 1:
        parser.error('Choose exactly one of --plan, --apply or --rollback')
    if args.rollback:
        return rollback(args.rollback)
    if not args.stage:
        parser.error('--stage is required')
    assert_host()
    if args.plan:
        release, _ = validate_release(args.stage)
        verify_checks(args.stage, release)
        value = plan(args.stage, LIVE)
        (args.stage / 'install-plan.json').write_text(json.dumps(value, indent=2) + '\n')
        print(json.dumps({'source_commit': value['source_commit'], 'changes': value['changes'],
                          'removals': value['removals'], 'baseline_files': len(value['before'])}))
    else:
        apply(args.stage)

if __name__ == '__main__':
    def interrupted(number, frame):
        raise InterruptedError('Interrupted; restore previous code')
    for number in [signal.SIGTERM, signal.SIGHUP]:
        signal.signal(number, interrupted)
    main()

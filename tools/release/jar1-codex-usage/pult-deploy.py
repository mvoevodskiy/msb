#!/usr/bin/env python3
"""Code-only Pult update using the reviewed atomic release primitives."""
import argparse
import base64
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import signal
import stat
import subprocess
import tempfile
import time
import tarfile

PULT = Path('/home/client/.msb/pult')
DEPENDENCY = Path('/usr/local/lib/msb-tools/ccusage-20.0.51')
MARKER = Path('/var/lib/msb-ops/pult-collector-usage.pending')
GUARD = Path('/etc/systemd/system/pult-collector.service.d/90-codex-usage-guard.conf')
GUARD_CONTENT = '[Unit]\nConditionPathExists=!/var/lib/msb-ops/pult-collector-usage.pending\n'
CCUSAGE_SHA512 = 'NZN5h+HBHC6tOO3aadbsZEKzGfNS24asTcvgv+iP9gY0Cw1QyzSaOhqJM1E2f8nkCsqiX2NRrb/RNC7dvcXx7g=='
FILES = ('config/ccusage-report.json', 'src/collector/sources/codex-usage-data.ts',
         'src/collector/sources/codex-usage.ts', 'src/shared/types.ts', 'src/collector/collect.ts',
         'src/ui/view-bot-usage.js', 'src/ui/view-bots.js')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def trusted(stage, relative):
    path = stage
    for part in Path(relative).parts[:-1]:
        path = path / part
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Untrusted stage directory')
    fd = os.open(path / Path(relative).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Untrusted stage file')
        with os.fdopen(fd, 'rb', closefd=False) as stream: return stream.read()
    finally: os.close(fd)


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=90)
    if result.returncode: raise RuntimeError(args[0] + ' failed')
    return result.stdout.strip()


def stop_collector():
    command('systemctl', 'stop', 'pult-collector.service')
    active = command('systemctl', 'show', 'pult-collector.service', '-p', 'ActiveState', '--value')
    pid = command('systemctl', 'show', 'pult-collector.service', '-p', 'MainPID', '--value')
    if active not in ('inactive', 'failed') or pid != '0':
        raise RuntimeError('Pult collector did not stop; recovery guard remains in place')


def inventory(manifest, base, after=False):
    changes = {item['relative']: item for item in manifest['pult_files']}
    expected = {item['relative']: item['sha256'] for item in manifest['pult_baseline_inventory']}
    if after:
        expected.update({name: item['after_sha256'] for name, item in changes.items()})
    for name, digest in expected.items():
        if base.digest(base.safe_file(PULT, name)) != digest:
            raise RuntimeError('Installed Pult inventory differs: ' + name)
    for parent, dirs, names in os.walk(PULT / 'src', followlinks=False):
        if any((Path(parent) / name).is_symlink() for name in dirs): raise RuntimeError('Symlinked Pult code directory')
        for name in names:
            file = Path(parent) / name
            if file.suffix in ('.ts', '.js', '.css', '.html', '.json') and file.relative_to(PULT).as_posix() not in expected:
                raise RuntimeError('Unexpected Pult runtime file')


def runtime(stage):
    report = json.loads(trusted(stage, 'test-home/results/verification.json'))
    expected_node = report.get('environment', {}).get('node_sha256')
    if not isinstance(expected_node, str): raise RuntimeError('Missing verified Node identity')
    for unit in ('pult-web.service', 'pult-collector.service'):
        pid = int(command('systemctl', 'show', unit, '-p', 'MainPID', '--value'))
        if pid <= 0 or sha(Path('/proc') / str(pid) / 'exe') != expected_node:
            raise RuntimeError('Pult Node differs from the verified runtime')
    lock = json.loads((PULT / 'package-lock.json').read_text())
    expected = lock['packages']['node_modules/qrcode-generator']['version']
    installed = json.loads((PULT / 'node_modules/qrcode-generator/package.json').read_text())['version']
    if installed != expected: raise RuntimeError('Pult dependency differs from its lock')


def load(stage, manifest_sha, report_sha):
    stage = Path(stage).absolute()
    if os.geteuid() != 0 or stage.parent != Path('/var/tmp') or stage.is_symlink():
        raise RuntimeError('Unexpected release context')
    if Path(__file__).resolve(strict=True) != stage / 'pult-deploy.py': raise RuntimeError('Wrong Pult deployment wrapper')
    if stage.lstat().st_uid != 0 or stage.lstat().st_mode & 0o022:
        raise RuntimeError('Untrusted release directory')
    manifest_data = trusted(stage, 'manifest.json')
    if hashlib.sha256(manifest_data).hexdigest() != manifest_sha: raise RuntimeError('Manifest mismatch')
    manifest = json.loads(manifest_data)
    for file, key in [('pult-deploy.py', 'pult-deploy_sha256'), ('deploy_base.py', 'deploy_base_sha256')]:
        if hashlib.sha256(trusted(stage, file)).hexdigest() != manifest[key]: raise RuntimeError('Deployment tool changed')
    proof = trusted(stage, 'test-home/results/usage-verification.json')
    if hashlib.sha256(proof).hexdigest() != report_sha: raise RuntimeError('Usage verification hash mismatch')
    report = json.loads(proof)
    if not report.get('passed') or report.get('source_commit') != manifest['source_commit'] or \
       report.get('manifest_sha256') != manifest_sha or \
       report.get('composite_archive_sha256') != manifest['composite_archive_sha256'] or \
       hashlib.sha256(trusted(stage, 'composite.tar.gz')).hexdigest() != manifest['composite_archive_sha256']:
        raise RuntimeError('Usage verification does not match this release')
    expected_suites = {'usage-collector', 'usage-ui', 'usage-native', 'usage-release', 'usage-stop', 'composite-session', 'composite-resume',
                       'composite-intro', 'composite-background', 'composite-claude'}
    if {row.get('suite') for row in report.get('checks', [])} != expected_suites or \
       any(row.get('exit_code') or row.get('passed', 0) <= 0 for row in report['checks']):
        raise RuntimeError('Usage verification is incomplete')
    files = manifest.get('pult_files', [])
    if [(item.get('root'), item.get('relative')) for item in files] != [('pult', name) for name in FILES]:
        raise RuntimeError('Unexpected Pult file list')
    for item in files:
        if hashlib.sha256(trusted(stage, 'payload/pult/' + item['relative'])).hexdigest() != item['after_sha256']:
            raise RuntimeError('Pult payload changed')
    binary = trusted(stage, 'ccusage'); archive_data = trusted(stage, 'ccusage.tgz')
    if manifest['ccusage_archive_sha512'] != CCUSAGE_SHA512 or hashlib.sha256(binary).hexdigest() != manifest['ccusage_binary_sha256'] or \
       base64.b64encode(hashlib.sha512(archive_data).digest()).decode() != CCUSAGE_SHA512:
        raise RuntimeError('ccusage dependency changed')
    with tarfile.open(stage / 'ccusage.tgz', 'r:gz') as archive:
        member = archive.getmember('package/bin/ccusage')
        if not member.isfile() or member.size > 12_000_000 or archive.extractfile(member).read() != binary:
            raise RuntimeError('ccusage binary does not match its verified archive')
    spec = importlib.util.spec_from_file_location('pult_usage_deploy_base', stage / 'deploy_base.py')
    base = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(base)
    return stage, manifest, base


def check(stage, manifest, base):
    if os.path.lexists(MARKER) or os.path.lexists(GUARD): raise RuntimeError('A Pult release guard is already present')
    if command('systemctl', 'is-active', 'pult-web.service') != 'active' or \
       command('systemctl', 'is-active', 'pult-collector.service') != 'active':
        raise RuntimeError('Pult services are not active')
    inventory(manifest, base)
    runtime(stage)
    for item in manifest['pult_files']:
        target = base.safe_file(PULT, item['relative'], allow_absent=item['before_sha256'] is None)
        if item['before_sha256'] is None:
            if os.path.lexists(target): raise RuntimeError('New Pult file already exists')
        elif base.digest(target) != item['before_sha256']:
            raise RuntimeError('Installed Pult code differs from the release baseline')
    if DEPENDENCY.exists():
        st = DEPENDENCY.lstat()
        if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022 or \
           sha(DEPENDENCY) != manifest['ccusage_binary_sha256']:
            raise RuntimeError('Existing ccusage dependency differs from the release')


def dependency(stage, manifest):
    parent = DEPENDENCY.parent
    parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    st = parent.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
        raise RuntimeError('Untrusted ccusage directory')
    if DEPENDENCY.exists(): return False
    fd, tmp = tempfile.mkstemp(prefix='.ccusage-', dir=parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write((stage / 'ccusage').read_bytes()); output.flush()
            os.fchmod(output.fileno(), 0o755); os.fsync(output.fileno())
        if sha(tmp) != manifest['ccusage_binary_sha256']: raise RuntimeError('Dependency copy mismatch')
        os.link(tmp, DEPENDENCY, follow_symlinks=False)
        return True
    finally:
        Path(tmp).unlink(missing_ok=True)


def prepare(stage, manifest, base, backup):
    backup.mkdir(mode=0o700, parents=False, exist_ok=False)
    (backup / 'prepared').mkdir(mode=0o700)
    (backup / 'quarantine').mkdir(mode=0o700)
    (backup / 'code').mkdir(mode=0o700)
    entries = []
    for item in manifest['pult_files']:
        relative = item['relative']; added = item['before_sha256'] is None
        target = base.safe_file(PULT, relative, allow_absent=added)
        if added:
            uid = pwd.getpwnam('client').pw_uid; gid = pwd.getpwnam('client').pw_gid
            old = {'sha256': None, 'uid': uid, 'gid': gid, 'mode': 0o664}; before = None
        else:
            parent = base.open_parent(PULT, relative)
            try: observed, content = base.read_entry(parent, target.name)
            finally: os.close(parent)
            if observed['sha256'] != item['before_sha256']: raise RuntimeError('Pult baseline changed')
            old = {key: observed[key] for key in ('sha256', 'uid', 'gid', 'mode')}
            before = {key: observed[key] for key in ('dev', 'ino')}
            copy = backup / 'code' / base.item_key(item)
            with copy.open('xb') as output:
                os.fchmod(output.fileno(), 0o600); output.write(content); output.flush(); os.fsync(output.fileno())
        prepared = backup / 'prepared' / base.item_key(item)
        with prepared.open('xb') as output:
            output.write((stage / 'payload/pult' / relative).read_bytes()); output.flush()
            os.fchown(output.fileno(), old['uid'], old['gid']); os.fchmod(output.fileno(), old['mode']); os.fsync(output.fileno())
        parent = base.open_directory(prepared.parent)
        try: observed, _ = base.read_entry(parent, prepared.name)
        finally: os.close(parent)
        if observed['sha256'] != item['after_sha256']: raise RuntimeError('Prepared Pult file changed')
        entries.append({**item, 'owner': old, 'before_identity': before,
                        'after_identity': {key: observed[key] for key in ('dev', 'ino')}})
    record = {'source_commit': manifest['source_commit'], 'files': entries}
    file = backup / 'metadata.json'
    with file.open('x') as output:
        os.fchmod(output.fileno(), 0o600); output.write(json.dumps(record, indent=2) + '\n'); output.flush(); os.fsync(output.fileno())
    for directory in sorted((path for path in backup.rglob('*') if path.is_dir()), key=lambda p: len(p.parts), reverse=True):
        base.sync_dir(directory)
    base.sync_dir(backup); base.sync_dir(backup.parent)
    return record


def guard(base, backup, manifest):
    details = {'backup': str(backup), 'source_commit': manifest['source_commit']}
    if MARKER.exists():
        if MARKER.is_symlink() or MARKER.lstat().st_uid != 0 or json.loads(MARKER.read_text()) != details:
            raise RuntimeError('Unexpected Pult release marker')
    else:
        fd = os.open(MARKER, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as out:
            out.write(json.dumps(details) + '\n'); out.flush(); os.fsync(out.fileno())
        base.sync_dir(MARKER.parent)
    GUARD.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    info = GUARD.parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError('Untrusted Pult guard directory')
    if GUARD.exists():
        if GUARD.is_symlink() or GUARD.lstat().st_uid != 0 or GUARD.read_text() != GUARD_CONTENT:
            raise RuntimeError('Unexpected Pult guard')
    else:
        fd = os.open(GUARD, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        with os.fdopen(fd, 'w') as out:
            out.write(GUARD_CONTENT); out.flush(); os.fsync(out.fileno())
        base.sync_dir(GUARD.parent)
    command('systemctl', 'daemon-reload')


def clear_marker(base):
    if MARKER.is_symlink(): raise RuntimeError('Unexpected Pult marker link')
    MARKER.unlink(missing_ok=True)
    base.sync_dir(MARKER.parent)


def clear_guard(base):
    if GUARD.is_symlink() or (GUARD.exists() and GUARD.read_text() != GUARD_CONTENT):
        raise RuntimeError('Unexpected Pult guard')
    GUARD.unlink(missing_ok=True)
    base.sync_dir(GUARD.parent)
    command('systemctl', 'daemon-reload')


def restore(base, backup, record):
    for item in reversed(record['files']):
        prepared = backup / 'prepared' / base.item_key(item)
        if item['before_sha256'] is None:
            base.remove_created(PULT, item['relative'], backup / 'quarantine' / base.item_key(item),
                                item['owner'], item['after_identity'], item['after_sha256'])
        else:
            base.restore_existing(PULT, item['relative'], prepared, item['owner'],
                                  item['before_identity'], item['after_identity'], item['after_sha256'])


def apply(stage, manifest, base, backup):
    check(stage, manifest, base)
    pult_backup = backup / 'pult'
    record = prepare(stage, manifest, base, pult_backup)
    installed = False
    try:
        guard(base, backup, manifest)
        installed = dependency(stage, manifest)
        command('runuser', '-u', 'client', '--', str(DEPENDENCY), '--version')
        stop_collector()
        for item in record['files']:
            base.atomic_write(PULT, item['relative'], (stage / 'payload/pult' / item['relative']).read_bytes(),
                              item['owner'], create=item['before_sha256'] is None,
                              prepared=pult_backup / 'prepared' / base.item_key(item),
                              before_identity=item['before_identity'], after_identity=item['after_identity'])
        inventory(manifest, base, after=True)
        clear_marker(base)
        command('systemctl', 'start', 'pult-collector.service')
        time.sleep(2)
        command('systemctl', 'is-active', '--quiet', 'pult-collector.service')
        command('systemctl', 'is-active', '--quiet', 'pult-web.service')
        clear_guard(base)
        (pult_backup / 'applied.json').write_text(json.dumps({'source_commit': manifest['source_commit'],
            'ccusage_new': installed, 'collector_active': True}) + '\n')
        print(json.dumps({'pult_updated': True, 'collector_active': True, 'web_active': True}))
    except BaseException:
        guard(base, backup, manifest)
        stop_collector()
        restore(base, pult_backup, record)
        inventory(manifest, base)
        clear_marker(base)
        command('systemctl', 'start', 'pult-collector.service')
        clear_guard(base)
        if installed and DEPENDENCY.is_file() and sha(DEPENDENCY) == manifest['ccusage_binary_sha256']:
            DEPENDENCY.unlink()
        raise


def rollback(manifest, base, backup):
    pult_backup = backup / 'pult'
    st = pult_backup.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o077:
        raise RuntimeError('Untrusted Pult backup')
    record = json.loads((pult_backup / 'metadata.json').read_text())
    if record.get('source_commit') != manifest['source_commit'] or \
       [item.get('relative') for item in record.get('files', [])] != list(FILES):
        raise RuntimeError('Pult backup does not match this release')
    guard(base, backup, manifest)
    stop_collector()
    restore(base, pult_backup, record)
    inventory(manifest, base)
    clear_marker(base)
    command('systemctl', 'start', 'pult-collector.service')
    command('systemctl', 'is-active', '--quiet', 'pult-collector.service')
    clear_guard(base)
    print(json.dumps({'pult_rolled_back': True, 'collector_active': True}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', required=True); parser.add_argument('--backup', required=True)
    parser.add_argument('--manifest-sha', required=True); parser.add_argument('--usage-report-sha', required=True)
    operation = parser.add_mutually_exclusive_group()
    operation.add_argument('--apply', action='store_true'); operation.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    backup = Path(args.backup).absolute()
    if backup.parent != Path('/var/lib/msb-ops/releases'): raise RuntimeError('Unexpected backup path')
    stage, manifest, base = load(args.stage, args.manifest_sha, args.usage_report_sha)
    def interrupt(signum, _frame): raise InterruptedError('signal ' + str(signum))
    signal.signal(signal.SIGTERM, interrupt); signal.signal(signal.SIGHUP, interrupt)
    lock = base.open_directory('/var/lib/msb-ops/releases')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.apply or args.rollback:
            if not backup.is_dir() or backup.is_symlink(): raise RuntimeError('Verified bot backup is missing')
            if args.apply: apply(stage, manifest, base, backup)
            else: rollback(manifest, base, backup)
        else:
            check(stage, manifest, base)
            print(json.dumps({'operation': 'read-only Pult plan', 'files': len(manifest['pult_files'])}))
    finally: os.close(lock)


if __name__ == '__main__': main()

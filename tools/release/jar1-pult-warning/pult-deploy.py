#!/usr/bin/env python3
"""Install the verified Pult collector-only update with the existing atomic transaction."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat

BASE = 'a19689e080a6bb2be212ded5fe53eca54df82d26'
SCOPE = 'pult-usage-warning-v1'
FILES = ('src/collector/sources/codex-usage-data.ts', 'src/collector/sources/codex-usage.ts')
CCUSAGE_SHA256 = '7ddd309d8f4d1c2c007647f43c300a8261acbe9e5cb355e70cc428f0f419f8d2'
EXCLUDED_TESTS = [
    'provider routing never lends Claude rateLimitInfo to Codex, Cursor, Qwen, unknown or OpenClaw',
    'check: построчно ✓/✗, ключ не печатается, --json, ненулевой код при ошибке',
]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def valid_hash(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def validate_manifest(manifest):
    if manifest.get('schema') != 1 or manifest.get('scope') != SCOPE or manifest.get('base_commit') != BASE or \
       not re.fullmatch(r'[0-9a-f]{40}', manifest.get('source_commit', '')) or \
       manifest.get('ccusage_binary_sha256') != CCUSAGE_SHA256:
        raise RuntimeError('Wrong Pult release identity')
    files = manifest.get('pult_files', [])
    if [(item.get('root'), item.get('relative'), item.get('source')) for item in files] != \
       [('pult', name, '.msb/pult/' + name) for name in FILES]:
        raise RuntimeError('Unexpected Pult payload')
    if any(not valid_hash(item.get(key)) for item in files for key in ('before_sha256', 'after_sha256')):
        raise RuntimeError('Invalid Pult file hash')
    entries = manifest.get('pult_baseline_inventory', [])
    inventory = {item.get('relative'): item.get('sha256') for item in entries}
    if len(inventory) != len(entries) or any(not valid_hash(value) for value in inventory.values()) or \
       'config/ccusage-report.json' not in inventory or \
       any(inventory.get(item['relative']) != item['before_sha256'] for item in files):
        raise RuntimeError('Invalid Pult baseline inventory')


def validate_report(report, manifest, manifest_sha):
    checks = report.get('checks', [])
    if not report.get('passed') or report.get('scope') != SCOPE or \
       report.get('source_commit') != manifest['source_commit'] or report.get('manifest_sha256') != manifest_sha or \
       report.get('source_archive_sha256') != manifest.get('source_archive_sha256') or \
       report.get('excluded_tests') != EXCLUDED_TESTS or \
       not valid_hash(report.get('environment', {}).get('node_sha256')) or \
       {row.get('suite') for row in checks} != {'typecheck', 'pult-tests', 'release-tests'} or \
       len(checks) != 3 or any(row.get('exit_code') != 0 or row.get('passed', 0) < 1 for row in checks) or \
       next(row for row in checks if row['suite'] == 'pult-tests').get('skipped') != 0:
        raise RuntimeError('Pult verification does not match this release')


def trusted(stage, relative):
    rel = Path(relative)
    if rel.is_absolute() or any(part in ('', '.', '..') for part in rel.parts):
        raise RuntimeError('Invalid stage path')
    parent = stage
    for part in rel.parts[:-1]:
        parent /= part
        st = parent.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError('Untrusted stage directory')
    fd = os.open(parent / rel.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError('Untrusted stage file')
        with os.fdopen(fd, 'rb', closefd=False) as stream: return stream.read()
    finally:
        os.close(fd)


def load(stage, manifest_sha, report_sha):
    stage = Path(stage).absolute()
    if os.geteuid() != 0 or stage.parent != Path('/var/tmp') or stage.is_symlink() or \
       Path(__file__).resolve(strict=True) != stage / 'pult-deploy.py':
        raise RuntimeError('Unexpected Pult release context')
    st = stage.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
        raise RuntimeError('Untrusted stage')
    raw = trusted(stage, 'manifest.json')
    if digest(raw) != manifest_sha: raise RuntimeError('Manifest changed')
    manifest = json.loads(raw)
    validate_manifest(manifest)
    for name in ('launcher.py', 'verify.py', 'pult-deploy.py', 'pult_base.py', 'deploy_base.py'):
        if digest(trusted(stage, name)) != manifest[name.removesuffix('.py') + '_sha256']:
            raise RuntimeError('Release tool changed: ' + name)
    report_raw = trusted(stage, 'test-home/results/verification.json')
    if digest(report_raw) != report_sha: raise RuntimeError('Verification report changed')
    validate_report(json.loads(report_raw), manifest, manifest_sha)
    if digest(trusted(stage, 'source.tar.gz')) != manifest['source_archive_sha256']:
        raise RuntimeError('Verified source archive changed')
    dependency = Path('/usr/local/lib/msb-tools/ccusage-20.0.51')
    st = dependency.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022 or \
       digest(dependency.read_bytes()) != CCUSAGE_SHA256:
        raise RuntimeError('Pinned ccusage is unavailable or changed')
    for item in manifest['pult_files']:
        if digest(trusted(stage, 'payload/pult/' + item['relative'])) != item['after_sha256']:
            raise RuntimeError('Verified Pult payload changed')
    def module(name, file):
        spec = importlib.util.spec_from_file_location(name, stage / file)
        result = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(result)
        return result
    base = module('pult_warning_atomic', 'deploy_base.py')
    pult = module('pult_warning_transaction', 'pult_base.py')
    pult.FILES = FILES
    return stage, manifest, base, pult


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', required=True)
    parser.add_argument('--backup', required=True)
    parser.add_argument('--manifest-sha', required=True)
    parser.add_argument('--report-sha', required=True)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument('--plan', action='store_true')
    operation.add_argument('--apply', action='store_true')
    operation.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    stage, manifest, base, pult = load(args.stage, args.manifest_sha, args.report_sha)
    backup = Path(args.backup).absolute()
    if backup.parent != Path('/var/lib/msb-ops/releases') or backup.is_symlink():
        raise RuntimeError('Unexpected backup path')
    def interrupt(signum, _frame): raise InterruptedError('signal ' + str(signum))
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGHUP, interrupt)
    lock = base.open_directory(backup.parent)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.plan:
            pult.check(stage, manifest, base)
            print(json.dumps({'plan': 'pult-only', 'files': len(FILES)}))
        elif args.apply:
            pult.check(stage, manifest, base)
            backup.mkdir(mode=0o700, exist_ok=False)
            base.sync_dir(backup.parent)
            pult.apply(stage, manifest, base, backup)
        else:
            pult.rollback(manifest, base, backup)
    finally:
        os.close(lock)


if __name__ == '__main__':
    main()

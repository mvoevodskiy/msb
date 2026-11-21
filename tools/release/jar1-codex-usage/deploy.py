#!/usr/bin/env python3
"""Use the reviewed bot transaction for the sealed Codex-usage file set."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys

BOT = ('src/sessions/codex-usage-sessions.mjs', 'src/sessions/ledger.mjs',
       'src/agent/codex-bootstrap.mjs', 'src/agent/turn.mjs', 'src/state.mjs',
       'src/autonomy/prompt-turn.mjs', 'src/autonomy/prompt-delivery.mjs',
       'src/autonomy/reminder-dispatch.mjs', 'src/autonomy/reminder-runs.mjs')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def trusted(stage, relative):
    path = stage
    if stage.parent != Path('/var/tmp') or stage.is_symlink(): raise RuntimeError('Unexpected stage')
    for part in Path(relative).parts[:-1]:
        path = path / part
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Untrusted stage directory')
    info = stage.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError('Untrusted stage root')
    fd = os.open(path / Path(relative).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Untrusted stage file')
        with os.fdopen(fd, 'rb', closefd=False) as stream: return stream.read()
    finally: os.close(fd)


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--stage', required=True)
    parser.add_argument('--manifest-sha', required=True)
    parser.add_argument('--usage-report-sha', required=True)
    options, rest = parser.parse_known_args()
    stage = Path(options.stage).absolute()
    if Path(__file__).resolve(strict=True) != stage / 'deploy.py': raise RuntimeError('Wrong deployment wrapper')
    manifest_data = trusted(stage, 'manifest.json')
    if hashlib.sha256(manifest_data).hexdigest() != options.manifest_sha: raise RuntimeError('Manifest mismatch')
    manifest = json.loads(manifest_data)
    if hashlib.sha256(trusted(stage, 'deploy_base.py')).hexdigest() != manifest['deploy_base_sha256']:
        raise RuntimeError('Base deployment operator changed')
    report = trusted(stage, 'test-home/results/usage-verification.json')
    if hashlib.sha256(report).hexdigest() != options.usage_report_sha:
        raise RuntimeError('Usage verification hash mismatch')
    proof = json.loads(report)
    if not proof.get('passed') or proof.get('source_commit') != manifest['source_commit'] or \
       proof.get('manifest_sha256') != options.manifest_sha or \
       proof.get('source_archive_sha256') != manifest['source_archive_sha256'] or \
       proof.get('composite_archive_sha256') != manifest['composite_archive_sha256'] or \
       hashlib.sha256(trusted(stage, 'composite.tar.gz')).hexdigest() != manifest['composite_archive_sha256']:
        raise RuntimeError('Usage verification does not belong to this release')
    if {row.get('suite') for row in proof.get('checks', [])} != {'usage-collector', 'usage-ui', 'usage-native', 'usage-release', 'usage-stop',
       'composite-session', 'composite-resume', 'composite-intro', 'composite-background', 'composite-claude'} or \
       any(row.get('exit_code') or row.get('passed', 0) <= 0 for row in proof['checks']):
        raise RuntimeError('Usage verification is incomplete')
    spec = importlib.util.spec_from_file_location('usage_deploy_base', stage / 'deploy_base.py')
    base = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(base)
    base.RELEASE_ORDER = [('bot', name) for name in BOT]
    base.ALLOWED = {'lib': set(), 'bin': set(), 'engine': set(), 'bot': set(BOT)}
    base.ADDED = {('bot', 'src/sessions/codex-usage-sessions.mjs')}
    sys.argv = [sys.argv[0], '--stage', str(stage), '--manifest-sha', options.manifest_sha, *rest]
    lock = base.open_directory('/var/lib/msb-ops/releases')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        base.main()
    finally:
        os.close(lock)


if __name__ == '__main__':
    if os.geteuid() != 0: raise RuntimeError('Root is required')
    main()

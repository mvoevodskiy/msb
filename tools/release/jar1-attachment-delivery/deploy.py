#!/usr/bin/env python3
"""JAR1-only checked wrapper around the audited atomic bot transaction."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import stat
import sys
sys.dont_write_bytecode = True


def sha(data): return hashlib.sha256(data).hexdigest()
def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path); result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result); return result


def trusted(stage, name):
    rel = Path(name)
    if rel.is_absolute() or not rel.parts or any(part in ('', '.', '..') for part in rel.parts):
        raise RuntimeError('Invalid stage path')
    parent = stage
    for part in (None, *rel.parts[:-1]):
        if part is not None: parent = parent / part
        st = parent.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError('Untrusted stage directory')
    fd = os.open(parent / rel.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError('Untrusted stage file ownership')
        with os.fdopen(fd, 'rb', closefd=False) as stream: return stream.read()
    finally: os.close(fd)


def valid_report(proof, manifest, manifest_sha):
    if proof.get('passed') is not True or proof.get('scope') != 'jar1-attachment-delivery-v1' or \
       proof.get('manifest_sha256') != manifest_sha or proof.get('source_commit') != manifest.get('source_commit') or \
       proof.get('source_archive_sha256') != manifest.get('source_archive_sha256'):
        raise RuntimeError('Verification is not for this candidate')
    minimum = {'media': 12, 'response': 12, 'plan': 10, 'history': 7, 'release': 6}
    checks = proof.get('checks')
    if not isinstance(checks, list) or len(checks) != len(minimum) or \
       {x.get('suite') for x in checks} != set(minimum) or any(
       type(x.get('passed')) is not int or x['passed'] < minimum[x['suite']] or
       x.get('exit_code') != 0 or x.get('skipped') != 0 or x.get('cancelled') != 0 for x in checks):
        raise RuntimeError('Focused verification is incomplete')
    env = proof.get('environment', {})
    if env.get('platform') != 'linux' or not re.fullmatch(r'v22\.\d+\.\d+', env.get('node', '')) or \
       not re.fullmatch(r'[0-9a-f]{64}', env.get('node_sha256', '')):
        raise RuntimeError('Unexpected tested environment')
    native = proof.get('native_identity', {})
    if set(native) != {'host_netns_inode', 'test_netns_inode', 'wrapper_sha256', 'binary_sha256'} or \
       any(type(native[k]) is not int or native[k] <= 0 for k in ('host_netns_inode', 'test_netns_inode')) or \
       native['host_netns_inode'] == native['test_netns_inode'] or \
       any(not re.fullmatch(r'[0-9a-f]{64}', native.get(k, '')) for k in ('wrapper_sha256', 'binary_sha256')):
        raise RuntimeError('No isolated identity proof')
    return env, native


def main():
    p = argparse.ArgumentParser(); p.add_argument('--stage', required=True); p.add_argument('--backup', required=True)
    p.add_argument('--manifest-sha', required=True); p.add_argument('--report-sha', required=True)
    op = p.add_mutually_exclusive_group(); op.add_argument('--apply', action='store_true'); op.add_argument('--rollback', action='store_true')
    p.add_argument('--queue-confirmed', action='store_true')
    a = p.parse_args(); stage = Path(a.stage).absolute()
    if os.geteuid() != 0 or socket.gethostname() != 'VM-422100' or stage.parent != Path('/var/tmp') or \
       Path(__file__).resolve(strict=True) != stage / 'deploy.py': raise RuntimeError('Unexpected JAR1 deployment context')
    if (a.apply or a.rollback) and not a.queue_confirmed:
        raise RuntimeError('Explicit Telegram queue/turn observation is required before restart')
    manifest_raw, proof_raw = trusted(stage, 'manifest.json'), trusted(stage, 'proof.json')
    if sha(manifest_raw) != a.manifest_sha or sha(proof_raw) != a.report_sha: raise RuntimeError('Manifest or proof changed')
    manifest, proof = json.loads(manifest_raw), json.loads(proof_raw)
    if manifest.get('schema') != 1 or manifest.get('scope') != 'jar1-attachment-delivery-v1' or \
       not re.fullmatch(r'[0-9a-f]{40}', manifest.get('source_commit', '')):
        raise RuntimeError('Unexpected manifest identity')
    tool_names = ('build.py', 'launcher.py', 'launcher_base.py', 'verify.py', 'deploy.py',
                  'deploy_base.py', 'runtime.py', 'profile_backup.py', 'profile.py')
    for name in tool_names:
        if sha(trusted(stage, name)) != manifest.get(name.removesuffix('.py') + '_sha256'):
            raise RuntimeError('Release tool changed')
    build = module('attachment_build', stage / 'build.py')
    inventory, support = build.prior_inventory(trusted(stage, 'prior.json'))
    if manifest.get('prior_sha256') != build.PRIOR_SHA or manifest.get('baseline_inventory') != inventory or \
       manifest.get('support_files') != support or manifest.get('dependencies') != build.DEPENDENCIES:
        raise RuntimeError('Baseline inventory changed')
    expected = [{'root': 'bot', 'relative': name, 'source': '.msb/bot/' + name,
                 'before_sha256': old, 'after_sha256': new} for name, (old, new) in build.FILES.items()]
    if manifest.get('files') != expected: raise RuntimeError('Unexpected runtime payload')
    if sha(trusted(stage, 'source.tar.gz')) != manifest.get('source_archive_sha256'):
        raise RuntimeError('Source archive changed')
    for row in expected:
        if sha(trusted(stage, 'payload/bot/' + row['relative'])) != row['after_sha256']:
            raise RuntimeError('Payload changed')
    environment, native = valid_report(proof, manifest, a.manifest_sha)
    base = module('attachment_audit_transaction', stage / 'deploy_base.py')
    base.RELEASE_ORDER = [('bot', name) for name in build.FILES]
    base.ALLOWED = {'lib': set(), 'bin': set(), 'engine': set(), 'bot': set(build.FILES)}
    base.ADDED = set()
    class Narrow(base.Deployment):
        def __init__(self, staged, backup, roots, host, manifest_sha, report_sha):
            if Path(staged) != stage or manifest_sha != a.manifest_sha or report_sha != a.report_sha:
                raise RuntimeError('Deployment identity changed')
            self.stage, self.backup, self.roots, self.host = Path(staged), Path(backup), {k: Path(v) for k,v in roots.items()}, host
            self.manifest, self.environment, self.native_proof = manifest, environment, native
        def check(self):
            super().check()
            for name in (*build.FILES, *build.DEPENDENCIES):
                row = base.info(base.safe_file(self.roots['bot'], name))
                if (row['uid'], row['gid'], row['mode']) != base.bot_owner():
                    raise RuntimeError('Unexpected runtime file ownership or mode: ' + name)
    base.Deployment = Narrow
    profile = module('attachment_profile', stage / 'profile.py')
    class BotOnlyHost(base.Host):
        def protected(self):
            return profile.protected(self.home, base)
        def configured_profile(self):
            audit = module('attachment_profile_backup', stage / 'profile_backup.py')
            return profile.configured(audit, base, self.home)
        def backup_profile(self, destination):
            return self.configured_profile().backup_profile(self.home, destination)
        def verify_active_session(self, destination):
            return self.configured_profile().assert_active_session_matches(self.home, destination)
    base.Host = BotOnlyHost
    sys.argv = [sys.argv[0], '--stage', str(stage), '--backup', a.backup,
                '--manifest-sha', a.manifest_sha, '--report-sha', a.report_sha]
    if a.apply: sys.argv.append('--apply')
    if a.rollback: sys.argv.append('--rollback')
    lock = base.open_directory('/var/lib/msb-ops/releases')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        base.main()
    finally: os.close(lock)

if __name__ == '__main__': main()

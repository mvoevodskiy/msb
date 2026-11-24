#!/usr/bin/env python3
"""Run the existing JAR1 atomic transaction for the sealed Telegram UX files."""
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
BACKUPS = Path('/var/lib/msb-ops/releases')
SUITES = {'core', 'overlay', 'reference', 'native-steer', 'release'}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def trusted(stage, name):
    relative = Path(name)
    if relative.is_absolute() or '..' in relative.parts or not relative.parts:
        raise RuntimeError('Invalid stage path')
    parent = stage
    for part in (None, *relative.parts[:-1]):
        if part is not None:
            parent /= part
        st = parent.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError('Untrusted stage directory')
    fd = os.open(parent / relative.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        st = os.fstat(stream.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError('Untrusted stage file')
        return stream.read()


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_proof(proof, manifest, manifest_sha, core_exclusions):
    if proof.get('passed') is not True or proof.get('manifest_sha256') != manifest_sha or any(
            proof.get(key) != manifest[key] for key in ('scope', 'source_commit', 'source_archive_sha256')):
        raise RuntimeError('Proof does not describe this candidate')
    checks = proof.get('checks')
    if not isinstance(checks, list) or len(checks) != len(SUITES) or {row.get('suite') for row in checks} != SUITES:
        raise RuntimeError('Required test suites are missing')
    if proof.get('core_exclusions') != core_exclusions:
        raise RuntimeError('Unexpected exclusions from the installed scope')
    for row in checks:
        if row.get('exit_code') != 0 or row.get('cancelled') != 0 or row.get('skipped') != 0 or \
                type(row.get('passed')) is not int or row['passed'] < 1:
            raise RuntimeError('Incomplete test suite: ' + row['suite'])
        if row['suite'] == 'native-steer' and row['passed'] != 1:
            raise RuntimeError('Native Codex test did not run exactly once')
    env = proof.get('environment', {})
    if env.get('platform') != 'linux' or not re.fullmatch(r'v22\.\d+\.\d+', env.get('node', '')) or \
            not re.fullmatch(r'[0-9a-f]{64}', env.get('node_sha256', '')):
        raise RuntimeError('Unexpected Node environment')
    native = proof.get('native_identity', {})
    if set(native) != {'host_netns_inode', 'test_netns_inode', 'wrapper_sha256', 'binary_sha256'} or \
            any(type(native[k]) is not int or native[k] <= 0 for k in ('host_netns_inode', 'test_netns_inode')) or \
            native['host_netns_inode'] == native['test_netns_inode'] or \
            any(not re.fullmatch(r'[0-9a-f]{64}', native.get(k, '')) for k in ('wrapper_sha256', 'binary_sha256')):
        raise RuntimeError('Isolated Codex identity is missing')
    return env, native


def verify_payload(stage, manifest, builder):
    if manifest.get('schema') != 1 or manifest.get('scope') != builder.SCOPE or \
            not re.fullmatch(r'[0-9a-f]{40}', manifest.get('source_commit', '')) or \
            manifest.get('base_commit') != builder.BASE_COMMIT or manifest.get('prior_sha256') != builder.BASE_MANIFEST:
        raise RuntimeError('Unexpected release identity')
    baseline, support = builder.installed_inventory(trusted(stage, 'prior.json'))
    if manifest.get('baseline_inventory') != baseline or manifest.get('support_files') != support:
        raise RuntimeError('Installed baseline changed')
    before = {(row['root'], row['relative']): row['sha256'] for row in baseline}
    expected = [{'root': 'bot', 'relative': name, 'source': builder.source_path('bot', name),
                 'before_sha256': before.get(('bot', name)), 'after_sha256': sha(trusted(stage, 'payload/bot/' + name))}
                for name in builder.FILES]
    if manifest.get('files') != expected or sha(trusted(stage, 'source.tar.gz')) != manifest.get('source_archive_sha256'):
        raise RuntimeError('Released source or payload changed')
    return expected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('stage', 'backup', 'manifest-sha', 'report-sha'):
        parser.add_argument('--' + name, required=True)
    action = parser.add_mutually_exclusive_group()
    action.add_argument('--apply', action='store_true')
    action.add_argument('--rollback', action='store_true')
    parser.add_argument('--queue-confirmed', action='store_true')
    args = parser.parse_args()
    stage = Path(args.stage).absolute()
    if os.geteuid() != 0 or socket.gethostname() != 'VM-422100' or stage.parent != Path('/var/tmp') or \
            Path(__file__).resolve(strict=True) != stage / 'deploy.py':
        raise RuntimeError('Unexpected JAR1 deployment context')
    if (args.apply or args.rollback) and not args.queue_confirmed:
        raise RuntimeError('Observe the Telegram turn and queue before restarting')
    manifest_raw, proof_raw = (trusted(stage, name) for name in ('manifest.json', 'proof.json'))
    if sha(manifest_raw) != args.manifest_sha or sha(proof_raw) != args.report_sha:
        raise RuntimeError('Manifest or test proof changed')
    manifest, proof = json.loads(manifest_raw), json.loads(proof_raw)
    if sha(trusted(stage, 'build.py')) != manifest.get('build_sha256'):
        raise RuntimeError('Builder changed')
    builder = load('ux_build', stage / 'build.py')
    for name in builder.TOOLS:
        if sha(trusted(stage, name)) != manifest.get(name.removesuffix('.py') + '_sha256'):
            raise RuntimeError('Release tool changed: ' + name)
    expected = verify_payload(stage, manifest, builder)
    verifier = load('ux_verify', stage / 'verify.py')
    environment, native = verify_proof(proof, manifest, args.manifest_sha, verifier.CORE_EXCLUSIONS)

    base = load('ux_audit_transaction', stage / 'deploy_base.py')
    profile = load('ux_profile', stage / 'profile.py')
    base.RELEASE_ORDER = [('bot', name) for name in builder.FILES]
    base.ALLOWED = {'lib': set(), 'bin': set(), 'engine': set(), 'bot': set(builder.FILES)}
    base.ADDED = {('bot', name) for name in builder.ADDED}

    class ScopedRelease(base.Deployment):
        def __init__(self, staged, backup, roots, host, manifest_sha, proof_sha):
            if Path(staged) != stage or manifest_sha != args.manifest_sha or proof_sha != args.report_sha:
                raise RuntimeError('Deployment identity changed')
            self.stage, self.backup = stage, Path(backup)
            self.roots, self.host = {key: Path(value) for key, value in roots.items()}, host
            self.manifest, self.environment, self.native_proof = manifest, environment, native

        def check(self):
            super().check()
            uid, gid, _ = base.bot_owner()
            for item in expected:
                if item['before_sha256'] is None:
                    continue
                row = base.info(base.safe_file(self.roots['bot'], item['relative']))
                if (row['uid'], row['gid']) != (uid, gid) or row['mode'] not in (0o644, 0o664):
                    raise RuntimeError('Unexpected runtime file owner or mode: ' + item['relative'])

    class BotHost(base.Host):
        def protected(self):
            return profile.protected(self.home, base)

        def configured_profile(self):
            audit = load('ux_profile_backup', stage / 'profile_backup.py')
            return profile.configured(audit, base, self.home)

        def backup_profile(self, destination):
            return self.configured_profile().backup_profile(self.home, destination)

        def verify_active_session(self, destination):
            return self.configured_profile().assert_active_session_matches(self.home, destination)

    base.Deployment, base.Host = ScopedRelease, BotHost
    sys.argv = [sys.argv[0], '--stage', str(stage), '--backup', args.backup,
                '--manifest-sha', args.manifest_sha, '--report-sha', args.report_sha]
    if args.apply:
        sys.argv.append('--apply')
    if args.rollback:
        sys.argv.append('--rollback')
    lock = base.open_directory(BACKUPS)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        base.main()
    finally:
        os.close(lock)


if __name__ == '__main__':
    main()

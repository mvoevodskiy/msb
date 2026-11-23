#!/usr/bin/env python3
"""Focused, isolated Telegram delivery checks against the sealed candidate snapshot."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile

SUITES = {
 'media': (['outbound-media-response', 'media-markers', 'send-media'], 12),
 'response': (['response-delivery'], 12),
 'plan': (['plan-handoff'], 10),
 'history': (['steer-history'], 7),
}

def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path); result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result); return result


def verify_source(stage, manifest):
    archive, source = stage / 'source.tar.gz', stage / 'source'
    if sha(archive) != manifest['source_archive_sha256']: raise RuntimeError('Source archive changed')
    expected = set()
    with tarfile.open(archive, 'r:gz') as tar:
        for item in tar:
            rel = Path(item.name)
            if rel.is_absolute() or '..' in rel.parts or rel.as_posix() in expected: raise RuntimeError('Unsafe source entry')
            expected.add(rel.as_posix()); target = source / rel
            if item.isdir():
                if target.is_symlink() or not target.is_dir(): raise RuntimeError('Source directory changed')
            elif item.isfile():
                if target.is_symlink() or not target.is_file() or sha(target) != hashlib.sha256(tar.extractfile(item).read()).hexdigest():
                    raise RuntimeError('Source file changed')
            elif item.issym():
                if not target.is_symlink() or os.readlink(target) != item.linkname: raise RuntimeError('Source link changed')
            else: raise RuntimeError('Unexpected source entry type')
    links = {'source/.msb/bot/node_modules': '/home/client/.msb/bot/node_modules',
             'source/overlay/bot/node_modules': '/home/client/.msb/bot/node_modules'}
    for path, target in links.items():
        link = stage / path
        if not link.is_symlink() or os.readlink(link) != target: raise RuntimeError('Dependency link changed')
    actual = {p.relative_to(source).as_posix() for p in source.rglob('*')}
    extras = {p.removeprefix('source/') for p in links}
    if actual - expected != extras or expected - actual: raise RuntimeError('Source snapshot inventory changed')
    for row in manifest['files']:
        if sha(source / row['source']) != row['after_sha256'] or sha(stage / 'payload/bot' / row['relative']) != row['after_sha256']:
            raise RuntimeError('Test source differs from release payload')


def suite(name, tests, minimum, source, env, node):
    args = [str(node), '--test', '--test-concurrency=1'] + [str(source / '.msb/bot/tests' / (t + '.test.mjs')) for t in tests]
    run = subprocess.run(args, cwd=source, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=300)
    def count(label):
        matches = re.findall(r'^(?:#|ℹ)\s*' + label + r'\s+(\d+)\s*$', run.stdout, re.M)
        if not matches: raise RuntimeError('Missing test summary for ' + name)
        return int(matches[-1])
    passed, failed, skipped, cancelled = (count(key) for key in ('pass', 'fail', 'skipped', 'cancelled'))
    if run.returncode or passed < minimum or failed or skipped or cancelled: raise RuntimeError('Focused suite failed: ' + name)
    return {'suite': name, 'exit_code': 0, 'passed': passed, 'skipped': skipped, 'cancelled': cancelled}


def verify(stage, home, tmp_dir, host_netns):
    stage, home, tmp_dir = Path(stage).resolve(), Path(home).resolve(), Path(tmp_dir).resolve()
    if home != Path('/tmp/msb-attachment-home') or tmp_dir != Path('/tmp') or not home.is_dir():
        raise RuntimeError('Unexpected isolated HOME')
    test_netns = os.stat('/proc/self/ns/net').st_ino
    if test_netns == host_netns: raise RuntimeError('Network is not isolated')
    links = subprocess.check_output(['ip', '-o', 'link', 'show'], text=True).splitlines()
    if len(links) != 1 or not re.match(r'^\d+: lo:', links[0]): raise RuntimeError('Unexpected network interfaces')
    manifest = json.loads((stage / 'manifest.json').read_text()); verify_source(stage, manifest)
    runtime = module('attachment_runtime', stage / 'runtime.py')
    base = module('attachment_audit_base', stage / 'deploy_base.py')
    environment = runtime.runtime_info(stage / 'source/.msb/bot/package-lock.json', '/home/client/.msb/bot/node_modules')
    if environment.get('platform') != 'linux' or not re.fullmatch(r'v22\.\d+\.\d+', environment.get('node', '')):
        raise RuntimeError('Expected Linux and Node 22')
    fingerprint = base.cli_fingerprint()
    node = Path(shutil.which('node', path='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')).resolve()
    env = {'HOME': str(home), 'TMPDIR': str(tmp_dir), 'PATH': '/usr/local/bin:/usr/bin:/bin',
           'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}
    checks = [suite(name, paths, minimum, stage / 'source', env, node) for name, (paths, minimum) in SUITES.items()]
    release = subprocess.run([sys.executable, '-B', '-m', 'unittest', 'discover', '-s',
        str(stage / 'source/tools/release/jar1-attachment-delivery'), '-p', 'test_*.py', '-v'],
        cwd=stage / 'source', env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
    matches = re.findall(r'^Ran (\d+) tests?', release.stdout, re.M)
    if release.returncode or not matches or int(matches[-1]) < 6 or 'skipped=' in release.stdout:
        raise RuntimeError('Release operator tests failed')
    checks.append({'suite': 'release', 'exit_code': 0, 'passed': int(matches[-1]), 'skipped': 0, 'cancelled': 0})
    if runtime.runtime_info(stage / 'source/.msb/bot/package-lock.json', '/home/client/.msb/bot/node_modules') != environment or \
       base.cli_fingerprint() != fingerprint or os.stat('/proc/self/ns/net').st_ino != test_netns:
        raise RuntimeError('Runtime identity changed during focused tests')
    native = {'host_netns_inode': host_netns, 'test_netns_inode': test_netns, **fingerprint}
    verify_source(stage, manifest)
    return {'scope': manifest['scope'], 'source_commit': manifest['source_commit'],
      'manifest_sha256': sha(stage / 'manifest.json'), 'source_archive_sha256': manifest['source_archive_sha256'],
      'environment': environment, 'native_identity': native, 'checks': checks, 'passed': True}


if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--stage', required=True); p.add_argument('--home', required=True)
    p.add_argument('--tmp-dir', required=True); p.add_argument('--host-netns-inode', type=int, required=True)
    p.add_argument('--dependencies', required=True)
    a = p.parse_args()
    if a.dependencies != '/home/client/.msb/bot/node_modules': raise RuntimeError('Unexpected dependencies')
    print(json.dumps(verify(a.stage, a.home, a.tmp_dir, a.host_netns_inode)), flush=True)

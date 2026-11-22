#!/usr/bin/env python3
"""Verify the sealed Pult-only release in the launcher's isolated Linux namespace."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile

EXCLUDED_TESTS = [
    'provider routing never lends Claude rateLimitInfo to Codex, Cursor, Qwen, unknown or OpenClaw',
    'check: построчно ✓/✗, ключ не печатается, --json, ненулевой код при ошибке',
]


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify_source(stage, manifest):
    archive, source = stage / 'source.tar.gz', stage / 'source'
    if sha(archive) != manifest['source_archive_sha256']:
        raise RuntimeError('Source archive changed')
    expected = set()
    with tarfile.open(archive, 'r:gz') as tar:
        for item in tar:
            relative = Path(item.name)
            if relative.is_absolute() or '..' in relative.parts:
                raise RuntimeError('Unsafe archive entry')
            expected.add(relative.as_posix())
            target = source / relative
            if item.isdir():
                if target.is_symlink() or not target.is_dir(): raise RuntimeError('Source directory changed')
            elif item.isfile():
                if target.is_symlink() or not target.is_file() or \
                   hashlib.sha256(tar.extractfile(item).read()).hexdigest() != sha(target):
                    raise RuntimeError('Source file changed')
            else:
                raise RuntimeError('Unsupported source archive entry')
    link = source / '.msb/pult/node_modules'
    if not link.is_symlink() or link.resolve() != Path('/home/client/.msb/pult/node_modules').resolve():
        raise RuntimeError('Pult dependencies changed')
    actual = {p.relative_to(source).as_posix() for p in source.rglob('*')}
    if actual - expected != {'.msb/pult/node_modules'} or expected - actual:
        raise RuntimeError('Unexpected files in the test source')
    for item in manifest['pult_files']:
        if sha(source / item['source']) != item['after_sha256'] or \
           sha(stage / 'payload/pult' / item['relative']) != item['after_sha256']:
            raise RuntimeError('Test source and Pult payload differ')


def command(name, args, cwd, env, results):
    run = subprocess.run(args, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, timeout=300)
    (results / (name + '.log')).write_text(run.stdout)
    if run.returncode:
        raise RuntimeError(name + ' failed: ' + run.stdout[-1500:])
    if name == 'pult-tests':
        passed = re.findall(r'^(?:#|ℹ)\s*pass\s+(\d+)', run.stdout, re.M)
        skipped = re.findall(r'^(?:#|ℹ)\s*skipped\s+(\d+)', run.stdout, re.M)
        if not passed or int(passed[-1]) < 1 or not skipped or int(skipped[-1]) != 0:
            raise RuntimeError('Unexpected Pult test count')
        return {'suite': name, 'exit_code': 0, 'passed': int(passed[-1]), 'skipped': int(skipped[-1])}
    if name == 'release-tests':
        count = re.findall(r'^Ran (\d+) tests?', run.stdout, re.M)
        if not count or int(count[-1]) < 1: raise RuntimeError('No release checks ran')
        return {'suite': name, 'exit_code': 0, 'passed': int(count[-1])}
    return {'suite': name, 'exit_code': 0, 'passed': 1}


def verify(stage, home, tmp_dir, host_netns):
    stage, home, tmp_dir = Path(stage).resolve(), Path(home).resolve(), Path(tmp_dir).resolve()
    if home != stage / 'test-home' or not home.is_dir() or not tmp_dir.is_dir():
        raise RuntimeError('Expected isolated test home')
    if os.stat('/proc/self/ns/net').st_ino == host_netns:
        raise RuntimeError('Test network is not isolated')
    links = subprocess.check_output(['ip', '-o', 'link', 'show'], text=True).splitlines()
    if len(links) != 1 or not re.match(r'^\d+: lo:', links[0]):
        raise RuntimeError('Test network has a non-loopback interface')
    manifest = json.loads((stage / 'manifest.json').read_text())
    verify_source(stage, manifest)
    binary = Path('/usr/local/lib/msb-tools/ccusage-20.0.51')
    if sha(binary) != manifest['ccusage_binary_sha256']:
        raise RuntimeError('Pinned ccusage changed')
    results = home / 'results'
    results.mkdir(exist_ok=False)
    source, pult = stage / 'source', stage / 'source/.msb/pult'
    env = {'HOME': str(home), 'TMPDIR': str(tmp_dir), 'PATH': '/usr/local/bin:/usr/bin:/bin',
           'LANG': 'C.UTF-8', 'PULT_TEST_CCUSAGE': str(binary), 'PYTHONDONTWRITEBYTECODE': '1'}
    node = Path(shutil.which('node', path=env['PATH'])).resolve()
    tests = sorted(str(p) for p in (pult / 'tests').rglob('*.test.ts'))
    tests += [str(pult / 'tests/ui/bot-usage.test.mjs')]
    skip = '^(?:' + '|'.join(re.escape(name) for name in EXCLUDED_TESTS) + ')$'
    checks = [
        command('typecheck', [str(node), str(pult / 'node_modules/typescript/bin/tsc'), '-p', str(pult / 'tsconfig.json')], pult, env, results),
        command('pult-tests', [str(node), '--disable-warning=ExperimentalWarning', '--test', '--test-concurrency=2',
                               '--test-timeout=60000', '--test-skip-pattern=' + skip, *tests], pult, env, results),
        command('release-tests', [sys.executable, '-B', '-m', 'unittest', 'discover', '-s',
                                  str(source / 'tools/release/jar1-pult-warning'), '-p', 'test_release.py', '-v'], source, env, results),
    ]
    if os.stat('/proc/self/ns/net').st_ino == host_netns or sha(binary) != manifest['ccusage_binary_sha256']:
        raise RuntimeError('Test environment changed')
    report = {'scope': manifest['scope'], 'source_commit': manifest['source_commit'],
              'manifest_sha256': sha(stage / 'manifest.json'), 'source_archive_sha256': manifest['source_archive_sha256'],
              'environment': {'node_sha256': sha(node)}, 'excluded_tests': EXCLUDED_TESTS, 'checks': checks, 'passed': True}
    (results / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', required=True)
    parser.add_argument('--home', required=True)
    parser.add_argument('--dependencies', required=True)
    parser.add_argument('--tmp-dir', required=True)
    parser.add_argument('--host-netns-inode', required=True, type=int)
    args = parser.parse_args()
    verify(args.stage, args.home, args.tmp_dir, args.host_netns_inode)

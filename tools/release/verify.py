#!/usr/bin/env python3
"""Offline checks of an immutable artifact and its same-commit test snapshot."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from manifest import digest, validate_release, validate_test_snapshot


def dependency_check(stage, dependencies):
    lock = json.loads((stage / 'runtime/bot/package-lock.json').read_text())
    differences, versions = [], {}
    for name, value in lock['packages'].items():
        if not name:
            continue
        if not name.startswith('node_modules/') or '..' in Path(name).parts:
            raise ValueError('Unexpected dependency lock path')
        file = dependencies / name.removeprefix('node_modules/') / 'package.json'
        versions[name] = json.loads(file.read_text()).get('version') if file.exists() else None
        if not file.exists():
            if not value.get('optional'):
                differences.append(name + ': missing')
        elif json.loads(file.read_text()).get('version') != value.get('version'):
            differences.append(name + ': version mismatch')
    if differences:
        raise ValueError('; '.join(differences))
    return {'packages': len(versions), 'versions_sha256': hashlib.sha256(json.dumps(versions, sort_keys=True).encode()).hexdigest()}


def verify(stage, dependencies, node='node'):
    stage, dependencies = Path(stage).resolve(), Path(dependencies).resolve()
    release, expected = validate_release(stage)
    validate_test_snapshot(stage, release)
    source = stage / 'checks/source'
    for item in release['files']:
        if digest(source / item['source']) != item['sha256']:
            raise ValueError('Test snapshot is not byte-identical to release source: ' + item['source'])
    for relative in ['.msb/bot/node_modules', 'overlay/bot/node_modules']:
        link = source / relative
        if link.exists() or link.is_symlink():
            if not link.is_symlink() or link.resolve() != dependencies:
                raise ValueError('Unexpected test dependency directory')
        else:
            link.symlink_to(dependencies)
    checks = []
    results = stage / 'checks/results'
    results.mkdir(exist_ok=True)
    def run(name, argv, cwd, env):
        timeout = 300 if name == 'core' else 180
        value = subprocess.run(argv, cwd=cwd, env=env, text=True, capture_output=True, timeout=timeout)
        output = value.stdout + value.stderr
        (results / (name + '.log')).write_text(output)
        checks.append({'suite': name, 'exit_code': value.returncode, 'summary': output.splitlines()[-10:]})
        print(json.dumps(checks[-1]), flush=True)
    clean_home = stage / 'checks/test-home'
    clean_home.mkdir(exist_ok=True)
    env = {'HOME': str(clean_home), 'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LANG': 'C.UTF-8',
           'MSB_RUNTIME_PROFILE': 'msb', 'PYTHONDONTWRITEBYTECODE': '1'}
    dependency_identity = dependency_check(stage, dependencies)
    checks.append({'suite': 'dependencies', 'exit_code': 0, 'identity': dependency_identity,
                   'scope': 'installed versions versus committed lock; no package installation'})
    syntax = [str(stage / 'runtime' / n) for n in expected if n.endswith(('.mjs', '.js', '.cjs'))]
    failures = []
    for file in syntax:
        result = subprocess.run([node, '--check', file], env=env, text=True, capture_output=True, timeout=20)
        if result.returncode:
            failures.append({'file': str(Path(file).relative_to(stage)), 'error': result.stderr})
    checks.append({'suite': 'syntax', 'exit_code': int(bool(failures)), 'files': len(syntax), 'failures': failures})
    for name, patterns in [('core', ['.msb/bot/tests/*.test.mjs']),
                           ('overlay', ['overlay/bot/ext/tests/*.test.mjs']),
                           ('reference', ['.msb/bot/tests/reference/*.test.mjs', 'overlay/bot/ext/tests/reference/*.test.mjs'])]:
        files = [str(p.relative_to(source)) for pattern in patterns for p in sorted(source.glob(pattern))]
        if not files:
            raise ValueError('Empty required test suite: ' + name)
        run(name, [node, '--test', *files], source, env)
    run('release-tools', [sys.executable, '-m', 'unittest', 'discover', '-s', 'tools/release/tests', '-v'], source, env)
    run('profile-smoke', [node, str(stage / 'ops/profile-smoke.mjs'), str(stage / 'runtime')], stage,
        {'HOME': str(clean_home), 'PATH': env['PATH'], 'LANG': 'C.UTF-8'})
    count = validate_test_snapshot(stage, release)
    checks.append({'suite': 'test-snapshot', 'exit_code': 0, 'files': count})
    result = {'environment': {'platform': sys.platform, 'node': subprocess.check_output([node, '--version'], text=True).strip(), 'dependencies': dependency_identity}, 'source_commit': release['source_commit'], 'release_sha256': digest(stage / 'release.json'),
              'checks': checks, 'passed': all(c['exit_code'] == 0 for c in checks)}
    (results / 'verification.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--dependencies', type=Path, required=True)
    parser.add_argument('--node', default='node')
    args = parser.parse_args()
    result = verify(args.stage, args.dependencies, args.node)
    raise SystemExit(0 if result['passed'] else 1)

if __name__ == '__main__':
    main()

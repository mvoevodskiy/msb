#!/usr/bin/env python3
"""Verify the sealed UX release in the launcher's disposable JAR1 namespace."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True

SCOPE = 'jar1-ux-v1'
DEPENDENCIES = '/home/client/.msb/bot/node_modules'
NATIVE_VERSION = 'codex-cli 0.166.0'
NATIVE_TEST = '.msb/bot/tests/codex-steer-native.test.mjs'
SUITE_NAMES = ('core', 'overlay', 'reference', 'native-steer', 'release')
# The accepted 9fd804f composite contains Codex wake, the older Python marker
# interface, and no OpenClaw state reconciler. Other cases in these files run.
CORE_EXCLUSIONS = {
    'files': ['.msb/bot/tests/engine-wake-fallback.test.mjs'],
    'cases': [
        'a different selected provider retains the existing wake route',
        'Telegram wake falls back to the real request publisher and resumes the selected Cursor session after an OK result',
        'a later sleep before the system consumes wake wins over the older request',
        'Node marker revisions are compared by the real Python system worker',
        'a new sleep marker after the helper wake is not erased by the older callback',
        'known removed OpenClaw clears a stale sleep marker; unknown status does not',
        'an older OpenClaw snapshot cannot cancel a newly written sleep marker',
        'auto-wake cannot erase a later sleep written by the Python system component',
        'unknown OpenClaw installation is not shown as absent',
        'an off request with a still active gateway is not shown as completed',
        'an off request with an unknown gateway is not shown as completed',
        'a running gateway does not imply its setup is complete',
        'failed stopping remains visible even if the setup was incomplete',
    ],
}
TEST_ROOTS = {
    'core': ('.msb/bot/tests',),
    'overlay': ('overlay/bot/ext/tests',),
    'reference': ('.msb/bot/tests/reference', 'overlay/bot/ext/tests/reference'),
}
PAUSED_PROVIDER = re.compile(r'openclaw|(?:^|[._-])oc(?:$|[._-])', re.IGNORECASE)
NODE_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'


class VerificationError(RuntimeError):
    """An operator-safe diagnostic that omits captured test output."""


def load_module(stage, name):
    spec = importlib.util.spec_from_file_location('jar1_ux_' + name, stage / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def network_inode(host_netns):
    inode = os.stat('/proc/self/ns/net').st_ino
    if host_netns <= 0 or inode == host_netns or {name for _, name in socket.if_nameindex()} != {'lo'}:
        raise VerificationError('Expected a separate loopback-only network namespace')
    return inode


def run(argv, source, env, timeout):
    # Keep raw test output inside the private namespace, including on failure.
    with tempfile.TemporaryFile() as output:
        child = subprocess.Popen(argv, cwd=source, env=env, stdout=output, stderr=subprocess.STDOUT,
                                 start_new_session=True)
        try:
            code = child.wait(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
            raise VerificationError(f'timed out after {timeout}s') from error
        output.seek(0)
        return code, output.read().decode('utf-8', errors='replace')


def passed_check(name, count):
    return {'suite': name, 'exit_code': 0, 'passed': count, 'skipped': 0, 'cancelled': 0}


def tap_failures(output, files, source):
    # Names printed by tests can be dynamic. Report only selected snapshot
    # paths and titles found literally in that test's checked-in source.
    known = {}
    for file in files:
        absolute = (source / file).as_posix()
        known.update({file: file, absolute: file, 'file://' + absolute: file})
    failures = list(re.finditer(r'^\s*not ok (\d+) - ([^\r\n]+)$', output, re.MULTILINE))
    details = []
    for index, match in enumerate(failures[:3]):
        number, title = match.groups()
        file = known.get(title)
        evidence = f'TAP case {number}'
        end = failures[index + 1].start() if index + 1 < len(failures) else len(output)
        next_line = output[match.end():end].splitlines()[:12]
        for line in next_line:
            found = re.fullmatch(r"""\s*location: ['"](.+):(\d+):(\d+)['"]\s*""", line)
            if found and found[1] in known:
                file = known[found[1]]
                evidence = f'{file}:{found[2]}'
                break
        else:
            if file:
                evidence = file
        if file and len(title) <= 100 and title not in known:
            source_text = (source / file).read_text(encoding='utf-8', errors='replace')
            if any(f'test({quote}{title}{quote}' in source_text for quote in ("'", '"')):
                evidence += ' (' + title + ')'
        details.append(evidence)
    return '; first failures: ' + ', '.join(details) if details else ''


def node_suite(name, files, source, env, node):
    if not files:
        raise VerificationError('not run: no test files')
    expected = CORE_EXCLUSIONS['cases'] if name == 'core' else []
    names = '|'.join(map(re.escape, expected))
    options = ['--test-skip-pattern=^(?:' + names + ')$'] if expected else []
    if expected:
        declarations = re.compile(r"test\('(" + names + r")',")
        found = [title for file in files for title in declarations.findall((source / file).read_text())]
        if sorted(found) != sorted(expected):
            raise VerificationError('The audited excluded case declarations changed')
    code, output = run([node, '--test', '--test-reporter=tap', '--test-concurrency=1', *options,
                        *files], source, env, 600 if name == 'core' else 120)
    counts = {}
    for label in ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'):
        matches = re.findall(rf'^# {label} (\d+)\s*$', output, re.MULTILINE)
        if not matches:
            raise VerificationError(f'no complete TAP summary (exit {code})'
                                    + tap_failures(output, files, source))
        counts[label] = int(matches[-1])
    passed = counts['pass']
    if expected and re.search(r'^ *(?:not )?ok \d+ - (?:' + names + r')$', output, re.MULTILINE):
        raise VerificationError('A case outside the installed scope ran')
    if code or passed <= 0 or counts['tests'] != passed or any(
            counts[label] for label in ('fail', 'cancelled', 'skipped', 'todo')):
        raise VerificationError(f'exit {code}, pass {passed}, fail {counts["fail"]}, '
                                f'cancelled {counts["cancelled"]}, skipped {counts["skipped"]}, '
                                f'todo {counts["todo"]}' + tap_failures(output, files, source))
    return passed_check(name, passed)


def test_files(source, roots):
    excluded = {NATIVE_TEST, *CORE_EXCLUSIONS['files']}
    return [file.relative_to(source).as_posix() for root in roots
            for file in sorted((source / root).glob('*.test.mjs'))
            if not PAUSED_PROVIDER.search(file.name) and file.relative_to(source).as_posix() not in excluded]


def native_check(source, env, node, binary):
    if not (source / NATIVE_TEST).is_file():
        raise VerificationError('not run: native steering test is missing')
    try:
        version = subprocess.run([binary, '--version'], cwd=source, env=env, text=True,
                                 capture_output=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise VerificationError('not run: could not execute the pinned Codex CLI') from error
    if version.returncode or version.stdout.strip() != NATIVE_VERSION:
        raise VerificationError('not run: expected Codex CLI 0.166.0')
    check = node_suite('native-steer', [NATIVE_TEST], source, {**env, 'MSB_TEST_CODEX_NATIVE': binary}, node)
    if check['passed'] != 1:
        raise VerificationError('Expected exactly one native steering assertion')
    return check


def release_check(source, env, directory='tools/release/jar1-ux'):
    code, output = run([sys.executable, '-B', '-m', 'unittest', 'discover', '-s',
                        directory, '-p', 'test_*.py', '-v'], source, env, 120)
    count = re.search(r'^Ran (\d+) tests? in ', output, re.MULTILINE)
    if code or not count or int(count[1]) <= 0 or not re.search(r'^OK$', output, re.MULTILINE):
        raise VerificationError(f'operator tests did not all pass (exit {code}, ran {count[1] if count else "unknown"})')
    return passed_check('release', int(count[1]))


def verify(stage, home, tmp_dir, host_netns, dependencies=DEPENDENCIES, *,
           scope=SCOPE, required_core=(), extra_release_suite=None):
    stage, home, tmp_dir = (Path(value).resolve() for value in (stage, home, tmp_dir))
    if home != Path('/tmp/msb-attachment-home') or not home.is_dir() or tmp_dir != Path('/tmp'):
        raise VerificationError('Unexpected isolated HOME or temporary directory')
    if dependencies != DEPENDENCIES:
        raise VerificationError('Unexpected dependencies')
    test_netns = network_inode(host_netns)
    manifest_path = stage / 'manifest.json'
    manifest_raw = manifest_path.read_bytes()
    manifest = json.loads(manifest_raw)
    if manifest.get('scope') != scope or not re.fullmatch(r'[0-9a-f]{40}', manifest.get('source_commit', '')):
        raise VerificationError('Unexpected release manifest identity')
    source = stage / 'source'
    source_guard = load_module(stage, 'source_guard')
    runtime = load_module(stage, 'runtime')
    base = load_module(stage, 'deploy_base')
    source_guard.verify_source(stage, manifest)
    lock = source / '.msb/bot/package-lock.json'
    environment = runtime.runtime_info(lock, dependencies)
    node = shutil.which('node', path=NODE_PATH)
    if not node or environment.get('platform') != 'linux' or not re.fullmatch(r'v22\.\d+\.\d+', environment.get('node', '')):
        raise VerificationError('Expected Linux and Node 22')
    fingerprint = base.cli_fingerprint()
    env = {'HOME': str(home), 'TMPDIR': str(tmp_dir), 'PATH': '/usr/local/bin:/usr/bin:/bin',
           'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1', 'MSB_RUNTIME_PROFILE': 'msb'}

    checks, failures = [], []
    for name in SUITE_NAMES:
        try:
            if name == 'native-steer':
                check = native_check(source, env, node, base.NATIVE_BINARY)
            elif name == 'release':
                check = release_check(source, env)
                if extra_release_suite:
                    extra = release_check(source, env, extra_release_suite)
                    check = passed_check(name, check['passed'] + extra['passed'])
            else:
                files = test_files(source, TEST_ROOTS[name])
                if name == 'core' and not set(required_core).issubset(files):
                    raise VerificationError('Required scoped regression tests are missing')
                check = node_suite(name, files, source, env, node)
            checks.append(check)
        except VerificationError as error:
            failures.append(f'{name}: {error}')
        except (OSError, ValueError) as error:
            failures.append(f'{name}: could not complete ({type(error).__name__})')
    try:
        if manifest_path.read_bytes() != manifest_raw or network_inode(host_netns) != test_netns \
                or runtime.runtime_info(lock, dependencies) != environment or base.cli_fingerprint() != fingerprint:
            raise VerificationError('Release or runtime identity changed during verification')
    except VerificationError as error:
        failures.append(f'final runtime integrity: {error}')
    except Exception as error:
        failures.append(f'final runtime integrity check failed ({type(error).__name__})')
    try:
        source_guard.verify_source(stage, manifest)
    except Exception as error:
        failures.append(f'final source integrity check failed ({type(error).__name__})')
    if failures:
        raise VerificationError('\n'.join(failures))

    return {
        'scope': scope, 'source_commit': manifest['source_commit'],
        'manifest_sha256': hashlib.sha256(manifest_raw).hexdigest(),
        'source_archive_sha256': manifest['source_archive_sha256'],
        'environment': environment,
        'native_identity': {'host_netns_inode': host_netns, 'test_netns_inode': test_netns, **fingerprint},
        'checks': checks, 'core_exclusions': CORE_EXCLUSIONS, 'passed': True,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', required=True)
    parser.add_argument('--home', required=True)
    parser.add_argument('--tmp-dir', required=True)
    parser.add_argument('--host-netns-inode', type=int, required=True)
    parser.add_argument('--dependencies', required=True)
    args = parser.parse_args()
    try:
        proof = verify(args.stage, args.home, args.tmp_dir, args.host_netns_inode, args.dependencies)
    except VerificationError as error:
        message = str(error)
        if not any(message.startswith(name + ':') for name in SUITE_NAMES) and not message.startswith('final '):
            message = 'Preflight failed: ' + message + '. Suites not run: ' + ', '.join(SUITE_NAMES)
        print(message, file=sys.stderr)
        return 1
    except Exception as error:
        print(f'Preflight failed ({type(error).__name__}). Suites not run: ' + ', '.join(SUITE_NAMES),
              file=sys.stderr)
        return 1
    print(json.dumps(proof), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())

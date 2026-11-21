#!/usr/bin/env python3
"""Test a sealed release source in a synthetic HOME; exclude the paused provider."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tarfile
from runtime import runtime_info


def sha(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def run_command(argv, cwd, env, log, timeout):
    with Path(log).open('w') as output:
        process = subprocess.Popen(argv, cwd=cwd, env=env, text=True,
                                   stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            output.write('\nVerification suite exceeded its time limit.\n')
            raise TimeoutError('Verification timed out; partial log: ' + str(log)) from exc
    return code, Path(log).read_text()


NATIVE_CLI = '/home/client/.msb/ext-tools/bin/codex'
NATIVE_WRAPPER = '/home/client/.msb/ext-tools/lib/node_modules/@openai/codex/bin/codex.js'
NATIVE_BINARY = '/home/client/.msb/ext-tools/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
NATIVE_VERSION = 'codex-cli 0.166.0'

def require_loopback_only():
    names = sorted(name for _index, name in socket.if_nameindex())
    if names != ['lo']: raise RuntimeError('Native verification requires loopback-only network namespace')
    return names

def cli_fingerprint():
    if str(Path(NATIVE_CLI).resolve(strict=True)) != NATIVE_WRAPPER:
        raise RuntimeError('Unexpected Codex wrapper target')
    out = {}
    for name, file in (('wrapper_sha256', NATIVE_WRAPPER), ('binary_sha256', NATIVE_BINARY)):
        p = Path(file)
        if str(p.resolve(strict=True)) != file or not p.is_file(): raise RuntimeError('Unexpected Codex file target')
        before = p.stat(); value = sha(p); after = p.stat()
        if any(getattr(before, key) != getattr(after, key) for key in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')):
            raise RuntimeError('Codex file changed during hashing')
        out[name] = value
    return out

def intro_selection(bootstrap, first_start, excluded):
    """Allow the reviewed Codex suite while fencing its one unrelated case."""
    omitted = 'a seeded workspace does not introduce Claude or OpenClaw as Codex'
    text = bootstrap.read_text()
    start = text.find("test('" + omitted + "'")
    end = text.find('\ntest(', start + 1)
    if start < 0 or end < 0 or text.count(omitted) != 1 or excluded.search(text[:start] + text[end:]) or \
       excluded.search(first_start.read_text()):
        raise ValueError('First-start exclusions changed')
    return ['node', '--test', '--test-concurrency=1', '--test-skip-pattern=^' + omitted + '$',
            str(bootstrap), str(first_start)]

def uses_scheduler_fixture(text):
    """Detect direct scheduler setup and the two shared scheduler fixtures."""
    return bool(re.search(r'\bstartScheduler\s*\(|(?:reminder-registration-fixture|recurring-reminder-fixture)\.mjs', text))

def native_preflight(cwd, env, host_netns_inode):
    names = require_loopback_only()
    test_netns_inode = os.stat('/proc/self/ns/net').st_ino
    if not isinstance(host_netns_inode, int) or isinstance(host_netns_inode, bool) or host_netns_inode <= 0 or test_netns_inode == host_netns_inode:
        raise RuntimeError('Native verification requires separate network namespace')
    fingerprints = cli_fingerprint()
    result = subprocess.run([NATIVE_CLI, '--version'], cwd=cwd, env=env,
                            capture_output=True, text=True, timeout=15, check=True)
    if result.stdout.strip() != NATIVE_VERSION: raise RuntimeError('Pinned Codex CLI version mismatch')
    if require_loopback_only() != names or os.stat('/proc/self/ns/net').st_ino != test_netns_inode:
        raise RuntimeError('Network namespace changed during native preflight')
    if cli_fingerprint() != fingerprints: raise RuntimeError('Codex files changed during native preflight')
    return {'interfaces': names, 'cli_path': NATIVE_CLI, 'cli_version': NATIVE_VERSION,
            'host_netns_inode': host_netns_inode, 'test_netns_inode': test_netns_inode, **fingerprints}

def verify(stage, home, dependencies, tmp_dir=None, host_netns_inode=None):
    stage, home, dependencies = map(lambda p: Path(p).resolve(), (stage, home, dependencies))
    manifest = json.loads((stage / 'manifest.json').read_text())
    if sha(stage / 'source.tar.gz') != manifest['source_archive_sha256']:
        raise ValueError('Source archive hash mismatch')
    source = stage / 'source'
    expected = set()
    with tarfile.open(stage / 'source.tar.gz', 'r:gz') as archive:
        for entry in archive:
            relative = Path(entry.name)
            if relative.is_absolute() or '..' in relative.parts:
                raise ValueError('Unsafe source archive member')
            file = source / relative
            expected.add(relative.as_posix())
            if entry.isdir():
                if file.is_symlink() or not file.is_dir(): raise ValueError('Source directory changed')
            elif entry.issym():
                if not file.is_symlink() or os.readlink(file) != entry.linkname: raise ValueError('Source link changed')
            elif entry.isfile():
                if file.is_symlink() or not file.is_file(): raise ValueError('Source file changed')
                if hashlib.sha256(archive.extractfile(entry).read()).hexdigest() != sha(file):
                    raise ValueError('Source snapshot changed: ' + entry.name)
            else:
                raise ValueError('Unsupported source archive entry')
    dependency_links = {'.msb/bot/node_modules', 'overlay/bot/node_modules'}
    actual = {p.relative_to(source).as_posix() for p in source.rglob('*')}
    if actual - expected != dependency_links:
        raise ValueError('Unexpected files in test source')
    for item in manifest['files']:
        if sha(stage / 'payload' / item['root'] / item['relative']) != item['after_sha256']:
            raise ValueError('Payload mismatch: ' + item['source'])
        if sha(source / item['source']) != item['after_sha256']:
            raise ValueError('Test source does not match payload: ' + item['source'])
    for relative in ('.msb/bot/node_modules', 'overlay/bot/node_modules'):
        link = source / relative
        if not link.is_symlink() or link.resolve() != dependencies:
            raise ValueError('Test dependencies do not match installed dependencies')
    environment = runtime_info(source / '.msb/bot/package-lock.json', dependencies)
    tmp = Path(tmp_dir).resolve() if tmp_dir else home / 'tmp'
    tmp.mkdir(parents=True, exist_ok=True)
    env = {'HOME': str(home), 'TMPDIR': str(tmp), 'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
           'LANG': 'C.UTF-8', 'MSB_RUNTIME_PROFILE': 'msb', 'PYTHONDONTWRITEBYTECODE': '1'}
    results = home / 'results'
    results.mkdir(exist_ok=True)
    checks = []

    def run(name, argv, timeout=1800, expected_pass=None, expected_names=(), expected_skipped=None):
        returncode, output = run_command(argv, source, env, results / (name + '.log'), timeout)
        count = passed = skipped = 0
        if not name.startswith('syntax-'):
            matches = re.findall(r'^(?:#|ℹ)\s*tests\s+(\d+)', output, re.MULTILINE)
            if not matches: matches = re.findall(r'^Ran (\d+) tests?', output, re.MULTILINE)
            count = int(matches[-1]) if matches else 0
            passed_match = re.findall(r'^(?:#|ℹ)\s*pass\s+(\d+)', output, re.MULTILINE)
            skipped_match = re.findall(r'^(?:#|ℹ)\s*skipped\s+(\d+)', output, re.MULTILINE)
            if passed_match:
                passed = int(passed_match[-1])
                skipped = int(skipped_match[-1]) if skipped_match else 0
            else:
                python_skip = re.findall(r'^OK \(skipped=(\d+)\)', output, re.MULTILINE)
                skipped = int(python_skip[-1]) if python_skip else 0
                passed = max(0, count - skipped) if returncode == 0 else 0
        all_expected_skipped = expected_skipped is not None and count == skipped == expected_skipped
        invalid = (not name.startswith('syntax-') and passed == 0 and not all_expected_skipped) or \
                  (expected_pass is not None and passed != expected_pass) or \
                  (expected_skipped is not None and skipped != expected_skipped) or \
                  any(value not in output for value in expected_names)
        skipped_cases = re.findall(r'^(test_\w+) \(.*?\) \.\.\. skipped', output, re.MULTILINE) if name == 'fstab-compat' else []
        if name == 'fstab-compat' and (count != 16 or passed + skipped != 16 or skipped > 1 or
                skipped_cases not in ([], ['test_rewrite_preserves_posix_acl']) or len(skipped_cases) != skipped):
            invalid = True
        code = returncode if returncode else int(invalid)
        row = {'suite': name, 'exit_code': code, 'tests': count, 'passed': passed,
               'skipped': skipped, 'summary': output.splitlines()[-9:]}
        if name == 'fstab-compat': row['skipped_cases'] = skipped_cases
        checks.append(row)
        print(json.dumps(checks[-1], ensure_ascii=False), flush=True)

    # A test file mentioning the paused provider is never included in the broad
    # suites. Two narrowly named, provider-independent tests are run separately.
    excluded = re.compile(r'open[\s_-]*claw|native.?oc|\boc\b|🦞|gateway', re.IGNORECASE)
    roots = [source / '.msb/bot/tests', source / 'overlay/bot/ext/tests',
             source / '.msb/bot/tests/reference', source / 'overlay/bot/ext/tests/reference']
    selected_files, excluded_files = {}, []
    # Scheduler can invoke its unrelated dispatcher even in ordinary tests.
    # These files are re-run below through per-file pre-import mocks.
    scheduler_files = {'autonomy-compact-guard.test.mjs', 'autonomy-store-concurrency.test.mjs',
        'claude-quota-stream.test.mjs', 'recurring-reminder-registration.test.mjs',
        'saved-cursor-prompt.test.mjs', 'saved-prompt-registration.test.mjs'}
    scheduler_fixtures = {'recurring-reminder-annual.test.mjs', 'recurring-reminder-cron-duplicates.test.mjs',
        'task-bulk-arming-sync.test.mjs', 'task-control-quoted-examples.test.mjs', 'task-run-history.test.mjs'}
    separately = scheduler_files | {'codex-steer-native.test.mjs', 'autonomy-same-bot-claim.test.mjs', 'autonomy-stop-admission.test.mjs',
        'codex-stop-lock.test.mjs', 'interval-provider-pause.test.mjs', 'interval-spend-pause.test.mjs',
        'legacy-timer-dispatch.test.mjs', 'legacy-timer-conversation.test.mjs', 'menu-handlers.test.mjs',
        'reminder-limits.test.mjs', 'task-reschedule.test.mjs', 'saved-codex-prompt-action.test.mjs',
        'saved-prompt-action.test.mjs', 'saved-spend-pause.test.mjs', 'recurring-reminder.test.mjs',
        'codex-pause-switch.test.mjs', 'codex-sleep-flow.test.mjs', 'autonomy-shutdown.test.mjs',
        'run-journal-recovery.test.mjs'} | scheduler_fixtures
    for index, root in enumerate(roots):
        all_tests = sorted(root.glob('*.test.mjs'))
        unreviewed = [p for p in all_tests if p.name not in separately and not excluded.search(p.read_text())
                      and uses_scheduler_fixture(p.read_text())]
        if unreviewed:
            raise ValueError('Unreviewed scheduler fixture: ' + repr([p.name for p in unreviewed]))
        tests = [p for p in all_tests if p.name not in separately and not excluded.search(p.read_text())]
        selected_files['node-' + str(index)] = [p.relative_to(source).as_posix() for p in tests]
        excluded_files.extend(p.relative_to(source).as_posix() for p in all_tests if p not in tests)
        if not tests:
            raise ValueError('No scoped tests in ' + str(root))
        # JAR1's limited CPU makes independent short-lived fixtures time out when
        # two test files compete. Run every selected test, one file at a time.
        run('node-' + str(index), ['node', '--test', '--test-concurrency=1', *map(str, tests)])
    steer_tests = [source / p for p in (
        '.msb/bot/tests/steer-action.test.mjs', '.msb/bot/tests/steer-history.test.mjs',
        '.msb/bot/tests/steer-inbox.test.mjs', '.msb/bot/tests/turn-history.test.mjs',
        '.msb/bot/tests/steer-channel.test.mjs', '.msb/bot/tests/steer-envelope.test.mjs',
        '.msb/bot/tests/steer-telegram.test.mjs', '.msb/bot/tests/attachments.test.mjs',
        '.msb/bot/tests/attachment-turn.test.mjs', '.msb/bot/tests/progress.test.mjs',
        'overlay/bot/ext/tests/codex-app-server.test.mjs', 'overlay/bot/ext/tests/steer-control.test.mjs',
        'overlay/bot/ext/tests/codex-session.test.mjs', 'overlay/bot/ext/tests/codex-profile-preferences.test.mjs')]
    if any(not p.is_file() or excluded.search(p.read_text()) for p in steer_tests):
        raise ValueError('Required steer test absent or references excluded provider')
    run('steer-targeted', ['node', '--test', '--test-concurrency=1', *map(str, steer_tests)],
        expected_pass=95, expected_skipped=0,
        expected_names=('accepted text and voice stay inside the original turn',
                        'stop and turn completion while ack is pending',
                        'reservation validates token, chat, topic'))
    native_proof = native_preflight(source, env, host_netns_inode)
    try:
        env['MSB_TEST_CODEX_NATIVE'] = NATIVE_CLI
        run('steer-native-isolated', ['node', '--test', '--test-concurrency=1',
            str(source / '.msb/bot/tests/codex-steer-native.test.mjs')],
            expected_pass=1, expected_skipped=0,
            expected_names=('native Codex preserves a session, steers its active turn, and aborts its process group',))
    finally:
        env.pop('MSB_TEST_CODEX_NATIVE', None)
    if require_loopback_only() != native_proof['interfaces'] or os.stat('/proc/self/ns/net').st_ino != native_proof['test_netns_inode']:
        raise RuntimeError('Network namespace changed during native verification')
    if cli_fingerprint() != {key: native_proof[key] for key in ('wrapper_sha256', 'binary_sha256')}:
        raise RuntimeError('Codex files changed during native verification')
    run('service-labels', ['node', '--test', '--test-name-pattern',
        'Pult unknown and known states|a busy system request|engine status timeout',
        str(source / '.msb/bot/tests/system-service-labels.test.mjs')], expected_pass=3,
        expected_names=('Pult unknown and known states', 'a busy system request', 'engine status timeout'))
    run('bot-status-view', ['node', '--test', '--test-name-pattern',
        'bot status shows the refreshed state while Codex remains selected',
        str(source / '.msb/bot/tests/native-engine-ui.test.mjs')], expected_pass=1,
        expected_names=('bot status shows the refreshed state while Codex remains selected',))
    wrappers = home / 'wrappers'
    wrappers.mkdir(exist_ok=True)
    dispatcher = (source / '.msb/bot/src/autonomy/openclaw-reminder-dispatch.mjs').as_uri()
    def wrapper(name, suite):
        target = wrappers / name
        target.write_text("import { mock } from 'node:test';\n" +
            'mock.module(' + json.dumps(dispatcher) + ', { namedExports: { createOpenClawReminderDispatcher: () => async () => {} } });\n' +
            'await import(' + json.dumps(suite.as_uri()) + ');\n')
        return str(target)
    bot_tests = source / '.msb/bot/tests'
    common = [wrapper('safe-' + file, bot_tests / file) for file in sorted(scheduler_files)]
    fixtures = bot_tests / 'fixtures'
    common += [str(fixtures / file) for file in ('legacy-timer-without-openclaw.mjs',
        'saved-spend-without-engine-dispatch.mjs', 'saved-claude-without-engine-dispatch.mjs',
        'saved-codex-without-engine-dispatch.mjs', 'saved-spend-regression-without-engine-dispatch.mjs',
        'codex-pause-without-engine-status.mjs',
        'codex-sleep-flow-without-engine-status.mjs')]
    common += [str(bot_tests / file) for file in ('autonomy-same-bot-claim.test.mjs',
        'autonomy-stop-admission.test.mjs', 'codex-stop-lock.test.mjs',
        'interval-provider-pause.test.mjs', 'interval-spend-pause.test.mjs')]
    common += [str(bot_tests / 'reference/probe-legacy-spend-pause.mjs')]

    # The audited first-start regression includes one explicitly excluded test
    # in a mixed file. Verify that no other excluded scenario is present before
    # Node filters that exact test name. Do not execute provider-specific tests.
    bootstrap = bot_tests / 'codex-bootstrap.test.mjs'
    first_start = bot_tests / 'codex-first-start.test.mjs'
    run('intro-safe', intro_selection(bootstrap, first_start, excluded),
        expected_pass=43, expected_skipped=0,
        expected_names=('first Codex input creates a missing base workspace',
                        'a seeded introduction keeps finalization after stop',
                        'fresh Codex setup through device login'))

    # These common scheduler tests are excluded from broad discovery because
    # they start a scheduler. The unrelated dispatcher is mocked before import.
    audited_names = ('album-download-errors.test.mjs', 'album-partial-turn.test.mjs',
        'codex-steer-stop.test.mjs', 'inbox-lifecycle.test.mjs', 'monitor-jsonl-append.test.mjs',
        'monitor-last-poll.test.mjs', 'recurring-reminder-annual.test.mjs',
        'recurring-reminder-cron-duplicates.test.mjs', 'task-bulk-arming-sync.test.mjs',
        'task-control-quoted-examples.test.mjs', 'response-delivery.test.mjs')
    audited = [bot_tests / name for name in audited_names]
    scheduler_audit = [bot_tests / name for name in ('autonomy-shutdown.test.mjs', 'run-journal-recovery.test.mjs')]
    if any(not file.is_file() or excluded.search(file.read_text()) for file in audited + scheduler_audit):
        raise ValueError('Audited common test missing or references excluded provider')
    audit_wrappers = [wrapper('audit-' + file.name, file) for file in scheduler_audit]
    audit_inputs = [wrapper('audit-scoped-' + file.name, file) if file.name in scheduler_fixtures else str(file)
                    for file in audited]
    run('audit-targeted', ['node', '--experimental-test-module-mocks', '--no-warnings',
        '--test', '--test-concurrency=1', *audit_wrappers,
        str(fixtures / 'legacy-timer-without-openclaw.mjs'), *audit_inputs],
        expected_pass=133, expected_skipped=0,
        expected_names=('scheduler shutdown aborts and drains the active interval',
                        'a completed interval survives journal tail: interrupted',
                        'Codex stop reaps a stubborn app-server',
                        'partial photo album survives getFile failure'))
    scheduler_scoped = [wrapper('scheduler-scoped-' + name, bot_tests / name) for name in sorted(scheduler_fixtures)]
    run('scheduler-safe', ['node', '--experimental-test-module-mocks', '--no-warnings',
        '--test', '--test-concurrency=1', *scheduler_scoped], expected_pass=19, expected_skipped=0,
        expected_names=('an annual cron delivers at the same owner-local minute next year',
                        'repeated minute and hour values do not create additional cron firings'))
    run('backlog-targeted', ['node', '--experimental-test-module-mocks', '--no-warnings',
        '--test', '--test-concurrency=1', *common], expected_pass=291,
        expected_names=('paused Codex accepts all stop inputs',))
    # The approved eight cases run directly under this runner's longer suite
    # timeout. The old nested fixture's ten-second child timeout is too short
    # on a loaded target, and must not change the provider exclusion.
    recurring_pattern = r'^(?:a saved interval follows|saved cron matches|the repeated local|old frequency|a non-pause budget|the existing task card|one slow send|owner Off)'
    recurring = wrapper('recurring-safe.mjs', bot_tests / 'recurring-reminder.test.mjs')
    run('recurring-safe', ['node', '--experimental-test-module-mocks', '--no-warnings',
        '--test', '--test-name-pattern', recurring_pattern, recurring], expected_pass=8,
        expected_names=('a saved interval follows', 'owner Off during an admitted recurring send'))
    legacy_pattern = r'^(?:legacy timer conversation (?:lists |reports |chooses |applies |off after |can enable |enables |group pause |OFF invalidates |Keep closes |rejects |uses |can retry |cannot |accepts |treats |keeps |leaves )|(?:codex|claude) legacy timer conversation prompt and owner turn reach the shared schedule$)'
    legacy = wrapper('legacy-conversation.mjs', bot_tests / 'legacy-timer-conversation.test.mjs')
    run('legacy-timer-conversation-safe', ['node', '--experimental-test-module-mocks', '--no-warnings',
        '--test', '--test-name-pattern', legacy_pattern, legacy], expected_pass=23,
        expected_names=('codex legacy timer conversation prompt and owner turn',
                        'claude legacy timer conversation prompt and owner turn'))
    menu_pattern = r'^(?:/stop keeps|/stop does not claim|/compact uses|/compact refuses|/compact and normal|/compact presents|reply stop parity|explicit Back and start|informational status preserves)'
    run('menu-safe', ['node', '--test', '--test-name-pattern', menu_pattern,
        str(bot_tests / 'menu-handlers.test.mjs')], expected_pass=10,
        expected_names=('/stop keeps current turn locked', 'reply stop parity'))
    # One off-marker test explicitly invokes a stopped-engine snapshot. Select
    # the other nine names; no such scenario is run as part of this release.
    run('test_bot_off_marker', [sys.executable, '-B', '-m', 'unittest', 'discover',
        '-s', str(source / 'usr-local-lib/msb-engine/tests'), '-p', 'test_bot_off_marker.py', '-v',
        *sum((['-k', name] for name in ('test_success', 'test_status', 'test_failed', 'test_partial',
                                       'test_masked', 'test_failure', 'test_waking', 'test_removed')), [])],
        timeout=180, expected_pass=9)
    # test_profile embeds an explicit OpenClaw assertion in each profile probe;
    # it is excluded in full rather than executing that scenario incidentally.
    for name in ('test_ipc_reference.py', 'test_private_state.py', 'test_pult_routing.py'):
        run(name.removesuffix('.py'), [sys.executable, '-B', '-m', 'unittest', 'discover',
            '-s', str(source / 'usr-local-lib/msb-engine/tests'), '-p', name, '-v'], timeout=180)
    # These require root and a distinct UID; they are verified in the isolated
    # Linux container, while this target suite deliberately runs as client.
    run('test_client_markers', [sys.executable, '-B', '-m', 'unittest', 'discover',
        '-s', str(source / 'usr-local-lib/msb-engine/tests'), '-p', 'test_client_markers.py', '-v'],
        timeout=180, expected_pass=0, expected_skipped=9)
    # Synthetic fixture files live on the isolated test-home filesystem so
    # Linux xattr/ACL checks do not depend on the sandbox's /tmp tmpfs.
    fixture_tmp = home / 'fstab-tmp'
    fixture_tmp.mkdir(exist_ok=True)
    original_tmp = env['TMPDIR']; env['TMPDIR'] = str(fixture_tmp)
    try:
        run('fstab-compat', [sys.executable, '-B', '-m', 'unittest', 'discover',
            '-s', str(source / 'bootstrap/tests'), '-p', 'test_fstab_compat.py', '-v'], timeout=180,
            expected_names=('test_old_new_whitespace_and_both_are_idempotent',
                            'test_rewrite_preserves_extended_attributes',
                            'test_bot_remove_checks_conflict_before_stop_or_unmount'))
    finally:
        env['TMPDIR'] = original_tmp
    for item in manifest['files']:
        file = stage / 'payload' / item['root'] / item['relative']
        if item['root'] == 'bot':
            run('syntax-' + item['relative'].replace('/', '_'), ['node', '--check', str(file)], timeout=30)
        elif item['root'] == 'bin':
            run('syntax-' + item['relative'].replace('/', '_'), ['bash', '-n', str(file)], timeout=30)
        else:
            run('syntax-' + item['relative'].replace('/', '_'),
                [sys.executable, '-B', '-c', 'import ast,sys;ast.parse(open(sys.argv[1]).read())', str(file)], timeout=30)
    report = {'native_isolated_verification': native_proof, 'source_commit': manifest['source_commit'], 'manifest_sha256': sha(stage / 'manifest.json'),
              'source_archive_sha256': manifest['source_archive_sha256'],
              'environment': environment,
              'node_test_concurrency': 1,
              'selected_files': selected_files, 'excluded_files': excluded_files,
              'scope': 'Codex and common routes; OpenClaw-specific tests excluded by owner',
              'checks': checks, 'passed': all(row['exit_code'] == 0 for row in checks)}
    (results / 'verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', required=True)
    parser.add_argument('--home', required=True)
    parser.add_argument('--dependencies', required=True)
    parser.add_argument('--tmp-dir')
    parser.add_argument('--host-netns-inode', type=int, required=True)
    args = parser.parse_args()
    outcome = verify(args.stage, args.home, args.dependencies, args.tmp_dir, args.host_netns_inode)
    raise SystemExit(0 if outcome['passed'] else 1)

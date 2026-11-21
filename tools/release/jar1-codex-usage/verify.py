#!/usr/bin/env python3
"""Run the existing scoped JAR1 gate plus this feature's isolated checks."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tarfile

CCUSAGE_SHA512 = 'NZN5h+HBHC6tOO3aadbsZEKzGfNS24asTcvgv+iP9gY0Cw1QyzSaOhqJM1E2f8nkCsqiX2NRrb/RNC7dvcXx7g=='
PRIOR_STAGE = Path('/var/tmp/jar1-codex-usage-e10203c')
PRIOR_MANIFEST = 'a4f9b5a8f98e01fa80ef9b196a24afd056d3d5f16fd29362f75dbfe1b6e77c25'
PRIOR_REPORT = '64de74f74e58ba6fd3f3876d6ca659bbe19d198eda534354c94947063c832adc'
PRIOR_LOGS = 'f8dabb73497214ee32d214543ff0a7d9c8c889416ef7198785c3aaafb04781c0'
RELEASE_ONLY = {'tools/release/jar1-audit-2026-11-20/verify.py',
                'tools/release/jar1-audit-2026-11-20/deploy.py',
                'tools/release/jar1-audit-2026-11-20/test_deploy.py',
                'tools/release/jar1-codex-usage/verify.py'}

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def archive_contents(path):
    """Compare the tested source and composite by content, ignoring tar timestamps."""
    files = {}
    with tarfile.open(path, 'r:gz') as archive:
        for member in archive:
            name = member.name.removeprefix('./').rstrip('/')
            if not name or name in files or Path(name).is_absolute() or '..' in Path(name).parts:
                raise RuntimeError('Unexpected archive entry')
            if member.isfile():
                value = hashlib.sha256(archive.extractfile(member).read()).hexdigest()
            elif member.isdir(): value = None
            elif member.issym(): value = member.linkname
            else: raise RuntimeError('Unexpected archive entry type')
            files[name] = (member.type, member.mode, value)
    return files


def reusable_results(stage, manifest):
    """Reuse only the sealed, identical-source suites from the earlier JAR1 run."""
    prior = PRIOR_STAGE
    if not prior.exists(): return None
    for file in (prior / 'manifest.json', prior / 'source.tar.gz', prior / 'composite.tar.gz',
                 prior / 'test-home/results/verification.json'):
        st = file.lstat()
        if file.is_symlink() or not file.is_file() or st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError('Prior verification is not sealed')
    if sha(prior / 'manifest.json') != PRIOR_MANIFEST or \
       sha(prior / 'test-home/results/verification.json') != PRIOR_REPORT:
        raise RuntimeError('Prior verification changed')
    old = json.loads((prior / 'manifest.json').read_text())
    if sha(prior / 'source.tar.gz') != old['source_archive_sha256'] or \
       sha(prior / 'composite.tar.gz') != old['composite_archive_sha256']:
        raise RuntimeError('Prior archives changed')
    for key in ('files', 'pult_files', 'baseline_inventory', 'pult_baseline_inventory',
                'support_files', 'composite_provenance', 'ccusage_binary_sha256'):
        if old[key] != manifest[key]: raise RuntimeError('Release payload differs from prior run')
    for name in ('source.tar.gz', 'composite.tar.gz'):
        before, after = archive_contents(prior / name), archive_contents(stage / name)
        if set(before) != set(after): raise RuntimeError('Archive contents differ from prior run')
        changed = {key for key in before if before[key] != after[key]}
        if not changed or not changed <= RELEASE_ONLY:
            raise RuntimeError('Non-release source differs from prior run')
    report = json.loads((prior / 'test-home/results/verification.json').read_text())
    if report.get('source_commit') != old['source_commit'] or report.get('manifest_sha256') != PRIOR_MANIFEST or \
       report.get('source_archive_sha256') != old['source_archive_sha256'] or report.get('passed') is not False:
        raise RuntimeError('Unexpected prior report')
    rows = report['checks']
    if len(rows) != 30 or len({row['suite'] for row in rows}) != len(rows):
        raise RuntimeError('Unexpected prior suites')
    failed = [row for row in rows if row['exit_code']]
    if len(failed) != 1 or (failed[0]['suite'], failed[0]['tests'], failed[0]['passed'], failed[0]['skipped']) != \
       ('test_client_markers', 9, 0, 9):
        raise RuntimeError('Prior run contains a different failure')
    digest, outputs = hashlib.sha256(), {}
    for row in sorted(rows, key=lambda item: item['suite']):
        file = prior / 'test-home/results' / (row['suite'] + '.log')
        st = file.lstat()
        if file.is_symlink() or not file.is_file() or st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError('Prior log is not sealed')
        raw = file.read_bytes(); output = raw.decode('utf8')
        if row['summary'] != output.splitlines()[-9:]: raise RuntimeError('Prior log differs from report')
        digest.update((row['suite'] + '\0').encode()); digest.update(hashlib.sha256(raw).digest())
        outputs[row['suite']] = output
    if digest.hexdigest() != PRIOR_LOGS or 'OK (skipped=9)' not in outputs['test_client_markers']:
        raise RuntimeError('Prior logs changed')
    return report, outputs


def verify_payload_source(stage, source, composite, manifest):
    for item in manifest['files']:
        if sha(composite / item['source']) != item['after_sha256']:
            raise RuntimeError('Composite bot source differs from the release payload')
    for item in manifest['pult_files']:
        if sha(source / item['source']) != item['after_sha256'] or \
           sha(stage / 'payload/pult' / item['relative']) != item['after_sha256']:
            raise RuntimeError('Tested Pult source differs from the release payload')


def verify_dependency(stage, manifest):
    if manifest['ccusage_archive_sha512'] != CCUSAGE_SHA512 or sha(stage / 'ccusage') != manifest['ccusage_binary_sha256'] or \
       base64.b64encode(hashlib.sha512((stage / 'ccusage.tgz').read_bytes()).digest()).decode() != CCUSAGE_SHA512:
        raise RuntimeError('ccusage dependency changed')
    with tarfile.open(stage / 'ccusage.tgz', 'r:gz') as archive:
        member = archive.getmember('package/bin/ccusage')
        if not member.isfile() or member.size > 12_000_000 or \
           hashlib.sha256(archive.extractfile(member).read()).hexdigest() != manifest['ccusage_binary_sha256']:
            raise RuntimeError('ccusage binary does not match the verified archive')


def verify(stage, home, dependencies, tmp_dir, host_netns_inode):
    stage, home = Path(stage).resolve(), Path(home).resolve()
    manifest = json.loads((stage / 'manifest.json').read_text())
    if sha(stage / 'verify_base.py') != manifest['verify_base_sha256']:
        raise RuntimeError('Base verifier changed')
    spec = importlib.util.spec_from_file_location('usage_verify_base', stage / 'verify_base.py')
    base = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(base)
    original = base.run_command
    reused = reusable_results(stage, manifest)
    replayed = []

    def scoped(argv, cwd, env, log, timeout):
        # The existing gate has an exact legacy pass count. Run the new test
        # separately below while preserving the old reviewed provider boundary.
        if Path(log).name == 'backlog-targeted.log':
            argv = list(argv)
            argv.insert(argv.index('--test') + 1,
                        '--test-skip-pattern=^an interrupted Codex task retains known usage and marks it incomplete$')
        name = Path(log).stem
        if reused and name in reused[1] and name not in ('test_client_markers', 'steer-native-isolated') and \
           not name.startswith('syntax-'):
            output = reused[1][name]
            Path(log).write_text(output)
            replayed.append(name)
            return 0, output
        return original(argv, cwd, env, log, timeout)

    base.run_command = scoped
    report = base.verify(stage, home, dependencies, tmp_dir, host_netns_inode)
    if not report.get('passed'):
        raise RuntimeError('The existing scoped JAR1 gate failed')
    if reused:
        if report.get('environment') != reused[0].get('environment'):
            raise RuntimeError('Runtime changed since the prior verification')
        report['reused_verification'] = {'source_commit': reused[0]['source_commit'],
            'report_sha256': PRIOR_REPORT, 'logs_sha256': PRIOR_LOGS, 'suites': sorted(replayed)}
        (home / 'results/verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    source = stage / 'source'
    composite = stage / 'composite'
    if sha(stage / 'composite.tar.gz') != manifest['composite_archive_sha256']:
        raise RuntimeError('Installed-baseline composite archive changed')
    verify_dependency(stage, manifest)
    expected = set()
    with tarfile.open(stage / 'composite.tar.gz', 'r:gz') as archive:
        for entry in archive:
            relative = Path(entry.name)
            if relative.is_absolute() or '..' in relative.parts: raise RuntimeError('Unsafe composite entry')
            target = composite / relative
            expected.add(relative.as_posix())
            if entry.isdir():
                if target.is_symlink() or not target.is_dir(): raise RuntimeError('Composite directory changed')
            elif entry.issym():
                if not target.is_symlink() or os.readlink(target) != entry.linkname: raise RuntimeError('Composite link changed')
            elif entry.isfile():
                if target.is_symlink() or not target.is_file() or \
                   hashlib.sha256(archive.extractfile(entry).read()).hexdigest() != sha(target):
                    raise RuntimeError('Composite file changed')
            else: raise RuntimeError('Unsupported composite entry')
    actual = {p.relative_to(composite).as_posix() for p in composite.rglob('*')}
    if actual - expected != {'.msb/bot/node_modules', 'overlay/bot/node_modules'}:
        raise RuntimeError('Unexpected composite files')
    for relative in ('.msb/bot/node_modules', 'overlay/bot/node_modules'):
        target = composite / relative
        if not target.is_symlink() or target.resolve() != Path(dependencies).resolve():
            raise RuntimeError('Composite dependencies differ from the installed bot')
    verify_payload_source(stage, source, composite, manifest)
    env = {'HOME': str(home), 'TMPDIR': str(tmp_dir), 'PATH': '/usr/local/bin:/usr/bin:/bin',
           'LANG': 'C.UTF-8', 'MSB_RUNTIME_PROFILE': 'msb', 'PYTHONDONTWRITEBYTECODE': '1',
           'PULT_TEST_CCUSAGE': str(stage / 'ccusage')}
    checks = []
    suites = [
        ('usage-collector', ['node', '--disable-warning=ExperimentalWarning', '--test',
         str(source / '.msb/pult/tests/collector/codex-usage.test.ts'),
         str(source / '.msb/pult/tests/collector/collect.test.ts')], 16),
        ('usage-ui', ['node', '--disable-warning=ExperimentalWarning', '--test',
         str(source / '.msb/pult/tests/ui/static.test.ts')], 12),
        ('usage-native', ['node', '--disable-warning=ExperimentalWarning', '--test',
         str(source / '.msb/pult/tests/collector/codex-usage-native.test.ts')], 1),
        ('usage-release', [sys.executable, '-B', '-m', 'unittest', 'discover', '-s',
         str(source / 'tools/release/jar1-codex-usage'), '-p', 'test_release.py', '-v'], 4),
        ('usage-stop', ['node', '--experimental-test-module-mocks', '--no-warnings', '--test',
         '--test-name-pattern=^an interrupted Codex task retains known usage and marks it incomplete$',
         str(source / '.msb/bot/tests/fixtures/saved-codex-without-engine-dispatch.mjs')], 1),
        ('composite-session', ['node', '--test', '--test-name-pattern=cap100|ownership is retained|first codex turn|first claude turn|reset retains',
         str(composite / '.msb/bot/tests/session-ledger.test.mjs')], 8),
        ('composite-resume', ['node', '--test', str(composite / '.msb/bot/tests/session-resume.test.mjs')], 15),
        ('composite-intro', ['node', '--test', '--test-name-pattern=^Codex introduction goes through Telegram /stop',
         str(composite / '.msb/bot/tests/codex-bootstrap.test.mjs')], 1),
        ('composite-background', ['node', '--experimental-test-module-mocks', '--no-warnings', '--test',
         '--test-name-pattern=the saved action launches|an interrupted Codex task|owner pause interrupts|observed helper tokens|partial helper usage',
         str(composite / '.msb/bot/tests/fixtures/saved-codex-without-engine-dispatch.mjs')], 5),
        ('composite-claude', ['node', '--experimental-test-module-mocks', '--no-warnings', '--test',
         '--test-name-pattern=^a saved Claude prompt uses the old isolated workspace',
         str(composite / '.msb/bot/tests/fixtures/saved-claude-without-engine-dispatch.mjs')], 1),
    ]
    for name, command, expected in suites:
        code, output = original(command, source, env, home / 'results' / (name + '.log'), 300)
        matches = re.findall(r'^(?:#|ℹ)\s*pass\s+(\d+)', output, re.MULTILINE)
        python_matches = re.findall(r'^Ran (\d+) tests?', output, re.MULTILINE)
        passed = int(matches[-1]) if matches else (int(python_matches[-1]) if python_matches and not code else 0)
        checks.append({'suite': name, 'exit_code': code, 'passed': passed})
        if code or passed != expected:
            raise RuntimeError(name + ' did not pass the expected checks')
    outcome = {'source_commit': manifest['source_commit'], 'manifest_sha256': sha(stage / 'manifest.json'),
               'source_archive_sha256': manifest['source_archive_sha256'],
               'composite_archive_sha256': manifest['composite_archive_sha256'], 'checks': checks, 'passed': True}
    (home / 'results' / 'usage-verification.json').write_text(json.dumps(outcome, indent=2) + '\n')
    print(json.dumps(outcome), flush=True)
    return outcome


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', required=True)
    parser.add_argument('--home', required=True)
    parser.add_argument('--dependencies', required=True)
    parser.add_argument('--tmp-dir', required=True)
    parser.add_argument('--host-netns-inode', type=int, required=True)
    args = parser.parse_args()
    sys.exit(0 if verify(args.stage, args.home, args.dependencies, args.tmp_dir, args.host_netns_inode)['passed'] else 1)

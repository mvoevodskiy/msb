#!/usr/bin/env python3
"""Export an exact, code-only bot + system-engine candidate from two Git trees."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

BASE = 'da0f05658d69c1cd3d48ad9436d998ce10dbca8b'
DOC_BASE = '4568242e0d319ecb72919f01ea81eb8e86b79613'
EXT_DOC_BASE = '03a69ef181c24fcc2e6345818a100b907d47e3a9'
BOT = ('src/autonomy/prompt-delivery.mjs', 'src/autonomy/prompt-turn.mjs', 'src/telegram/response.mjs')
OPS = 'tools/release/jar1-twofix-2026-11-16'
SOURCES = (
    '.msb/bot/index.js', '.msb/bot/package.json', '.msb/bot/package-lock.json',
    '.msb/bot/OPEN-CORE.md', '.msb/bot/src', '.msb/bot/shared', '.msb/bot/tests',
    '.msb/puller.cjs', '.msb/sync.cjs', 'overlay/bot/run.mjs', 'overlay/bot/ext',
    'overlay/bot/shared', 'usr-local-lib/msb-engine', 'usr-local-lib/msb-fstab.py',
    'usr-local-bin', 'overlay/install.sh', 'overlay/usr-local-bin/bot-ctl.sh', 'bootstrap', 'tools/release',
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])


def build(repo, commit, stage):
    repo, stage = Path(repo).resolve(), Path(stage).absolute()
    commit = git(repo, 'rev-parse', '--verify', commit + '^{commit}').decode().strip()
    if len(commit) != 40 or not git(repo, 'merge-base', BASE, commit).decode().strip() == BASE:
        raise ValueError('Candidate must descend from the exact JAR1 baseline')
    mapping = [('lib', 'msb-fstab.py', 'usr-local-lib/msb-fstab.py'),
               ('bin', 'bot-ctl.sh', 'usr-local-bin/bot-ctl.sh')] + [
               ('bot', name, '.msb/bot/' + name) for name in BOT]
    changed = git(repo, 'diff', '--name-only', BASE, commit, '--', '.msb/bot/index.js',
                  '.msb/bot/package.json', '.msb/bot/package-lock.json', '.msb/bot/src', '.msb/bot/shared',
                  '.msb/puller.cjs', '.msb/sync.cjs', 'overlay/bot/run.mjs', 'overlay/bot/ext',
                  'usr-local-lib/msb-engine', 'usr-local-lib/msb-fstab.py', 'usr-local-bin/bot-ctl.sh').decode().splitlines()
    runtime = {path for path in changed if '/tests/' not in path and not path.endswith('.md')}
    if runtime != {source for _, _, source in mapping}:
        raise ValueError('Candidate contains unexpected runtime changes: ' + repr(sorted(runtime)))
    if git(repo, 'show', commit + ':usr-local-bin/bot-ctl.sh') != git(repo, 'show', commit + ':overlay/usr-local-bin/bot-ctl.sh'):
        raise ValueError('Administrative script copies differ')
    stage.mkdir(mode=0o700, parents=False, exist_ok=False)
    entries = []
    for root, relative, source in mapping:
        exists = subprocess.run(['git', '-C', str(repo), 'cat-file', '-e', BASE + ':' + source],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        before = git(repo, 'show', BASE + ':' + source) if exists else None
        after = git(repo, 'show', commit + ':' + source)
        if before == after:
            raise ValueError('Unchanged file in release: ' + source)
        payload = stage / 'payload' / root / relative
        payload.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        payload.write_bytes(after)
        entries.append({'root': root, 'relative': relative, 'source': source,
                        'before_sha256': digest(before) if before is not None else None, 'after_sha256': digest(after)})
    baseline = []
    trees = (('.msb/bot/src/', 'bot', 'src/'), ('.msb/bot/shared/', 'bot', 'shared/'),
             ('overlay/bot/ext/', 'bot', 'ext/'), ('usr-local-lib/msb-engine/', 'engine', ''))
    for prefix, root, target_prefix in trees:
        paths = git(repo, 'ls-tree', '-r', '--name-only', BASE, '--', prefix).decode().splitlines()
        for source in paths:
            if '/tests/' in source or re.search(r'openclaw|native.?oc|(?:^|[/_-])oc(?:[/_.-]|$)', source, re.I):
                continue
            relative = target_prefix + source.removeprefix(prefix)
            # The previous code-only release deliberately did not install its
            # documentation edits; the two live README files remain at 4568242.
            ref = DOC_BASE if source in ('.msb/bot/src/engines/README.md', '.msb/bot/src/telegram/README.md') else \
                  EXT_DOC_BASE if source == 'overlay/bot/ext/README.md' else BASE
            baseline.append({'root': root, 'relative': relative, 'sha256': digest(git(repo, 'show', ref + ':' + source))})
    for source, relative in (('.msb/bot/index.js', 'index.js'), ('overlay/bot/run.mjs', 'run.mjs'),
                             ('.msb/bot/package-lock.json', 'package-lock.json'), ('.msb/bot/OPEN-CORE.md', 'OPEN-CORE.md')):
        baseline.append({'root': 'bot', 'relative': relative, 'sha256': digest(git(repo, 'show', BASE + ':' + source))})
    # The accepted clean-server installer intentionally retained this package.json.
    baseline.append({'root': 'bot', 'relative': 'package.json',
                     'sha256': '3ee7326fbe9bb3e40463ba3b048305b205c38df4165c87aa1f01c243276afb2f'})
    baseline.append({'root': 'bin', 'relative': 'bot-ctl.sh',
                     'sha256': digest(git(repo, 'show', BASE + ':usr-local-bin/bot-ctl.sh'))})
    support = []
    for source in ('usr-local-sbin/msb-engine', 'systemd/msb-engine.service', 'systemd/msb-engine.path',
                   'systemd/msb-engine-tick.service', 'systemd/msb-engine-tick.timer', 'systemd/msb-bot@.service'):
        target = ('/usr/local/sbin/' if source.startswith('usr-local-sbin/') else '/etc/systemd/system/') + source.rsplit('/', 1)[1]
        support.append({'path': target, 'sha256': digest(git(repo, 'show', BASE + ':' + source))})
    archive = stage / 'source.tar.gz'
    with archive.open('wb') as raw:
        with gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as compressed:
            process = subprocess.Popen(['git', '-C', str(repo), 'archive', '--format=tar', commit, *SOURCES],
                                       stdout=subprocess.PIPE)
            shutil.copyfileobj(process.stdout, compressed)
            process.stdout.close()
            if process.wait() != 0:
                raise RuntimeError('Git source export failed')
    for name in ('verify.py', 'deploy.py', 'runtime.py', 'profile_backup.py'):
        (stage / name).write_bytes(git(repo, 'show', commit + ':' + OPS + '/' + name))
    manifest = {'schema': 1, 'base_commit': BASE, 'source_commit': commit, 'files': entries, 'baseline_inventory': baseline,
                'support_files': support,
                'source_archive_sha256': digest(archive.read_bytes()),
                'verify_sha256': digest((stage / 'verify.py').read_bytes()),
                'deploy_sha256': digest((stage / 'deploy.py').read_bytes()),
                'runtime_sha256': digest((stage / 'runtime.py').read_bytes()),
                'profile_backup_sha256': digest((stage / 'profile_backup.py').read_bytes())}
    (stage / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--stage', required=True)
    args = parser.parse_args()
    result = build(args.repo, args.commit, args.stage)
    print(json.dumps({'source_commit': result['source_commit'], 'files': len(result['files'])}))

#!/usr/bin/env python3
"""Seal the Telegram UX delta against the accepted JAR1 .msb inventory."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

BASE_COMMIT = '9fd804fe6d8cd8a9c5885294386fe46a46eaaaad'
BASE_MANIFEST = '58ba0ccd512c42d20b272b62039b0ee57060f9b865f2022e6dc50d3b66f3b691'
SCOPE = 'jar1-ux-v1'
ROOT = 'tools/release/jar1-ux/'
ATTACHMENT = 'tools/release/jar1-attachment-delivery/'
AUDIT = 'tools/release/jar1-audit-2026-11-20/'
ADDED = (
    'shared/connection-navigation.mjs',
    'src/engines/systemd-status.mjs',
    'src/notification-mutes.mjs',
)
FILES = ADDED + (
    'OPEN-CORE.md',
    'src/engines/README.md',
    'src/engines/client.mjs',
    'src/engines/screen.mjs',
    'src/engines/telegram.mjs',
    'src/monitor/README.md',
    'src/pult/status.mjs',
    'src/telegram/README.md',
    'src/telegram/forms/env.mjs',
    'src/telegram/forms/monitor.mjs',
    'src/telegram/routes/agent.mjs',
    'src/telegram/routes/bots.mjs',
    'src/telegram/routes/monitor.mjs',
    'src/telegram/routes/settings.mjs',
    'src/telegram/routes/system.mjs',
    'src/telegram/screens/agent.mjs',
    'src/telegram/screens/monitor.mjs',
    'src/telegram/screens/settings.mjs',
    'src/telegram/screens/system.mjs',
    'ext/README.md',
    'ext/auth.mjs',
    'ext/integration/callbacks.mjs',
    'ext/integration/native-login.mjs',
    'ext/integration/ssh-screen.mjs',
    'ext/integration/text-input.mjs',
    'ext/menu.mjs',
)
TOOLS = {
    'build.py': ROOT + 'build.py',
    'deploy.py': ROOT + 'deploy.py',
    'verify.py': ROOT + 'verify.py',
    'launcher.py': ATTACHMENT + 'launcher.py',
    'source_guard.py': ATTACHMENT + 'verify.py',
    'profile.py': ATTACHMENT + 'profile.py',
    'launcher_base.py': AUDIT + 'launcher.py',
    'deploy_base.py': AUDIT + 'deploy.py',
    'runtime.py': AUDIT + 'runtime.py',
    'profile_backup.py': AUDIT + 'profile_backup.py',
}
SOURCES = (
    '.msb/bot/index.js', '.msb/bot/package.json', '.msb/bot/package-lock.json',
    '.msb/bot/OPEN-CORE.md', '.msb/bot/src', '.msb/bot/shared', '.msb/bot/tests',
    'overlay/bot/run.mjs', 'overlay/bot/ext', 'overlay/bot/shared',
    'bootstrap/workspace-seed', 'usr-local-lib/msb-engine/client_markers.py',
    'usr-local-lib/msb-engine/client_fs.py', 'usr-local-lib/msb-engine/const.py',
    'usr-local-lib/msb-engine/util.py', 'tools/release',
)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])


def installed_inventory(raw):
    if sha(raw) != BASE_MANIFEST:
        raise ValueError('Accepted attachment manifest hash mismatch')
    prior = json.loads(raw)
    if prior['source_commit'] != BASE_COMMIT or prior['scope'] != 'jar1-attachment-delivery-v1':
        raise ValueError('Unexpected installed release')
    rows = prior['baseline_inventory']
    inventory = {(row['root'], row['relative']): dict(row) for row in rows}
    if len(inventory) != len(rows):
        raise ValueError('Duplicate installed path')
    for row in prior['files']:
        key = row['root'], row['relative']
        if inventory[key]['sha256'] != row['before_sha256']:
            raise ValueError('Unexpected attachment delta')
        inventory[key]['sha256'] = row['after_sha256']
    return list(inventory.values()), prior['support_files']


def source_path(root, relative):
    if root == 'bot':
        prefix = 'overlay/bot/' if relative.startswith('ext/') or relative == 'run.mjs' else '.msb/bot/'
        return prefix + relative
    if root == 'engine':
        return 'usr-local-lib/msb-engine/' + relative
    if root == 'bin' and relative == 'bot-ctl.sh':
        return 'usr-local-bin/' + relative
    raise ValueError('Unknown installed path')


def build(repo, commit, stage, prior_manifest):
    repo, stage = Path(repo).resolve(), Path(stage).absolute()
    commit = git(repo, 'rev-parse', '--verify', commit + '^{commit}').decode().strip()
    git(repo, 'merge-base', '--is-ancestor', BASE_COMMIT, commit)
    if git(repo, 'rev-parse', 'HEAD').decode().strip() == commit and git(repo, 'status', '--porcelain'):
        raise ValueError('Commit the selected release inputs before building')
    if git(repo, 'show', f'{commit}:{ROOT}build.py') != Path(__file__).read_bytes():
        raise ValueError('Builder is not from the candidate')
    raw = Path(prior_manifest).read_bytes()
    baseline, support = installed_inventory(raw)
    before = {(row['root'], row['relative']): row['sha256'] for row in baseline}
    selected = {source_path('bot', name) for name in FILES}
    changed = git(repo, 'diff', '--name-only', '--no-renames', BASE_COMMIT, commit, '--',
                  '.msb/bot', 'overlay/bot', 'usr-local-bin', 'usr-local-lib',
                  ':!.msb/bot/tests', ':!overlay/bot/ext/tests').decode().splitlines()
    if set(changed) != selected:
        raise ValueError('Runtime delta differs from UX allowlist: ' + repr(sorted(set(changed) ^ selected)))
    for (root, relative), expected in before.items():
        path = source_path(root, relative)
        ref = BASE_COMMIT if path in selected else commit
        if sha(git(repo, 'show', f'{ref}:{path}')) != expected:
            raise ValueError('Candidate baseline differs from accepted installation: ' + path)
    if {name for name in FILES if ('bot', name) not in before} != set(ADDED):
        raise ValueError('Unexpected added runtime files')

    stage.mkdir(mode=0o755)
    (stage / 'prior.json').write_bytes(raw)
    files = []
    for name in FILES:
        source = source_path('bot', name)
        payload = stage / 'payload/bot' / name
        payload.parent.mkdir(parents=True, exist_ok=True)
        data = git(repo, 'show', f'{commit}:{source}')
        payload.write_bytes(data)
        files.append({'root': 'bot', 'relative': name, 'source': source,
                      'before_sha256': before.get(('bot', name)), 'after_sha256': sha(data)})
    archive = git(repo, 'archive', '--format=tar.gz', commit, *SOURCES)
    (stage / 'source.tar.gz').write_bytes(archive)
    hashes = {}
    for name, source in TOOLS.items():
        content = git(repo, 'show', f'{commit}:{source}')
        (stage / name).write_bytes(content)
        hashes[name.removesuffix('.py') + '_sha256'] = sha(content)
    manifest = {'schema': 1, 'scope': SCOPE, 'source_commit': commit, 'base_commit': BASE_COMMIT,
                'prior_sha256': BASE_MANIFEST, 'baseline_inventory': baseline,
                'support_files': support, 'files': files, 'source_archive_sha256': sha(archive), **hashes}
    data = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
    (stage / 'manifest.json').write_bytes(data)
    return {'source_commit': commit, 'manifest_sha256': sha(data), 'files': len(files)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ('repo', 'commit', 'stage', 'prior-manifest'):
        parser.add_argument('--' + argument, required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.repo, args.commit, args.stage, args.prior_manifest)))

#!/usr/bin/env python3
"""Seal only the selected fixes against the accepted JAR1 bot inventory."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

SCOPE = 'jar1-parity-2026-11-28-v1'
UX_COMMIT = '40e1d25b7bbce810307e65e4556a885fec353ca1'
BASE_COMMIT = '80f5418fc565720b02a1eb00cbab168032d360d2'
BASE_MANIFEST = '3f81f513a710ab2cf6b13e63e734f2c30a2b80836e8571c8d71394362e2b7c72'
FOOTER = 'src/telegram/response.mjs'
FOOTER_BEFORE = '5780f76c64c655739a91f59a735e90fada26d94dd9657870d9fd4bf2420e499c'
FOOTER_INSTALLED = '8dbd70938eff173d3d17bc8734ce7d54362102d4b14b30194360b7feac579e65'
ROOT = 'tools/release/jar1-parity-2026-11-28/'
UX = 'tools/release/jar1-ux/'
ATTACHMENT = 'tools/release/jar1-attachment-delivery/'
AUDIT = 'tools/release/jar1-audit-2026-11-20/'
ADDED = (
    'src/autonomy/pause-notice-text.mjs',
    'src/autonomy/pause-notice.mjs',
    'src/monitor/telegram-public.mjs',
    'src/notification-demo.mjs',
    'src/telegram/routes/notifications.mjs',
)
FILES = ADDED + (
    'src/autonomy/README.md',
    'src/autonomy/owner-pause.mjs',
    'src/autonomy/reminder-dispatch.mjs',
    'src/monitor/README.md',
    'src/monitor/digest.mjs',
    'src/monitor/poll.mjs',
    'src/monitor/store.mjs',
    'src/notification-mutes.mjs',
    'src/telegram/README.md',
    'src/telegram/attachments.mjs',
    'src/telegram/auth.mjs',
    'src/telegram/batch.mjs',
    'src/telegram/bot.mjs',
    'src/telegram/pause-markers.mjs',
    'src/telegram/router.mjs',
    'src/telegram/routes/monitor.mjs',
    'src/telegram/routes/settings.mjs',
    'src/telegram/screens/settings.mjs',
)
TOOLS = {
    'build.py': ROOT + 'build.py',
    'verify.py': ROOT + 'verify.py',
    'deploy.py': ROOT + 'deploy.py',
    'fleet.py': ROOT + 'fleet.py',
    'deploy_ux.py': UX + 'deploy.py',
    'verify_ux.py': UX + 'verify.py',
    'launcher.py': ATTACHMENT + 'launcher.py',
    'source_guard.py': ATTACHMENT + 'verify.py',
    'profile.py': ATTACHMENT + 'profile.py',
    'launcher_base.py': AUDIT + 'launcher.py',
    'deploy_base.py': AUDIT + 'deploy.py',
    'runtime.py': AUDIT + 'runtime.py',
    'profile_backup.py': AUDIT + 'profile_backup.py',
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])


def installed_inventory(raw):
    if sha(raw) != BASE_MANIFEST:
        raise ValueError('Accepted UX manifest hash mismatch')
    prior = json.loads(raw)
    if prior['source_commit'] != UX_COMMIT or prior['scope'] != 'jar1-ux-v1':
        raise ValueError('Unexpected installed UX release')
    rows = prior['baseline_inventory']
    inventory = {(row['root'], row['relative']): dict(row) for row in rows}
    if len(inventory) != len(rows):
        raise ValueError('Duplicate installed baseline path')
    applied = set()
    for row in prior['files']:
        key = row['root'], row['relative']
        current = inventory.get(key, {})
        if key in applied or current.get('sha256') != row['before_sha256']:
            raise ValueError('Unexpected accepted UX delta')
        applied.add(key)
        inventory[key] = {'root': row['root'], 'relative': row['relative'],
                          'sha256': row['after_sha256']}
    footer = inventory['bot', FOOTER]
    if footer['sha256'] != FOOTER_BEFORE:
        raise ValueError('Unexpected accepted footer before hotfix')
    footer['sha256'] = FOOTER_INSTALLED
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
    if git(repo, 'show', f'{commit}:{ROOT}build.py') != Path(__file__).read_bytes():
        raise ValueError('Builder is not from the candidate')
    raw = Path(prior_manifest).read_bytes()
    baseline, support = installed_inventory(raw)
    before = {(row['root'], row['relative']): row['sha256'] for row in baseline}
    selected = {source_path('bot', name) for name in FILES}
    changed = git(repo, 'diff', '--name-only', '--no-renames', BASE_COMMIT, commit, '--',
                  '.msb', 'overlay/bot', 'usr-local-bin', 'usr-local-lib',
                  ':!.msb/bot/tests', ':!overlay/bot/ext/tests').decode().splitlines()
    if set(changed) != selected:
        raise ValueError('Runtime delta differs from parity allowlist: ' + repr(sorted(set(changed) ^ selected)))
    for (root, relative), expected in before.items():
        path = source_path(root, relative)
        ref = BASE_COMMIT if path in selected else commit
        if sha(git(repo, 'show', f'{ref}:{path}')) != expected:
            raise ValueError('Candidate baseline differs from accepted installation: ' + path)
    if {name for name in FILES if ('bot', name) not in before} != set(ADDED):
        raise ValueError('Unexpected added runtime files')
    existing_directories = {Path(name).parent for root, name in before if root == 'bot'}
    if any(Path(name).parent not in existing_directories for name in ADDED):
        raise ValueError('Cannot create new runtime directories')

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

    sources = ('.msb/puller.cjs', '.msb/sync.cjs', '.msb/bot/index.js', '.msb/bot/package.json',
               '.msb/bot/package-lock.json', '.msb/bot/OPEN-CORE.md', '.msb/bot/src', '.msb/bot/shared',
               '.msb/bot/tests', 'overlay/bot/run.mjs', 'overlay/bot/ext', 'overlay/bot/shared',
               'bootstrap/workspace-seed', 'tools/release')
    engine_and_bin = tuple(source_path(root, relative) for root, relative in before if root != 'bot')
    archive = git(repo, 'archive', '--format=tar.gz', commit, *sources, *engine_and_bin)
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

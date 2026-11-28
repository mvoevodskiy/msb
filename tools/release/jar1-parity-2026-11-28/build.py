#!/usr/bin/env python3
"""Seal the digest link fix against the accepted two-bot JAR1 release."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

SCOPE = 'jar1-digest-links-2026-11-28-v1'
BASE_COMMIT = 'e2b5183b525084d763b888a7190bb5e1ff8a21b3'
BASE_MANIFEST = 'f561c2b106804db161d1e08f847ffcb633fce09a656253dcc45ff700c2a18c96'
BASE_PROOF = '814791dcd86b117ea651c1872ca0ada2d47d5d827d01648f64e9c7add3a31a4b'
ROOT = 'tools/release/jar1-parity-2026-11-28/'
UX = 'tools/release/jar1-ux/'
ATTACHMENT = 'tools/release/jar1-attachment-delivery/'
AUDIT = 'tools/release/jar1-audit-2026-11-20/'
ADDED = ()
FILES = (
    'src/monitor/digest.mjs',
    'src/telegram/bot.mjs',
    'src/telegram/routes/monitor.mjs',
    'src/monitor/README.md',
)
REGRESSION = '.msb/bot/tests/monitor-digest-delivery.test.mjs'
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
        raise ValueError('Accepted parity manifest hash mismatch')
    prior = json.loads(raw)
    if prior['source_commit'] != BASE_COMMIT or prior['scope'] != 'jar1-parity-2026-11-28-v1':
        raise ValueError('Unexpected installed parity release')
    rows = prior['baseline_inventory']
    inventory = {(row['root'], row['relative']): dict(row) for row in rows}
    if len(inventory) != len(rows):
        raise ValueError('Duplicate installed baseline path')
    applied = set()
    for row in prior['files']:
        key = row['root'], row['relative']
        current = inventory.get(key, {})
        if key in applied or current.get('sha256') != row['before_sha256']:
            raise ValueError('Unexpected accepted parity delta')
        applied.add(key)
        inventory[key] = {'root': row['root'], 'relative': row['relative'],
                          'sha256': row['after_sha256']}
    by_root = {root: sum(key[0] == root for key in inventory) for root in ('bot', 'bin', 'engine')}
    if by_root != {'bot': 343, 'bin': 1, 'engine': 11} or len(inventory) != 355 or len(prior['support_files']) != 6:
        raise ValueError('Unexpected accepted parity inventory counts')
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


def check_prior_proof(raw, proof_raw):
    if sha(proof_raw) != BASE_PROOF:
        raise ValueError('Accepted prior proof hash mismatch')
    prior, proof = json.loads(raw), json.loads(proof_raw)
    if proof.get('passed') is not True or proof.get('manifest_sha256') != BASE_MANIFEST or any(
            proof.get(key) != prior[key] for key in ('scope', 'source_commit', 'source_archive_sha256')):
        raise ValueError('Accepted prior proof does not describe the starting release')


def build(repo, commit, stage, prior_manifest, prior_proof):
    repo, stage = Path(repo).resolve(), Path(stage).absolute()
    commit = git(repo, 'rev-parse', '--verify', commit + '^{commit}').decode().strip()
    git(repo, 'merge-base', '--is-ancestor', BASE_COMMIT, commit)
    if git(repo, 'show', f'{commit}:{ROOT}build.py') != Path(__file__).read_bytes():
        raise ValueError('Builder is not from the candidate')
    raw = Path(prior_manifest).read_bytes()
    baseline, support = installed_inventory(raw)
    check_prior_proof(raw, Path(prior_proof).read_bytes())
    prior = json.loads(raw)
    before = {(row['root'], row['relative']): row['sha256'] for row in baseline}
    selected = {source_path('bot', name) for name in FILES}
    tooling = {ROOT + name for name in ('build.py', 'test_release.py')}
    required = selected | tooling | {REGRESSION}
    changed = set(git(repo, 'diff', '--name-only', '--no-renames', BASE_COMMIT, commit,
                      '--').decode().splitlines())
    if changed != required:
        raise ValueError('Candidate differs from digest link allowlist: ' + repr(sorted(changed ^ required)))
    for path in selected | {REGRESSION}:
        fields = git(repo, 'ls-tree', commit, '--', path).split()
        if fields[:2] not in ([b'100644', b'blob'], [b'100755', b'blob']):
            raise ValueError('Candidate path is not a regular file: ' + path)
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
        key = name.removesuffix('.py') + '_sha256'
        hashes[key] = sha(content)
        if name != 'build.py' and hashes[key] != prior[key]:
            raise ValueError('Previously accepted operator changed: ' + name)
    manifest = {'schema': 1, 'scope': SCOPE, 'source_commit': commit, 'base_commit': BASE_COMMIT,
                'prior_sha256': BASE_MANIFEST, 'baseline_inventory': baseline,
                'support_files': support, 'files': files, 'source_archive_sha256': sha(archive), **hashes}
    data = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
    (stage / 'manifest.json').write_bytes(data)
    return {'source_commit': commit, 'manifest_sha256': sha(data), 'files': len(files)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ('repo', 'commit', 'stage', 'prior-manifest', 'prior-proof'):
        parser.add_argument('--' + argument, required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.repo, args.commit, args.stage, args.prior_manifest, args.prior_proof)))

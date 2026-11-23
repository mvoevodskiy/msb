#!/usr/bin/env python3
"""Export the attachment-only JAR1 release from one committed source tree."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

PRIOR_SHA = 'f06c76e80a6d6013a1834d73dd2c2a64356db3809339bce940b6fcf7cef89eed'
PRIOR_COMMIT = 'a19689e080a6bb2be212ded5fe53eca54df82d26'
PREFIX = 'tools/release/jar1-attachment-delivery/'
AUDIT = 'tools/release/jar1-audit-2026-11-20/'
FILES = {
 'src/telegram/bot.mjs': ('1525f94c6ad943b0551f73442bb1e3734f3e9e156f00b561bddbab766c417d30', 'b5c763562f988ddad5c28f2dffce23bf4e34c330ddff1016847f9782f12a41de'),
 'src/telegram/send-media.mjs': ('e4c4664c75f53d63b2382756dc7d1aec49dc30e3ef81a7ebb5b83082d46526ca', '25254a86c8c36652df7b1db091670fa6eefb9e69605f4666eaa96d1c9cc53282'),
 'src/telegram/media-markers.mjs': ('ca89d3760aa868b0ba5bc9399b04a2805262a3e802274b01f4a634d9304b0c27', '522f6b8ebb418f48dbcba6ac8934e28a45fe97a1743ca16581a0d16490eccfee'),
}
DEPENDENCIES = {
 'src/telegram/response.mjs': '5780f76c64c655739a91f59a735e90fada26d94dd9657870d9fd4bf2420e499c',
 'src/agent/turn.mjs': 'aac39a71893abb4c7fbf112d9c2c231e58120eca4bc91b361e26dcc047e57d50',
 'ext/shim/run-turn.mjs': '255439e954b3690c9b7d51b3833bd50d222a4a1fd4ffc19ed43f21392ed9eba0',
}
TOOLS = {'launcher.py': PREFIX + 'launcher.py', 'verify.py': PREFIX + 'verify.py',
         'deploy.py': PREFIX + 'deploy.py', 'deploy_base.py': AUDIT + 'deploy.py',
         'runtime.py': AUDIT + 'runtime.py', 'profile_backup.py': AUDIT + 'profile_backup.py',
         'launcher_base.py': AUDIT + 'launcher.py', 'build.py': PREFIX + 'build.py',
         'profile.py': PREFIX + 'profile.py'}
SOURCES = ('.msb/bot/index.js', '.msb/bot/package.json', '.msb/bot/package-lock.json',
 '.msb/bot/OPEN-CORE.md', '.msb/bot/src', '.msb/bot/shared', '.msb/bot/tests',
 'overlay/bot/run.mjs', 'overlay/bot/ext', 'overlay/bot/shared', 'bootstrap/workspace-seed',
 'tools/release/jar1-attachment-delivery', 'tools/release/jar1-audit-2026-11-20')


def sha(data): return hashlib.sha256(data).hexdigest()
def git(repo, *args): return subprocess.check_output(['git', '-C', str(repo), *args])


def prior_inventory(raw):
    if sha(raw) != PRIOR_SHA: raise ValueError('Previous JAR1 manifest hash mismatch')
    prior = json.loads(raw)
    if prior.get('source_commit') != PRIOR_COMMIT or len(prior.get('baseline_inventory', [])) != 347 or len(prior.get('files', [])) != 6 or len(prior.get('support_files', [])) != 6:
        raise ValueError('Previous JAR1 manifest identity changed')
    rows = prior['baseline_inventory']
    inventory = {(row['root'], row['relative']): dict(row) for row in rows}
    if len(inventory) != len(rows): raise ValueError('Duplicate baseline entry')
    for row in prior['files']:
        key = (row['root'], row['relative'])
        if key not in inventory: raise ValueError('Previous release target missing in inventory')
        inventory[key]['sha256'] = row['after_sha256']
    return list(inventory.values()), prior['support_files']


def source_path(root, rel):
    if root == 'bot': return ('overlay/bot/' if rel.startswith('ext/') or rel == 'run.mjs' else '.msb/bot/') + rel
    if root == 'engine': return 'usr-local-lib/msb-engine/' + rel
    if root == 'bin' and rel == 'bot-ctl.sh': return 'usr-local-bin/' + rel
    raise ValueError('Unknown prior inventory path')


def build(repo, commit, stage, prior_manifest):
    repo, stage = Path(repo).resolve(), Path(stage).absolute()
    commit = git(repo, 'rev-parse', '--verify', commit + '^{commit}').decode().strip()
    if git(repo, 'show', commit + ':' + PREFIX + 'build.py') != Path(__file__).read_bytes():
        raise ValueError('Builder is not from the selected commit')
    prior = Path(prior_manifest).read_bytes()
    inventory, support = prior_inventory(prior)
    expected = {(r['root'], r['relative']): r['sha256'] for r in inventory}
    for name, (before, _) in FILES.items():
        if expected.get(('bot', name)) != before: raise ValueError('Expected target baseline differs')
    for name, value in DEPENDENCIES.items():
        if expected.get(('bot', name)) != value: raise ValueError('Expected dependency baseline differs')
    for (root, rel), before in expected.items():
        if (root, rel) in {('bot', n) for n in FILES}: continue
        path = source_path(root, rel)
        if sha(git(repo, 'show', commit + ':' + path)) != before:
            raise ValueError('Candidate differs from installed baseline: ' + path)
    for name, (_, after) in FILES.items():
        if sha(git(repo, 'show', commit + ':.msb/bot/' + name)) != after:
            raise ValueError('Candidate target differs from reviewed fix: ' + name)
    # Tests must not depend on extra candidate code that is absent on the live
    # non-OpenClaw baseline. Mirror the audited runtime inventory boundary.
    paused = re.compile(r'openclaw|native.?oc|(?:^|[/_-])oc(?:[/_.-]|$)', re.I)
    for prefix, target in (('.msb/bot/src/', 'src/'), ('.msb/bot/shared/', 'shared/'),
                           ('overlay/bot/ext/', 'ext/')):
        for path in git(repo, 'ls-tree', '-r', '--name-only', commit, '--', prefix).decode().splitlines():
            relative = target + path.removeprefix(prefix)
            if '/tests/' in '/' + relative or paused.search(relative): continue
            if Path(path).suffix not in ('.mjs', '.cjs', '.js', '.py', '.json', '.md') and relative != 'ext/shim/bin/claude': continue
            if ('bot', relative) not in expected: raise ValueError('Candidate contains uninstalled code: ' + path)
    stage.mkdir(mode=0o700, parents=False, exist_ok=False)
    (stage / 'prior.json').write_bytes(prior)
    files = []
    for name, (before, after) in FILES.items():
        source = '.msb/bot/' + name
        dest = stage / 'payload/bot' / name
        dest.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        dest.write_bytes(git(repo, 'show', commit + ':' + source))
        files.append({'root': 'bot', 'relative': name, 'source': source, 'before_sha256': before, 'after_sha256': after})
    archive = git(repo, 'archive', '--format=tar.gz', commit, *SOURCES)
    (stage / 'source.tar.gz').write_bytes(archive)
    hashes = {}
    for name, source in TOOLS.items():
        content = git(repo, 'show', commit + ':' + source)
        (stage / name).write_bytes(content)
        hashes[name.removesuffix('.py') + '_sha256'] = sha(content)
    manifest = {'schema': 1, 'scope': 'jar1-attachment-delivery-v1', 'source_commit': commit,
      'prior_sha256': PRIOR_SHA, 'baseline_inventory': inventory, 'support_files': support,
      'files': files, 'dependencies': DEPENDENCIES, 'source_archive_sha256': sha(archive), **hashes}
    raw = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
    (stage / 'manifest.json').write_bytes(raw)
    return {'source_commit': commit, 'manifest_sha256': sha(raw), 'files': len(files)}


if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--repo', required=True); p.add_argument('--commit', required=True)
    p.add_argument('--stage', required=True); p.add_argument('--prior-manifest', required=True)
    a = p.parse_args(); print(json.dumps(build(a.repo, a.commit, a.stage, a.prior_manifest)))

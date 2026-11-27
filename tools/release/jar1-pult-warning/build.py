#!/usr/bin/env python3
"""Build a Pult collector/UI update and its tests from one source commit."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

BASE = 'a19689e080a6bb2be212ded5fe53eca54df82d26'
FILES = ('src/collector/sources/codex-usage-data.ts', 'src/collector/sources/codex-usage.ts')
PATCH_SCOPE = 'pult-collector-ui-patch-v1'
PREFIX = 'tools/release/jar1-pult-warning/'
TOOLS = {'launcher.py': 'tools/release/jar1-audit-2026-11-20/launcher.py',
         'deploy_base.py': 'tools/release/jar1-audit-2026-11-20/deploy.py',
         'pult_base.py': 'tools/release/jar1-codex-usage/pult-deploy.py',
         'verify.py': PREFIX + 'verify.py', 'pult-deploy.py': PREFIX + 'pult-deploy.py'}
CCUSAGE_SHA256 = '7ddd309d8f4d1c2c007647f43c300a8261acbe9e5cb355e70cc428f0f419f8d2'


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])


def sha(data):
    return hashlib.sha256(data).hexdigest()


def build(repo, commit, stage, patch_base=None):
    repo, stage = Path(repo).resolve(), Path(stage).absolute()
    commit = git(repo, 'rev-parse', '--verify', commit + '^{commit}').decode().strip()
    if git(repo, 'show', commit + ':' + PREFIX + 'build.py') != Path(__file__).read_bytes():
        raise ValueError('Run the builder from the selected source commit')
    base = git(repo, 'rev-parse', '--verify', patch_base + '^{commit}').decode().strip() if patch_base else BASE
    if git(repo, 'merge-base', base, commit).decode().strip() != base:
        raise ValueError('Source commit does not descend from the installed baseline')
    changed = sorted(p.removeprefix('.msb/pult/') for p in git(repo, 'diff', '--name-only', base, commit,
        '--', '.msb/pult/src', '.msb/pult/config', '.msb/pult/package.json', '.msb/pult/package-lock.json').decode().splitlines())
    if patch_base:
        if not changed or any(not name.startswith(('src/collector/', 'src/ui/')) or
                              Path(name).suffix not in ('.ts', '.js', '.css', '.html', '.json') for name in changed):
            raise ValueError('Expected changes limited to existing Pult collector or UI files')
    elif set(changed) != set(FILES):
        raise ValueError('Unexpected Pult runtime changes: ' + repr(sorted(set(changed) ^ set(FILES))))
    stage.mkdir(mode=0o755, parents=False, exist_ok=False)
    files = []
    for name in changed if patch_base else FILES:
        source = '.msb/pult/' + name
        before, after = (git(repo, 'show', ref + ':' + source) for ref in (base, commit))
        target = stage / 'payload/pult' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(after)
        files.append({'root': 'pult', 'relative': name, 'source': source,
                      'before_sha256': sha(before), 'after_sha256': sha(after)})
    paths = git(repo, 'ls-tree', '-r', '--name-only', base, '--', '.msb/pult/src',
                '.msb/pult/package.json', '.msb/pult/package-lock.json',
                '.msb/pult/config/ccusage-report.json').decode().splitlines()
    inventory = [{'relative': p.removeprefix('.msb/pult/'), 'sha256': sha(git(repo, 'show', base + ':' + p))}
                 for p in paths if Path(p).suffix in ('.ts', '.js', '.css', '.html', '.json')]
    archive = git(repo, 'archive', '--format=tar.gz', commit, '.msb/pult', PREFIX)
    (stage / 'source.tar.gz').write_bytes(archive)
    hashes = {}
    for target, source in TOOLS.items():
        content = git(repo, 'show', commit + ':' + source)
        (stage / target).write_bytes(content)
        hashes[target.removesuffix('.py') + '_sha256'] = sha(content)
    manifest = {'schema': 1, 'scope': PATCH_SCOPE if patch_base else 'pult-usage-warning-v1', 'base_commit': base,
                'source_commit': commit, 'source_archive_sha256': sha(archive),
                'pult_files': files, 'pult_baseline_inventory': inventory,
                'ccusage_binary_sha256': CCUSAGE_SHA256, **hashes}
    data = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
    (stage / 'manifest.json').write_bytes(data)
    return {'source_commit': commit, 'manifest_sha256': sha(data), 'files': len(files)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--stage', required=True)
    parser.add_argument('--patch-base', help='verified installed Pult Git baseline for a collector/UI-only patch')
    args = parser.parse_args()
    print(json.dumps(build(args.repo, args.commit, args.stage, args.patch_base)))

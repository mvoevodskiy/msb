#!/usr/bin/env python3
"""Build the cache-breakdown update on top of the last verified JAR1 release."""
import argparse
import base64
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

BASE = '35bf0b6b2092769a8c6b49b4f0b4a2090d22f204'
PREVIOUS = BASE
OPS = 'tools/release/jar1-codex-cache'
PRIOR_OPS = 'tools/release/jar1-codex-usage'
OLD = 'tools/release/jar1-audit-2026-11-20'
BOT = ('src/autonomy/prompt-turn.mjs', 'src/autonomy/prompt-delivery.mjs',
       'src/autonomy/reminder-dispatch.mjs', 'src/autonomy/reminder-runs.mjs',
       'ext/adapters/saved-codex-usage.mjs', 'ext/adapters/saved-codex.mjs')
PULT = ('src/collector/sources/codex-usage-data.ts', 'src/collector/sources/codex-usage.ts',
        'src/shared/types.ts', 'src/ui/view-bot-usage.js', 'src/ui/app.css')
TOOLS = {'verify.py': OPS + '/verify.py', 'deploy.py': OPS + '/deploy.py',
         'pult-deploy.py': OPS + '/pult-deploy.py', 'pult_base.py': PRIOR_OPS + '/pult-deploy.py',
         'verify_base.py': OLD + '/verify.py',
         'deploy_base.py': OLD + '/deploy.py', 'launcher.py': OLD + '/launcher.py',
         'runtime.py': OLD + '/runtime.py', 'profile_backup.py': OLD + '/profile_backup.py'}
CCUSAGE_SHA512 = 'NZN5h+HBHC6tOO3aadbsZEKzGfNS24asTcvgv+iP9gY0Cw1QyzSaOhqJM1E2f8nkCsqiX2NRrb/RNC7dvcXx7g=='


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])


def sha(data):
    return hashlib.sha256(data).hexdigest()


def previous_manifest(repo, ccusage_archive):
    spec = importlib.util.spec_from_file_location('prior_usage_builder', repo / PRIOR_OPS / 'build.py')
    prior = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(prior)
    spec = importlib.util.spec_from_file_location('prior_audit_builder', repo / OLD / 'build.py')
    old = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(old)
    with tempfile.TemporaryDirectory(prefix='codex-usage-baseline-') as temp:
        path = Path(temp) / 'previous'
        manifest = prior.build(repo, PREVIOUS, path, ccusage_archive)
        composite = (path / 'composite.tar.gz').read_bytes()
        if sha(composite) != manifest['composite_archive_sha256']: raise ValueError('Prior composite changed')
        return old, manifest, composite


def composite_archive(repo, commit, stage, prior_archive, old, inventory):
    """Seal the installed non-OpenClaw baseline plus the selected candidate files."""
    selected = {('bot', name) for name in BOT}
    provenance = []
    with tempfile.TemporaryDirectory(prefix='codex-usage-composite-') as temp:
        tree = Path(temp) / 'tree'
        tree.mkdir()
        baseline = Path(temp) / 'baseline'
        baseline.mkdir()
        with tarfile.open(fileobj=io.BytesIO(prior_archive), mode='r:gz') as archive:
            archive.extractall(baseline, filter='data')
        raw = git(repo, 'archive', '--format=tar', commit, *old.SOURCES, '.msb/pult')
        with tempfile.TemporaryFile() as stream:
            stream.write(raw); stream.seek(0)
            with tarfile.open(fileobj=stream, mode='r:') as archive:
                archive.extractall(tree, filter='data')
        for (root, relative), row in inventory.items():
            if root != 'bot' or (root, relative) in selected:
                continue
            if not relative.startswith(('src/', 'shared/', 'ext/')):
                continue
            source = ('overlay/bot/' + relative) if relative.startswith('ext/') else ('.msb/bot/' + relative)
            content = (baseline / source).read_bytes()
            if sha(content) != row['sha256']:
                raise ValueError('Cannot reconstruct installed source: ' + source)
            target = tree / source
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            provenance.append({'source': source, 'previous_release': PREVIOUS, 'sha256': row['sha256']})
        paused = re.compile(r'openclaw|native.?oc|(?:^|[/_-])oc(?:[/_.-]|$)', re.I)
        for prefix, relative_prefix in (('.msb/bot/src', 'src'), ('.msb/bot/shared', 'shared'), ('overlay/bot/ext', 'ext')):
            for target in (tree / prefix).rglob('*'):
                if not target.is_file() or target.is_symlink(): continue
                relative = relative_prefix + '/' + target.relative_to(tree / prefix).as_posix()
                if '/tests/' in '/' + relative or paused.search(relative): continue
                if target.suffix not in ('.mjs', '.cjs', '.js', '.py', '.json', '.md') and relative != 'ext/shim/bin/claude': continue
                if ('bot', relative) not in inventory and ('bot', relative) not in selected:
                    target.unlink()
        archive_path = stage / 'composite.tar.gz'
        with tarfile.open(archive_path, 'w:gz') as archive:
            for child in sorted(tree.iterdir()): archive.add(child, arcname=child.name)
    return sha(archive_path.read_bytes()), provenance


def build(repo, commit, stage, ccusage_archive):
    repo, stage = Path(repo).resolve(), Path(stage).absolute()
    commit = git(repo, 'rev-parse', '--verify', commit + '^{commit}').decode().strip()
    if git(repo, 'show', commit + ':' + OPS + '/build.py') != Path(__file__).read_bytes() or \
       git(repo, 'show', commit + ':' + OLD + '/build.py') != (repo / OLD / 'build.py').read_bytes():
        raise ValueError('Run only the builders from the selected commit')
    if commit == git(repo, 'rev-parse', 'HEAD').decode().strip() and git(repo, 'status', '--porcelain').strip():
        raise ValueError('Commit intended changes before building HEAD')
    if git(repo, 'merge-base', BASE, commit).decode().strip() != BASE:
        raise ValueError('Candidate must descend from the selected source baseline')
    changed = set(git(repo, 'diff', '--name-only', BASE, commit, '--', '.msb/bot/src', 'overlay/bot/ext',
                      '.msb/bot/shared', '.msb/pult/src', '.msb/pult/config').decode().splitlines())
    changed = {name for name in changed if '/tests/' not in name and not name.endswith('.md')}
    expected = {('overlay/bot/' if name.startswith('ext/') else '.msb/bot/') + name for name in BOT} | \
               {'.msb/pult/' + name for name in PULT}
    if changed != expected:
        raise ValueError('Unexpected runtime changes: ' + repr(sorted(changed ^ expected)))

    old, previous, prior_archive = previous_manifest(repo, ccusage_archive)
    inventory = {(x['root'], x['relative']): x for x in previous['baseline_inventory']}
    for item in previous['files']:
        inventory[(item['root'], item['relative'])] = {'root': item['root'], 'relative': item['relative'],
                                                       'sha256': item['after_sha256']}
    stage.mkdir(mode=0o700, parents=False, exist_ok=False)
    dependency = Path(ccusage_archive).read_bytes()
    if base64.b64encode(hashlib.sha512(dependency).digest()).decode() != CCUSAGE_SHA512:
        raise ValueError('ccusage archive integrity mismatch')
    (stage / 'ccusage.tgz').write_bytes(dependency)
    with tarfile.open(stage / 'ccusage.tgz', 'r:gz') as package:
        member = package.getmember('package/bin/ccusage')
        if not member.isfile() or member.size > 12_000_000:
            raise ValueError('Unexpected ccusage binary')
        binary = package.extractfile(member).read()
    (stage / 'ccusage').write_bytes(binary)
    (stage / 'ccusage').chmod(0o755)

    def payload(root, names):
        result = []
        for name in names:
            source = ('overlay/bot/' + name) if root == 'bot' and name.startswith('ext/') else '.msb/' + root + '/' + name
            old = subprocess.run(['git', '-C', str(repo), 'show', BASE + ':' + source], capture_output=True)
            before = sha(old.stdout) if old.returncode == 0 else None
            after = git(repo, 'show', commit + ':' + source)
            target = stage / 'payload' / root / name
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            target.write_bytes(after)
            result.append({'root': root, 'relative': name, 'source': source,
                           'before_sha256': before, 'after_sha256': sha(after)})
            if root == 'bot' and before is not None and inventory.get((root, name), {}).get('sha256') != before:
                raise ValueError('Previous installed inventory differs from source baseline: ' + source)
        return result

    files, pult_files = payload('bot', BOT), payload('pult', PULT)
    pult_inventory = []
    paths = git(repo, 'ls-tree', '-r', '--name-only', BASE, '--', '.msb/pult/src',
                '.msb/pult/package.json', '.msb/pult/package-lock.json').decode().splitlines()
    for source in paths:
        if Path(source).suffix not in ('.ts', '.js', '.css', '.html', '.json'): continue
        pult_inventory.append({'relative': source.removeprefix('.msb/pult/'),
                               'sha256': sha(git(repo, 'show', BASE + ':' + source))})
    archive = stage / 'source.tar.gz'
    with archive.open('wb') as raw:
        with gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as compressed:
            process = subprocess.Popen(['git', '-C', str(repo), 'archive', '--format=tar', commit,
                                        *previous_sources(repo), '.msb/pult'], stdout=subprocess.PIPE)
            shutil.copyfileobj(process.stdout, compressed)
            process.stdout.close()
            if process.wait() != 0:
                raise RuntimeError('Source archive failed')
    composite_hash, composite_provenance = composite_archive(repo, commit, stage, prior_archive, old, inventory)
    tool_hashes = {}
    for name, source in TOOLS.items():
        content = git(repo, 'show', commit + ':' + source)
        (stage / name).write_bytes(content)
        tool_hashes[name.removesuffix('.py') + '_sha256'] = sha(content)
    manifest = {'schema': 1, 'base_commit': BASE, 'source_commit': commit, 'files': files,
                'pult_files': pult_files, 'pult_baseline_inventory': pult_inventory,
                'baseline_inventory': list(inventory.values()),
                'support_files': previous['support_files'], 'source_archive_sha256': sha(archive.read_bytes()),
                'composite_archive_sha256': composite_hash, 'composite_provenance': composite_provenance,
                'ccusage_version': '20.0.51', 'ccusage_archive_sha512': CCUSAGE_SHA512,
                'ccusage_binary_sha256': sha(binary), **tool_hashes}
    (stage / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
    return manifest


def previous_sources(repo):
    spec = importlib.util.spec_from_file_location('prior_sources', repo / OLD / 'build.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.SOURCES


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--repo', required=True)
    p.add_argument('--commit', required=True)
    p.add_argument('--stage', required=True)
    p.add_argument('--ccusage-archive', required=True)
    args = p.parse_args()
    result = build(args.repo, args.commit, args.stage, args.ccusage_archive)
    print(json.dumps({'source_commit': result['source_commit'], 'bot_files': len(result['files']),
                      'pult_files': len(result['pult_files'])}))

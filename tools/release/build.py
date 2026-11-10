#!/usr/bin/env python3
"""Export a reproducible bot release from one Git commit. No patches or network."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess

REPO = Path(__file__).resolve().parents[2]
SINGLE = {
    '.msb/bot/index.js': 'bot/index.js',
    'overlay/bot/run.mjs': 'bot/run.mjs',
    '.msb/bot/package.json': 'bot/package.json',
    '.msb/bot/package-lock.json': 'bot/package-lock.json',
    '.msb/bot/OPEN-CORE.md': 'bot/OPEN-CORE.md',
    '.msb/puller.cjs': 'puller.cjs',
    '.msb/sync.cjs': 'sync.cjs',
    'tools/release/profiles/jar1.json': 'bot/runtime-profile.json',
}
TREES = {'.msb/bot/src/': 'bot/src/', '.msb/bot/shared/': 'bot/shared/', 'overlay/bot/ext/': 'bot/ext/'}
CHECKS = ('.msb/bot/tests/', 'overlay/bot/ext/tests/')

def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])

def sha(data):
    return hashlib.sha256(data).hexdigest()

def tracked(repo, commit):
    for record in git(repo, 'ls-tree', '-rz', '--full-tree', commit).split(b'\0'):
        if not record:
            continue
        header, name = record.split(b'\t', 1)
        mode, kind, oid = header.decode().split()
        yield name.decode(), mode, kind, oid

def runtime_target(source):
    if source in SINGLE:
        return SINGLE[source]
    if '/tests/' in source:
        return None
    for prefix, target in TREES.items():
        if source.startswith(prefix):
            return target + source[len(prefix):]
    return None

def write_blob(file, content, mode):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes(content)
    file.chmod(0o755 if mode == '100755' else 0o644)

def build(repo, ref, output):
    repo, output = Path(repo).resolve(), Path(output).resolve()
    commit = git(repo, 'rev-parse', '--verify', ref + '^{commit}').decode().strip()
    if len(commit) != 40 or any(c not in '0123456789abcdef' for c in commit):
        raise ValueError('Expected a full commit SHA')
    # A dirty checkout must never accidentally masquerade as the current release.
    if commit == git(repo, 'rev-parse', 'HEAD').decode().strip() and git(repo, 'status', '--porcelain').strip():
        raise ValueError('Commit the intended changes before building HEAD')
    if git(repo, 'show', commit + ':tools/release/build.py') != Path(__file__).read_bytes():
        raise ValueError('Run the exporter stored in the selected commit')
    output.mkdir(parents=True, exist_ok=False)
    files, sources, tooling, seen = [], [], [], set()
    for source, mode, kind, oid in tracked(repo, commit):
        target = runtime_target(source)
        test_source = source.startswith(CHECKS) or source.startswith('tools/release/tests/')
        shared_link = source == 'overlay/bot/shared'
        tool_source = source.startswith('tools/release/') and source.endswith(('.py', '.mjs')) and '/tests/' not in source
        if not (target or test_source or shared_link or tool_source):
            continue
        if kind != 'blob' or mode not in ['100644', '100755', '120000']:
            raise ValueError(f'Unsupported tracked object: {source}')
        content = git(repo, 'cat-file', 'blob', oid)
        if mode == '120000':
            if not shared_link or content.decode() != '../../.msb/bot/shared':
                raise ValueError(f'Unexpected source symlink: {source}')
            link = output / 'checks/source' / source
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(content.decode())
            sources.append({'source': source, 'sha256': sha(content), 'symlink': content.decode()})
            continue
        write_blob(output / 'checks/source' / source, content, mode)
        sources.append({'source': source, 'sha256': sha(content), 'mode': '0755' if mode == '100755' else '0644'})
        if tool_source:
            tool_target = source.removeprefix('tools/release/')
            write_blob(output / 'ops' / tool_target, content, mode)
            tooling.append({'source': source, 'target': tool_target, 'sha256': sha(content)})
        if target:
            if any(part.startswith('.') for part in PurePosixPath(target).parts):
                raise ValueError('Hidden data file in runtime source')
            if target in seen or '..' in PurePosixPath(target).parts:
                raise ValueError(f'Duplicate or unsafe runtime target: {target}')
            seen.add(target)
            write_blob(output / 'runtime' / target, content, mode)
            files.append({'source': source, 'target': target, 'sha256': sha(content),
                          'size': len(content), 'mode': '0755' if mode == '100755' else '0644'})
    missing = set(SINGLE.values()) - seen
    if missing or not any(x.startswith('bot/shared/') for x in seen):
        raise ValueError(f'Incomplete release: {sorted(missing)}')
    profile = json.loads((output / 'runtime/bot/runtime-profile.json').read_text())
    if profile != {'profile': 'jar1'}:
        raise ValueError('Unexpected JAR1 runtime profile')
    source_inventory = json.dumps(sorted(sources, key=lambda x: x['source']), indent=2) + '\n'
    (output / 'checks/source-inventory.json').write_text(source_inventory)
    manifest = {'schema': 1, 'checks_sha256': sha(source_inventory.encode()), 'source_commit': commit,
        'source_tree': git(repo, 'rev-parse', commit + '^{tree}').decode().strip(),
        'profile': 'jar1', 'files': sorted(files, key=lambda x: x['target']),
        'tooling': sorted(tooling, key=lambda x: x['target']),
        'external_runtime': {'node_min_major': 22, 'codex': '0.166.0',
            'service': 'iia-bot@default.service', 'root': '/home/client/.iia'},
        'excluded_data': ['.env', 'bots/', 'workspace/', 'sessions/', 'native auth', 'node_modules/'],
        'dependency_lock_sha256': sha((output / 'runtime/bot/package-lock.json').read_bytes())}
    body = json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + '\n'
    (output / 'release.json').write_text(body)
    (output / 'runtime/bot/release.json').write_text(body)
    return manifest

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repo', type=Path, default=REPO)
    p.add_argument('--commit', default='HEAD')
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    manifest = build(args.repo, args.commit, args.output)
    print(json.dumps({'source_commit': manifest['source_commit'], 'files': len(manifest['files']), 'output': str(args.output)}))

if __name__ == '__main__':
    main()

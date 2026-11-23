#!/usr/bin/env python3
"""Export one AG1 candidate directly from one immutable Git commit."""

import argparse
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile

import contract
import stage as stage_checks

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
OPERATORS = ('contract.py', 'transaction.py', 'stage.py', 'protected.py', 'verify.py', 'deploy.py',
             *contract.BASELINE_FILES, *contract.OPERATOR_TESTS)


def git(*args):
    return subprocess.check_output(['git', '-C', str(REPO), *args])


def blob(commit, name):
    return git('show', commit + ':' + name)


def build(commit, output):
    os.umask(0o022)
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Supply the full immutable 40-character source commit')
    if git('rev-parse', '--verify', commit + '^{commit}').decode().strip() != commit:
        raise ValueError('Commit identity changed')
    # The exporter is itself from the exact candidate, not uncommitted code.
    if blob(commit, contract.TOOLS + '/build.py') != Path(__file__).read_bytes():
        raise ValueError('Run build.py from the selected candidate commit')
    for name in OPERATORS:
        if blob(commit, contract.TOOLS + '/' + name) != (HERE / name).read_bytes():
            raise ValueError('Run all build helpers from the selected commit: ' + name)
    output = Path(output).absolute()
    output.mkdir(mode=0o755, parents=False, exist_ok=False)
    source = output / 'source'
    source.mkdir()
    raw = git('archive', '--format=tar', commit, '.msb/bot', 'overlay/bot')
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as archive:
        archive.extractall(source, filter='data')
    for name in ('.msb/bot/node_modules', 'overlay/bot/node_modules'):
        path = source / name
        if os.path.lexists(path): raise ValueError('Unexpected tracked node_modules')
        path.symlink_to('/tmp/ag1-dependencies', target_is_directory=True)
    targets = []
    for relative, (source_path, before, after) in contract.FILES.items():
        data = blob(commit, source_path)
        if contract.sha_bytes(data) != after:
            raise ValueError('Candidate target is not the reviewed AG1 blob: ' + source_path)
        if (source / source_path).read_bytes() != data:
            raise ValueError('Export differs from candidate Git blob')
        dest = output / 'payload' / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        targets.append({'relative': relative, 'source': source_path,
                        'before_sha256': before, 'after_sha256': after})
    inventory = stage_checks.candidate_inventory(source)
    for name, expected in contract.UNCHANGED.items():
        if inventory.get(name) != expected:
            raise ValueError('Candidate does not use verified AG1 dependency: ' + name)
    for name in contract.TESTS:
        if not (source / name).is_file(): raise ValueError('Candidate test missing: ' + name)
    test_data = (source / contract.TESTS[0]).read_text()
    if 'MSB_TEST_CODEX_TRANSPORT' not in test_data or 'codex-exec' not in test_data:
        raise ValueError('Candidate lacks the AG1 Codex exec test contract')
    operators = {}
    for name in OPERATORS:
        data = blob(commit, contract.TOOLS + '/' + name)
        (output / name).write_bytes(data)
        operators[name] = contract.sha_bytes(data)
    for name, gitpath in (('jar1-primitives.py', contract.OLD_PRIMITIVES),
                          ('runtime.py', contract.OLD_RUNTIME)):
        data = blob(commit, gitpath)
        (output / name).write_bytes(data)
        operators[name] = contract.sha_bytes(data)
    baseline = stage_checks.baseline_from_stage(output)
    candidate_expected = {name: item['sha256'] for name, item in baseline.items()}
    for name, (_, _, after) in contract.FILES.items(): candidate_expected[name] = after
    if candidate_expected != inventory:
        differences = sorted(k for k in set(candidate_expected) | set(inventory)
                             if candidate_expected.get(k) != inventory.get(k))
        raise ValueError('Candidate differs from scoped AG1 runtime: ' + ', '.join(differences[:20]))
    manifest = {
        'format': 'ag1-attachment-delivery-v1', 'host': contract.HOST, 'unit': contract.UNIT,
        'source_commit': commit, 'source_tree_sha': git('rev-parse', commit + '^{tree}').decode().strip(),
        'files': targets, 'baseline': baseline, 'runtime_inventory': inventory,
        'source_tree': stage_checks.tree_files(source), 'operators': operators,
        'scope': 'targeted Codex exec, Claude, and media tests; OpenClaw scenarios excluded',
    }
    manifest_data = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
    (output / 'manifest.json').write_bytes(manifest_data)
    return contract.sha_bytes(manifest_data)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--commit', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    print(build(args.commit, args.output))


if __name__ == '__main__':
    main()

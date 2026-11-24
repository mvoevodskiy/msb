"""Validate a sealed stage and compare its scoped source with AG1 code."""

import json
import grp
import os
from pathlib import Path
import pwd
import socket
import stat
import subprocess

import contract
import transaction
def checked_file(path):
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        raise RuntimeError('Expected an unlinked regular file: ' + str(path))
    return contract.sha_bytes(path.read_bytes())


def tree_files(root, *, runtime_prefix=None):
    """Hash an exported source, including symlink identity but never following it."""
    root = Path(root)
    found = {}
    for base, dirs, files in os.walk(root, followlinks=False):
        dirs.sort(); files.sort()
        for name in list(dirs) + files:
            path = Path(base) / name
            relative = path.relative_to(root).as_posix()
            runtime = runtime_prefix + '/' + relative if runtime_prefix else None
            if runtime and contract.EXCLUDED.search(runtime):
                if name in dirs: dirs.remove(name)
                continue
            st = path.lstat()
            if stat.S_ISLNK(st.st_mode):
                if runtime and name in dirs:
                    raise RuntimeError('Scoped code directory is symlinked: ' + runtime)
                if runtime and not contract.code_path(runtime):
                    if name in dirs: dirs.remove(name)
                    continue
                found[relative] = {'link': os.readlink(path)}
                if name in dirs: dirs.remove(name)
            elif stat.S_ISREG(st.st_mode):
                if runtime and not contract.code_path(runtime): continue
                found[relative] = {'sha256': checked_file(path)}
            elif not stat.S_ISDIR(st.st_mode):
                raise RuntimeError('Unsupported source entry: ' + relative)
    return found


def candidate_inventory(source):
    source = Path(source)
    inventory = {}
    for source_dir, runtime_dir in (('.msb/bot/src', 'src'), ('.msb/bot/shared', 'shared'),
                                    ('overlay/bot/ext', 'ext')):
        root = source / source_dir
        if not root.is_dir() or root.is_symlink():
            raise RuntimeError('Missing candidate code directory: ' + source_dir)
        for relative, item in tree_files(root, runtime_prefix=runtime_dir).items():
            name = runtime_dir + '/' + relative
            if not contract.code_path(name): continue
            if set(item) != {'sha256'}:
                raise RuntimeError('Candidate code contains a symlink: ' + name)
            inventory[name] = item['sha256']
    for name, file in (('index.js', '.msb/bot/index.js'), ('run.mjs', 'overlay/bot/run.mjs'),
                       ('package.json', '.msb/bot/package.json'),
                       ('package-lock.json', '.msb/bot/package-lock.json'),
                       ('OPEN-CORE.md', '.msb/bot/OPEN-CORE.md')):
        inventory[name] = checked_file(source / file)
    return dict(sorted(inventory.items()))


def baseline_from_stage(stage):
    stage = Path(stage)
    code = json.loads((stage / contract.BASELINE_FILES[0]).read_text())
    entries = json.loads((stage / contract.BASELINE_FILES[1]).read_text())
    if set(code) != {'rows', 'skipped'} or code['skipped'] != 0 or len(code['rows']) != 322 or \
       len(entries) != 5:
        raise RuntimeError('Incomplete AG1 baseline evidence')
    rows = code['rows'] + entries
    result = {}
    for row in rows:
        name = row['relative']
        if name in result or len(row['sha256']) != 64 or len(row['blob']) != 40 or \
           not isinstance(row['mode'], int) or row['mode'] & ~0o777:
            raise RuntimeError('Malformed AG1 baseline inventory')
        result[name] = {'sha256': row['sha256'], 'mode': row['mode'], 'source': row['source']}
    if set(row['relative'] for row in entries) != {'index.js', 'run.mjs', 'package.json',
                                                     'package-lock.json', 'OPEN-CORE.md'}:
        raise RuntimeError('Incomplete AG1 entry inventory')
    for name, (_, before, _) in contract.FILES.items():
        if result.get(name, {}).get('sha256') != before:
            raise RuntimeError('AG1 target evidence mismatch: ' + name)
    for name, value in contract.UNCHANGED.items():
        if result.get(name, {}).get('sha256') != value:
            raise RuntimeError('AG1 dependency evidence mismatch: ' + name)
    return result


def check_live_inventory(root, manifest, *, after):
    root = Path(root)
    expected = {name: item['sha256'] for name, item in manifest['baseline'].items()}
    for name, (_, before, new) in contract.FILES.items():
        if manifest['runtime_inventory'].get(name) != new:
            raise RuntimeError('Candidate target does not match contract: ' + name)
        expected[name] = new if after is True else before
    for name, value in contract.UNCHANGED.items():
        if expected.get(name) != value:
            raise RuntimeError('Candidate dependency does not match AG1: ' + name)
    actual = {}
    uid = pwd.getpwnam(contract.OWNER).pw_uid
    gid = grp.getgrnam(contract.OWNER).gr_gid
    for base in ('src', 'shared', 'ext'):
        directory = root / base
        if not directory.is_dir() or directory.is_symlink():
            raise RuntimeError('Missing live code directory: ' + base)
        for relative, item in tree_files(directory, runtime_prefix=base).items():
            name = base + '/' + relative
            if not contract.code_path(name): continue
            if set(item) != {'sha256'}:
                raise RuntimeError('Live code contains a symlink: ' + name)
            observed, _ = transaction.read_live(root, name)
            if (observed['uid'], observed['gid'], observed['mode']) != \
               (uid, gid, manifest['baseline'].get(name, {}).get('mode')):
                raise RuntimeError('Live scoped code owner or mode changed: ' + name)
            actual[name] = observed['sha256']
    for name in ('index.js', 'run.mjs', 'package.json', 'package-lock.json', 'OPEN-CORE.md'):
        observed, _ = transaction.read_live(root, name)
        if (observed['uid'], observed['gid'], observed['mode']) != \
           (uid, gid, manifest['baseline'].get(name, {}).get('mode')):
            raise RuntimeError('Live entry owner or mode changed: ' + name)
        actual[name] = observed['sha256']
    if after is None:
        for name, (_, before, new) in contract.FILES.items():
            if actual.get(name) in (before, new): expected[name] = actual[name]
    if actual != expected:
        changed = sorted(name for name in set(actual) | set(expected) if actual.get(name) != expected.get(name))
        raise RuntimeError('Live scoped code inventory drift: ' + ', '.join(changed[:20]))


def verify_host():
    if os.geteuid() != 0 or socket.gethostname() != contract.HOST:
        raise RuntimeError('This release requires root on the verified AG1 host')
    result = subprocess.run(['systemctl', 'show', contract.UNIT, '-pUser', '-pActiveState',
                             '-pUnitFileState'], check=True, capture_output=True, text=True, timeout=15)
    fields = dict(row.split('=', 1) for row in result.stdout.splitlines() if '=' in row)
    if fields.get('User') != contract.OWNER or fields.get('UnitFileState') != 'enabled' or \
       fields.get('ActiveState') != 'active':
        raise RuntimeError('Unexpected AG1 service owner or state')


def trusted_stage(stage):
    stage = Path(stage)
    if not stage.is_absolute() or stage.parent != Path('/var/tmp') or stage.is_symlink():
        raise RuntimeError('Stage must be a non-symlinked direct child of /var/tmp')
    for path in (Path('/'), Path('/var'), Path('/var/tmp'), stage):
        st = path.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or \
           (path != Path('/var/tmp') and st.st_mode & 0o022):
            raise RuntimeError('Untrusted stage parent: ' + str(path))
    if not Path('/var/tmp').lstat().st_mode & stat.S_ISVTX:
        raise RuntimeError('/var/tmp must have the sticky bit')
    for base, dirs, files in os.walk(stage, followlinks=False):
        for name in dirs + files:
            path = Path(base) / name
            st = path.lstat()
            if st.st_uid != 0 or (not stat.S_ISLNK(st.st_mode) and st.st_mode & 0o022):
                raise RuntimeError('Stage contains an untrusted entry: ' + str(path))


def validate(stage, expected_sha, *, trust=True):
    stage = Path(stage)
    if trust: trusted_stage(stage)
    manifest_path = stage / 'manifest.json'
    if checked_file(manifest_path) != expected_sha:
        raise RuntimeError('Manifest hash mismatch')
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('host') != contract.HOST or manifest.get('unit') != contract.UNIT or \
       len(manifest.get('source_commit', '')) != 40:
        raise RuntimeError('Unexpected release identity')
    if manifest.get('files') != [
        {'relative': name, 'source': source, 'before_sha256': before, 'after_sha256': after}
        for name, (source, before, after) in contract.FILES.items()
    ]:
        raise RuntimeError('Release targets differ from contract')
    expected_ops = {'contract.py', 'transaction.py', 'stage.py', 'protected.py', 'verify.py', 'deploy.py',
                    'jar1-primitives.py', 'runtime.py'}
    expected_ops.update(contract.BASELINE_FILES)
    expected_ops.update(contract.OPERATOR_TESTS)
    if set(manifest.get('operators', {})) != expected_ops:
        raise RuntimeError('Release operators differ from contract')
    for item in manifest['files']:
        if checked_file(stage / 'payload' / item['relative']) != item['after_sha256']:
            raise RuntimeError('Payload changed: ' + item['relative'])
    for name, expected in manifest['operators'].items():
        if checked_file(stage / name) != expected:
            raise RuntimeError('Operator changed: ' + name)
    source_tree = tree_files(stage / 'source')
    if source_tree != manifest['source_tree']:
        raise RuntimeError('Exported source or tests changed')
    if candidate_inventory(stage / 'source') != manifest['runtime_inventory']:
        raise RuntimeError('Candidate runtime inventory changed')
    if baseline_from_stage(stage) != manifest['baseline']:
        raise RuntimeError('AG1 baseline evidence changed')
    candidate_expected = {name: item['sha256'] for name, item in manifest['baseline'].items()}
    for name, (_, _, after) in contract.FILES.items(): candidate_expected[name] = after
    if candidate_expected != manifest['runtime_inventory']:
        raise RuntimeError('Candidate contains unrelated runtime changes')
    return manifest

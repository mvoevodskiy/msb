"""Release identity, managed file boundaries and read-only comparison."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat

ROOT_FILES = {'puller.cjs', 'sync.cjs', 'bot/index.js', 'bot/run.mjs',
              'bot/package.json', 'bot/package-lock.json', 'bot/OPEN-CORE.md',
              'bot/runtime-profile.json', 'bot/release.json'}
MANAGED_DIRS = ('bot/src', 'bot/ext', 'bot/shared')

def digest(path):
    path = Path(path)
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None

def file_info(path):
    path = Path(path)
    if not path.is_file():
        return None
    return {'sha256': digest(path), 'mode': format(stat.S_IMODE(path.stat().st_mode), '04o')}

def managed(name):
    p = PurePosixPath(name)
    if p.is_absolute() or any(x.startswith('.') or x in ('tests', 'node_modules') for x in p.parts):
        return False
    return name in ROOT_FILES or any(name.startswith(root + '/') for root in MANAGED_DIRS)

def safe_file(root, name):
    if not managed(name):
        raise ValueError(f'Outside release boundary: {name}')
    root, relative = Path(root).resolve(), PurePosixPath(name)
    path = root
    for part in relative.parts:
        path /= part
        if path.is_symlink():
            raise ValueError(f'Symlink in managed path: {name}')
    return path

def inventory(root):
    root = Path(root)
    result = {}
    for name in ROOT_FILES:
        file = safe_file(root, name)
        if file.is_file():
            result[name] = file_info(file)
    for name in MANAGED_DIRS:
        folder = root / name
        if folder.is_symlink():
            raise ValueError(f'Symlinked managed directory: {name}')
        if folder.exists():
            for file in folder.rglob('*'):
                relative = file.relative_to(root).as_posix()
                if not managed(relative):
                    continue
                safe_file(root, relative)
                if file.is_file():
                    result[relative] = file_info(file)
    return dict(sorted(result.items()))

def validate_release(stage):
    stage = Path(stage)
    raw = (stage / 'release.json').read_bytes()
    release = json.loads(raw)
    if release.get('schema') != 1 or release.get('profile') != 'jar1' or not re.fullmatch('[a-f0-9]{40}', release.get('source_commit', '')):
        raise ValueError('Unsupported release metadata')
    for item in release.get('tooling', []):
        name = PurePosixPath(item['target'])
        if name.is_absolute() or '..' in name.parts or (stage / 'ops' / name).is_symlink() or digest(stage / 'ops' / name) != item['sha256']:
            raise ValueError('Operator tooling differs from selected commit')
    expected = {}
    for item in release['files']:
        name = item['target']
        if name in expected or name == 'bot/release.json' or item['mode'] not in ('0644', '0755'):
            raise ValueError('Duplicate or invalid release entry')
        file = safe_file(stage / 'runtime', name)
        if file_info(file) != {k: item[k] for k in ['sha256', 'mode']} or file.stat().st_size != item['size']:
            raise ValueError(f'Artifact drift: {name}')
        expected[name] = {k: item[k] for k in ['sha256', 'mode']}
    if not ROOT_FILES - {'bot/release.json'} <= expected.keys():
        raise ValueError('Required runtime entry missing')
    if (stage / 'runtime/bot/release.json').read_bytes() != raw:
        raise ValueError('Embedded release identity differs')
    expected['bot/release.json'] = {'sha256': hashlib.sha256(raw).hexdigest(), 'mode': '0644'}
    if inventory(stage / 'runtime') != dict(sorted(expected.items())):
        raise ValueError('Runtime artifact inventory mismatch')
    # Also reject files outside the managed area; a secret must not travel in runtime/.
    for file in (stage / 'runtime').rglob('*'):
        if file.is_file() and file.relative_to(stage / 'runtime').as_posix() not in expected:
            raise ValueError('Unmanaged file in runtime artifact')
    return release, expected

def plan(stage, live):
    release, expected = validate_release(stage)
    before = inventory(live)
    for name in expected:
        file = safe_file(live, name)
        if file.exists() and not file.is_file():
            raise ValueError('Runtime file would replace a directory')
    return {'schema': 1, 'source_commit': release['source_commit'],
            'release_sha256': digest(Path(stage) / 'release.json'),
            'before': before, 'after': expected,
            'changes': [name for name, value in expected.items() if before.get(name) != value],
            'removals': sorted(set(before) - set(expected))}

def verify_plan(stage, live, value):
    release, expected = validate_release(stage)
    if value['release_sha256'] != digest(Path(stage) / 'release.json') or value['source_commit'] != release['source_commit'] or value['after'] != expected:
        raise ValueError('Plan does not describe this artifact')
    if value['before'] != inventory(live):
        raise ValueError('Live code changed after the reviewed plan')
    return release


def validate_test_snapshot(stage, release):
    stage = Path(stage)
    index = stage / 'checks/source-inventory.json'
    if digest(index) != release.get('checks_sha256'):
        raise ValueError('Test inventory differs from the selected commit')
    root = stage / 'checks/source'
    expected = {}
    for entry in json.loads(index.read_text()):
        name = PurePosixPath(entry['source'])
        if name.is_absolute() or '..' in name.parts or str(name) in expected:
            raise ValueError('Invalid test source path')
        file = root / name
        if 'symlink' in entry:
            if not file.is_symlink() or file.readlink().as_posix() != entry['symlink'] or not file.resolve().is_relative_to(root.resolve()):
                raise ValueError('Test source symlink drift')
        else:
            if file.is_symlink() or file_info(file) != {k: entry[k] for k in ['sha256', 'mode']}:
                raise ValueError('Test source drift: ' + str(name))
        expected[str(name)] = entry
    actual = set()
    for file in root.rglob('*'):
        name = file.relative_to(root).as_posix()
        if 'node_modules' in file.relative_to(root).parts:
            continue
        if file.is_file() or file.is_symlink():
            actual.add(name)
    if actual != set(expected):
        raise ValueError('Extra or missing files in the test snapshot')
    return len(expected)

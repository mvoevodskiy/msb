"""Code-only backup, atomic installation and rollback; never restore user profiles."""
import json
import os
from pathlib import Path
import shutil
import stat
import uuid
from manifest import digest, file_info, inventory, safe_file, validate_release

def atomic_copy(source, target, uid, gid, mode):
    target = Path(target)
    missing = []
    parent = target.parent
    while not parent.exists():
        missing.append(parent)
        parent = parent.parent
    for directory in reversed(missing):
        directory.mkdir(mode=0o755)
        os.chown(directory, uid, gid)
    temporary = target.with_name(target.name + '.release-' + uuid.uuid4().hex)
    try:
        with open(source, 'rb') as src, open(temporary, 'xb') as dst:
            shutil.copyfileobj(src, dst)
            dst.flush()
            os.fsync(dst.fileno())
        os.chown(temporary, uid, gid)
        temporary.chmod(mode)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)

def backup_code(live, backup, plan):
    live, backup = Path(live), Path(backup)
    backup.mkdir(parents=True, mode=0o700, exist_ok=False)
    ownership = {}
    for name, expected in plan['before'].items():
        source = safe_file(live, name)
        if file_info(source) != expected:
            raise ValueError(f'Live drift while taking backup: {name}')
        info = source.stat()
        ownership[name] = [info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)]
        target = backup / 'code' / name
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copyfile(source, target)
        target.chmod(0o600)
    (backup / 'plan.json').write_text(json.dumps({'plan': plan, 'ownership': ownership}, indent=2) + '\n')
    (backup / 'plan.json').chmod(0o600)
    return ownership

def install_code(stage, live, plan, ownership, uid, gid):
    stage, live = Path(stage), Path(live)
    release, expected = validate_release(stage)
    modes = {item['target']: int(item['mode'], 8) for item in release['files']}
    modes['bot/release.json'] = 0o644
    for name in plan['changes']:
        source, target = stage / 'runtime' / name, safe_file(live, name)
        if file_info(target) != plan['before'].get(name) or file_info(source) != expected[name]:
            raise ValueError(f'Code drift during install: {name}')
        owner = ownership.get(name, [uid, gid, modes[name]])
        atomic_copy(source, target, owner[0], owner[1], modes[name])
    for name in plan['removals']:
        target = safe_file(live, name)
        if file_info(target) != plan['before'][name]:
            raise ValueError(f'Obsolete code drift: {name}')
        target.unlink()
    if inventory(live) != expected:
        raise ValueError('Installed inventory differs from artifact')

def validate_backup(live, backup):
    live, backup = Path(live), Path(backup)
    record = json.loads((backup / 'plan.json').read_text())
    plan, ownership = record['plan'], record['ownership']
    if set(ownership) != set(plan['before']):
        raise ValueError('Incomplete backup ownership')
    for name in set(plan['before']) | set(plan['after']):
        safe_file(live, name)
    for name, expected in plan['before'].items():
        source = backup / 'code' / name
        if source.is_symlink() or digest(source) != expected['sha256']:
            raise ValueError(f'Backup corrupt: {name}')
        owner = ownership[name]
        if len(owner) != 3 or any(not isinstance(x, int) or x < 0 for x in owner) or owner[2] > 0o7777:
            raise ValueError('Invalid backup ownership')
        if format(owner[2], '04o') != expected['mode']:
            raise ValueError('Backup mode differs from plan')
    return record


def restore_code(live, backup):
    live, backup = Path(live), Path(backup)
    # Validate every backup before deleting or overwriting even one live byte.
    record = validate_backup(live, backup)
    plan, ownership = record['plan'], record['ownership']
    for name in set(plan['after']) - set(plan['before']):
        safe_file(live, name).unlink(missing_ok=True)
    for name in plan['before']:
        uid, gid, mode = ownership[name]
        atomic_copy(backup / 'code' / name, safe_file(live, name), uid, gid, mode)
    if inventory(live) != plan['before']:
        raise ValueError('Rollback inventory differs from original code')

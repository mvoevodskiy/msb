"""Code-only, journalled per-file exchange using the JAR1 audit primitives.

The caller must stop and guard systemd before publish/rollback. A multi-file
exchange is not atomic: the prepared directory and guard are the recovery
journal until all files have been restored or the new process is healthy.
"""

import importlib.util
import hashlib
import json
import os
from pathlib import Path


def load_primitive():
    here = Path(__file__).resolve().parent
    path = here / 'jar1-primitives.py'
    if not path.exists():
        path = here.parent / 'jar1-audit-2026-11-20/deploy.py'
    spec = importlib.util.spec_from_file_location('ag1_release_primitives', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load_primitive()


def write_file(path, data, *, uid=None, gid=None, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        if uid is not None and (os.fstat(fd).st_uid, os.fstat(fd).st_gid) != (uid, gid):
            os.fchown(fd, uid, gid)
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)


def read_live(root, relative):
    parent = P.open_parent(root, relative)
    try:
        name = Path(relative).name
        st = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if st.st_nlink != 1:
            raise RuntimeError('Managed file has unexpected hard links: ' + relative)
        observed, content = P.read_entry(parent, name)
        if (st.st_dev, st.st_ino) != (observed['dev'], observed['ino']):
            raise RuntimeError('Managed file changed while reading: ' + relative)
        return observed, content
    finally:
        os.close(parent)


def prepare(root, stage, backup, rows, *, uid, gid, mode, commit, manifest_sha):
    """Save the old bytes and all prepared new inodes before any exchange."""
    root, stage, backup = Path(root), Path(stage), Path(backup)
    backup.mkdir(mode=0o700, parents=False, exist_ok=False)
    P.sync_dir(backup.parent)
    (backup / 'prepared').mkdir(mode=0o700)
    (backup / 'originals').mkdir(mode=0o700)
    entries = []
    for row in rows:
        relative = row['relative']
        current, content = read_live(root, relative)
        if current['sha256'] != row['before_sha256']:
            raise RuntimeError('Baseline drift before backup: ' + relative)
        if (current['uid'], current['gid'], current['mode']) != (uid, gid, mode):
            raise RuntimeError('Unexpected owner or mode: ' + relative)
        payload = P.safe_file(stage / 'payload', relative).read_bytes()
        if hashlib.sha256(payload).hexdigest() != row['after_sha256']:
            raise RuntimeError('Payload drift before backup: ' + relative)
        key = P.item_key({'root': 'bot', 'relative': relative})
        original = backup / 'originals' / key
        staged = backup / 'prepared' / key
        write_file(original, content)
        write_file(staged, payload, uid=uid, gid=gid, mode=mode)
        fd = P.open_directory(staged.parent)
        try:
            candidate, _ = P.read_entry(fd, staged.name)
        finally:
            os.close(fd)
        if candidate['sha256'] != row['after_sha256'] or \
           (candidate['uid'], candidate['gid'], candidate['mode']) != (uid, gid, mode):
            raise RuntimeError('Prepared candidate does not match payload')
        if candidate['dev'] != current['dev']:
            raise RuntimeError('Prepared files and live code are on different filesystems')
        entries.append({**row, 'key': key,
                        'owner': {k: current[k] for k in ('sha256', 'uid', 'gid', 'mode')},
                        'before_identity': {k: current[k] for k in ('dev', 'ino')},
                        'after_identity': {k: candidate[k] for k in ('dev', 'ino')}})
    record = {'source_commit': commit, 'manifest_sha256': manifest_sha, 'files': entries}
    write_file(backup / 'metadata.json', (json.dumps(record, sort_keys=True) + '\n').encode())
    for directory in (backup / 'originals', backup / 'prepared', backup):
        P.sync_dir(directory)
    return record


def publish(root, stage, backup, record):
    """Publish each file under a pre-existing service startup guard."""
    for item in record['files']:
        payload = P.safe_file(Path(stage) / 'payload', item['relative']).read_bytes()
        P.atomic_write(root, item['relative'], payload, item['owner'], create=False,
                       prepared=Path(backup) / 'prepared' / item['key'],
                       before_identity=item['before_identity'], after_identity=item['after_identity'])


def rollback(root, backup, record):
    """Idempotently undo zero, some, or all completed exchanges."""
    for item in reversed(record['files']):
        P.restore_existing(root, item['relative'], Path(backup) / 'prepared' / item['key'],
                           item['owner'], item['before_identity'], item['after_identity'],
                           item['after_sha256'])


def verify_state(root, rows, *, after):
    for row in rows:
        observed, _ = read_live(root, row['relative'])
        key = 'after_sha256' if after else 'before_sha256'
        if observed['sha256'] != row[key]:
            raise RuntimeError('Live code drift: ' + row['relative'])

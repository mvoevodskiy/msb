"""Compare protected data in memory; never copy or print its contents or hashes."""

import hashlib
import os
from pathlib import Path
import stat

HOME = Path('/home/client')
DATABASES = ('.codex/state_5.sqlite', '.codex/thread_history_1.sqlite',
             '.codex/goals_1.sqlite', '.codex/memories_1.sqlite')
FILES = (
    '.msb/.env', '.msb/bots/default/.env', '.codex/auth.json', '.codex/config.toml',
    '.codex/history.jsonl', '.claude/.credentials.json', '.claude.json',
    'workspace/SOUL.md', 'workspace/USER.md', 'workspace/MEMORY.md', 'workspace/MISSION.md',
    'workspace/GOALS.md', 'workspace/PROJECTS.md', 'workspace/PREFERENCES.md',
    'workspace/LEARNED.md', 'workspace/AGENTS.md', 'workspace/CLAUDE.md',
    'workspace/.iia-bootstrapped',
) + tuple(name + suffix for name in DATABASES for suffix in ('', '-wal', '-shm', '-journal'))
DIRECTORIES = ('.msb/bots/default', '.msb/autonomy', '.msb/monitor',
               '.codex/sessions', '.claude/projects', 'workspace/memory')
PROFILE_LINK = '.msb/bots/default/projects/CLAUDE.md'
PROFILE_LINK_TARGET = '.msb/bots/default/cwd/CLAUDE.md'


def is_transient(path, home=HOME):
    try:
        relative = Path(path).relative_to(home)
    except ValueError:
        return False
    if relative.parts[:3] != ('.msb', 'bots', 'default'):
        return False
    name = relative.name
    # The lock file is only a synchronization sidecar. Its WAL/journal, if any,
    # is NOT skipped: potentially durable user data must remain protected.
    return name == '.heartbeat-ok' or name.endswith('.lock.sqlite')


def fingerprint(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode): raise RuntimeError('Protected data is not a regular file')
        value = hashlib.sha256()
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk: break
            value.update(chunk)
        after = os.fstat(fd)
        keys = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_uid', 'st_gid', 'st_mode')
        if any(getattr(before, key) != getattr(after, key) for key in keys):
            raise RuntimeError('Protected data changed during the check')
        return (value.digest(), after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode))
    finally:
        os.close(fd)


def snapshot(home=HOME):
    """Return opaque in-memory state; callers must never serialize this map."""
    home = Path(home)
    result = {}
    for relative in FILES:
        path = home / relative
        if not os.path.lexists(path):
            result[relative] = None
        elif path.is_symlink():
            raise RuntimeError('Unexpected symlink in protected data')
        else:
            result[relative] = fingerprint(path)
    for relative in DIRECTORIES:
        root = home / relative
        if not os.path.lexists(root):
            result[relative + '/'] = None
            continue
        if root.is_symlink() or not root.is_dir():
            raise RuntimeError('Unexpected protected data directory')
        result[relative + '/'] = True
        for base, dirs, files in os.walk(root, followlinks=False):
            dirs.sort(); files.sort()
            for name in dirs:
                if (Path(base) / name).is_symlink():
                    raise RuntimeError('Unexpected protected data directory symlink')
            for name in files:
                path = Path(base) / name
                if is_transient(path, home): continue
                key = path.relative_to(home).as_posix()
                if path.is_symlink():
                    target = home / PROFILE_LINK_TARGET
                    if key != PROFILE_LINK or os.readlink(path) != str(target) or \
                       target.parent.is_symlink() or target.is_symlink() or not target.is_file():
                        raise RuntimeError('Unexpected protected data symlink')
                    st = path.lstat()
                    result[key] = ('symlink', os.readlink(path), st.st_uid, st.st_gid, fingerprint(target))
                    continue
                result[key] = fingerprint(path)
    return result

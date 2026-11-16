#!/usr/bin/env python3
"""Maintain only known workspace→bot cwd fstab entries.

Callers: bootstrap/install.sh and both bot-ctl.sh copies. Accepts old
bind,nofail and the newer short-timeout form; tests: bootstrap/tests/test_fstab_compat.py.
"""
import argparse
import fcntl
import os
from pathlib import Path
import stat
import tempfile

OLD_OPTIONS = frozenset((b'bind', b'nofail'))
NEW_OPTIONS = OLD_OPTIONS | {b'x-systemd.device-timeout=1s'}
NEW_OPTIONS_TEXT = b'bind,nofail,x-systemd.device-timeout=1s'


def field(path):
    value = os.fsencode(path)
    return (value.replace(b'\\', b'\\134').replace(b' ', b'\\040')
            .replace(b'\t', b'\\011').replace(b'\n', b'\\012'))


def fields(line):
    text = line.lstrip(b' \t')
    if not text or text.startswith(b'#'):
        return []
    return text.split()


def known(parts, source, target):
    if len(parts) < 6 or (len(parts) > 6 and not parts[6].startswith(b'#')):
        return False
    options = parts[3].split(b',')
    return (parts[0] == source and parts[1] == target and parts[2] == b'none'
            and len(options) == len(set(options)) and frozenset(options) in (OLD_OPTIONS, NEW_OPTIONS)
            and parts[4:6] == [b'0', b'0'])


def extended_attributes(fd):
    # Linux preserves ACL and security labels as extended attributes. A host
    # without xattr support has none to copy; errors on a supporting host fail.
    if not hasattr(os, 'listxattr'):
        return {}
    return {name: os.getxattr(fd, name) for name in os.listxattr(fd)}


def read_fstab(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            raise RuntimeError('fstab is not a regular file')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read()
        after = os.fstat(fd)
        identity = lambda st: (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
        if identity(before) != identity(after):
            raise RuntimeError('fstab changed while reading')
        return data, before, extended_attributes(fd)
    finally:
        os.close(fd)


def replace_fstab(path, data, before, attributes):
    fd, temporary = tempfile.mkstemp(prefix='.msb-fstab-', dir=path.parent)
    try:
        st = os.fstat(fd)
        if (st.st_uid, st.st_gid) != (before.st_uid, before.st_gid):
            os.fchown(fd, before.st_uid, before.st_gid)
        os.fchmod(fd, stat.S_IMODE(before.st_mode))
        if hasattr(os, 'listxattr'):
            for name in set(os.listxattr(fd)) - set(attributes):
                os.removexattr(fd, name)
            for name, value in attributes.items():
                os.setxattr(fd, name, value)
            if extended_attributes(fd) != attributes or stat.S_IMODE(os.fstat(fd).st_mode) != stat.S_IMODE(before.st_mode):
                raise RuntimeError('fstab metadata could not be preserved')
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        now = path.stat(follow_symlinks=False)
        identity = lambda st: (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
        if not stat.S_ISREG(now.st_mode) or identity(now) != identity(before):
            raise RuntimeError('fstab changed before publication')
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        os.close(fd)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def update(action, path, source, target):
    path = Path(path)
    source, target = field(source), field(target)
    lock = os.open(str(path) + '.msb.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(lock).st_mode):
            raise RuntimeError('fstab lock is not a regular file')
        fcntl.flock(lock, fcntl.LOCK_EX)
        data, before, attributes = read_fstab(path)
        lines = data.splitlines(keepends=True)
        entries = [(line, fields(line)) for line in lines]
        matches = [known(parts, source, target) for _line, parts in entries]
        if any(len(parts) >= 2 and parts[1] == target and not matched
               for (_line, parts), matched in zip(entries, matches)):
            raise RuntimeError('fstab target already has an unrecognised entry')
        if action == 'check':
            return 'existing' if any(matches) else 'absent'
        if action == 'ensure':
            if any(matches):
                return 'existing'
            separator = b'' if not data or data.endswith(b'\n') else b'\n'
            line = source + b'  ' + target + b'  none  ' + NEW_OPTIONS_TEXT + b'  0  0\n'
            replace_fstab(path, data + separator + line, before, attributes)
            return 'added'
        if not any(matches):
            return 'absent'
        replace_fstab(path, b''.join(line for (line, _parts), matched in zip(entries, matches) if not matched), before, attributes)
        return 'removed'
    finally:
        os.close(lock)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('check', 'ensure', 'remove'))
    parser.add_argument('fstab')
    parser.add_argument('source')
    parser.add_argument('target')
    args = parser.parse_args()
    try:
        print(update(args.action, args.fstab, args.source, args.target))
    except (OSError, RuntimeError) as error:
        parser.exit(1, 'msb-fstab: ' + str(error) + '\n')


if __name__ == '__main__':
    main()

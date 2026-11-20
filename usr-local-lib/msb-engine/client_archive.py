#!/usr/bin/env python3
"""List/restore a client's deletion trash into its archive, never a live profile.

Runs as client via archive_service.py; root never traverses these contents.
No-replace rename and no-follow directory descriptors live in client_fs.py.
The caller must not concurrently move archive/.trash from another process;
observed directory replacements fail, but the entire merge is not atomic.
Checks: tests/test_archive_restore.py.
"""
import calendar
from datetime import datetime, timezone
import errno
import json
import os
import re
import stat
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from client_fs import open_dir, rename_noreplace  # noqa: E402

ARCHIVE_RE = re.compile(r'(jarvis|openclaw)-([0-9]{8}T[0-9]{6}Z)')
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


class NothingToRestore(Exception):
    pass


def _trash_fd(root):
    try:
        archive = open_dir(os.path.join(root, 'archive'))
    except FileNotFoundError:
        return None, None
    try:
        try:
            trash = os.open('.trash', DIR_FLAGS, dir_fd=archive)
        except FileNotFoundError:
            os.close(archive)
            return None, None
        return archive, trash
    except BaseException:
        os.close(archive)
        raise


def list_trash(root):
    archive, trash = _trash_fd(root)
    if trash is None:
        return []
    try:
        result = []
        for name in os.listdir(trash):
            match = ARCHIVE_RE.fullmatch(name)
            if not match:
                continue
            try:
                st = os.stat(name, dir_fd=trash, follow_symlinks=False)
                stamp = datetime.strptime(match[2], '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc)
            except (OSError, ValueError):
                continue
            if stat.S_ISDIR(st.st_mode):
                result.append((calendar.timegm(stamp.utctimetuple()), name))
        result.sort(reverse=True)
        # Owner chose manual retention, so no 24-hour automatic expiry is claimed.
        return [{'archive': name, 'erase_after': None} for _, name in result[:16]]
    finally:
        os.close(trash)
        os.close(archive)


def _held_dir(parent, name, observed):
    fd = os.open(name, DIR_FLAGS, dir_fd=parent)
    try:
        actual = os.fstat(fd)
        if (actual.st_dev, actual.st_ino) != (observed.st_dev, observed.st_ino):
            raise OSError(errno.ESTALE, 'archive entry changed')
        return fd
    except BaseException:
        os.close(fd)
        raise


def _verify_entry(parent, name, held):
    try:
        named = os.stat(name, dir_fd=parent, follow_symlinks=False)
        opened = os.fstat(held)
    except OSError as e:
        raise OSError(errno.ESTALE, 'archive directory moved') from e
    if not stat.S_ISDIR(named.st_mode) or (named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino):
        raise OSError(errno.ESTALE, 'archive directory moved')


def _merge(source, destination):
    moved = 0
    for name in sorted(os.listdir(source)):
        src = os.stat(name, dir_fd=source, follow_symlinks=False)
        try:
            dst = os.stat(name, dir_fd=destination, follow_symlinks=False)
        except FileNotFoundError:
            dst = None
        if stat.S_ISDIR(src.st_mode) and dst is not None and stat.S_ISDIR(dst.st_mode):
            src_fd = _held_dir(source, name, src)
            try:
                dst_fd = _held_dir(destination, name, dst)
                try:
                    moved += _merge(src_fd, dst_fd)
                    _verify_entry(destination, name, dst_fd)
                    _verify_entry(source, name, src_fd)
                finally:
                    os.close(dst_fd)
            finally:
                os.close(src_fd)
            os.rmdir(name, dir_fd=source)
            continue
        target = name
        while True:
            try:
                rename_noreplace(source, name, destination, target)
                moved += 1
                break
            except FileExistsError:
                target += '.restored'
    return moved


def restore(root, name):
    if not isinstance(name, str) or not ARCHIVE_RE.fullmatch(name):
        raise ValueError('invalid archive name')
    archive, trash = _trash_fd(root)
    if trash is None:
        raise NothingToRestore()
    try:
        try:
            src = os.open(name, DIR_FLAGS, dir_fd=trash)
        except OSError as e:
            if e.errno not in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
                raise
            raise NothingToRestore() from e
        try:
            try:
                os.mkdir(name, 0o700, dir_fd=archive)
            except FileExistsError:
                pass
            dest = os.open(name, DIR_FLAGS, dir_fd=archive)
            try:
                count = _merge(src, dest)
                _verify_entry(archive, name, dest)
                _verify_entry(trash, name, src)
                _verify_entry(archive, '.trash', trash)
                current = open_dir(os.path.join(root, 'archive'))
                try:
                    actual, held = os.fstat(current), os.fstat(archive)
                    if (actual.st_dev, actual.st_ino) != (held.st_dev, held.st_ino):
                        raise OSError(errno.ESTALE, 'archive root moved')
                finally:
                    os.close(current)
            finally:
                os.close(dest)
        finally:
            os.close(src)
        os.rmdir(name, dir_fd=trash)
        return {'archive': name, 'restored': count}
    finally:
        os.close(trash)
        os.close(archive)


def main():
    if len(sys.argv) not in (3, 4):
        return 2
    try:
        if sys.argv[1] == 'list' and len(sys.argv) == 3:
            value = list_trash(sys.argv[2])
        elif sys.argv[1] == 'restore' and len(sys.argv) == 4:
            value = restore(sys.argv[2], sys.argv[3])
        else:
            return 2
        print(json.dumps(value, separators=(',', ':')))
        return 0
    except NothingToRestore:
        print('NOTHING_TO_RESTORE', file=sys.stderr)
        return 3
    except (OSError, ValueError, RecursionError):
        print('ARCHIVE_FAILED', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""Write/remove one bot sleep marker *as the client*, never as root.

Called by util.as_client_touch; input arrives on stdin. No shell or secret is
passed in arguments. SQLite transaction coordinates with the bot's
.msb/bot/src/engines/sleep.mjs. Regression: tests/test_client_markers.py and
.msb/bot/tests/engine-sleep.test.mjs.
"""
import os
import re
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from client_fs import open_dir  # noqa: E402


class StaleMarker(Exception):
    pass


def change(path, data, expected=None):
    directory, name = os.path.split(path)
    if not re.fullmatch(r'sleep\.[a-zA-Z0-9_-]{1,32}', name):
        raise ValueError('invalid marker')
    if data is not None:
        os.makedirs(directory, mode=0o700, exist_ok=True)
    try:
        dfd = open_dir(directory)
    except FileNotFoundError:
        if expected is not None:
            raise StaleMarker()
        if data is None:
            return
        raise
    try:
        st = os.fstat(dfd)
        if st.st_uid != os.geteuid() or st.st_mode & 0o022:
            raise PermissionError('untrusted directory')
        lock_path = path + '.lock.sqlite'
        if os.path.islink(lock_path):
            raise PermissionError('untrusted lock')
        db = sqlite3.connect(lock_path, timeout=10, isolation_level=None)
        try:
            os.chmod(lock_path, 0o600)
            db.execute('BEGIN IMMEDIATE')
            try:
                if data is None:
                    if expected is not None:
                        try:
                            st = os.stat(name, dir_fd=dfd, follow_symlinks=False)
                        except FileNotFoundError:
                            raise StaleMarker()
                        current = f'{st.st_dev}:{st.st_ino}:{st.st_ctime_ns}'
                        if current != expected:
                            raise StaleMarker()
                    try:
                        os.unlink(name, dir_fd=dfd)
                    except FileNotFoundError:
                        pass
                    return
                tmp = '.' + name + '.' + os.urandom(8).hex() + '.tmp'
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                             0o600, dir_fd=dfd)
                try:
                    try:
                        view = memoryview(data)
                        while view:
                            count = os.write(fd, view)
                            if count <= 0:
                                raise OSError('short write')
                            view = view[count:]
                        os.fchmod(fd, 0o600)
                    finally:
                        os.close(fd)
                    os.replace(tmp, name, src_dir_fd=dfd, dst_dir_fd=dfd)
                except BaseException:
                    try:
                        os.unlink(tmp, dir_fd=dfd)
                    except OSError:
                        pass
                    raise
            finally:
                db.execute('ROLLBACK')
        finally:
            db.close()
    finally:
        os.close(dfd)


def main():
    if len(sys.argv) not in (3, 4) or sys.argv[2] not in ('write', 'remove', 'compare-remove'):
        return 2
    expected = sys.argv[3] if len(sys.argv) == 4 else None
    if (sys.argv[2] == 'compare-remove') != (expected is not None) or \
            (expected is not None and not re.fullmatch(r'[0-9]{1,20}:[0-9]{1,20}:[0-9]{1,20}', expected)):
        return 2
    data = sys.stdin.buffer.read(4097) if sys.argv[2] == 'write' else None
    if data is not None and len(data) > 4096:
        return 2
    try:
        change(sys.argv[1], data, expected)
    except StaleMarker:
        return 3
    except (OSError, ValueError, sqlite3.Error):
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""Emit only a digest of the dedicated user's config, without following links.

Executed as openclaw by openclaw_profile.py; see test_openclaw_profile.py.
"""
import hashlib
import os
import stat
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from client_fs import open_dir  # noqa: E402


def digest(path):
    directory, name = os.path.split(path)
    if name != 'openclaw.json':
        raise ValueError('config path')
    parent = open_dir(directory)
    try:
        st = os.fstat(parent)
        if st.st_uid != os.geteuid() or st.st_mode & 0o022:
            raise PermissionError('config parent')
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_nlink != 1 or \
                    st.st_mode & 0o022 or st.st_size > 4 * 1024 * 1024:
                raise PermissionError('config file')
            result = hashlib.sha256()
            count = 0
            while True:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                count += len(chunk)
                if count > 4 * 1024 * 1024:
                    raise ValueError('config size')
                result.update(chunk)
            return result.hexdigest()
        finally:
            os.close(fd)
    finally:
        os.close(parent)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('arguments')
        print(digest(sys.argv[1]))
    except (OSError, ValueError):
        sys.exit(1)

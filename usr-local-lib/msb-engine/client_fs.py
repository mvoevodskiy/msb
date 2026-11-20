"""Descriptor-relative filesystem primitives for unprivileged client workers.

Used by client_markers.py and client_archive.py; callers choose policy. Linux
and macOS no-replace rename never silently fall back to replacing a target.
"""
import ctypes
import errno
import os
import sys


def open_dir(path):
    if not os.path.isabs(path):
        raise ValueError('expected absolute path')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open('/', flags)
    try:
        for part in (part for part in path.split('/') if part):
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def rename_noreplace(src_fd, src, dst_fd, dst):
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform.startswith('linux'):
        fn, flags = getattr(libc, 'renameat2', None), 1  # RENAME_NOREPLACE
    elif sys.platform == 'darwin':
        fn, flags = getattr(libc, 'renameatx_np', None), 4  # RENAME_EXCL
    else:
        fn, flags = None, 0
    if fn is None:
        raise OSError(errno.ENOTSUP, 'atomic no-replace rename unavailable')
    fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    fn.restype = ctypes.c_int
    if fn(src_fd, os.fsencode(src), dst_fd, os.fsencode(dst), flags) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))

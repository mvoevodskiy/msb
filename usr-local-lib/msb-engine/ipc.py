"""Consume bounded engine requests; producer and callers are in cli.py/request.mjs.

The request directory belongs to an unprivileged bot. Never open its entries by
following a symbolic link as root. Reference checks: tests/test_ipc_reference.py.
"""
import errno
import fcntl
import json
import os
import re
import stat
import time

from const import (
    ACTIONS,
    ARCHIVE_RE,
    BOT_ID_RE,
    ID_RE,
    RATE_WINDOW,
    REQUEST_KEYS,
    REQUEST_LIMIT,
    REQUEST_MAX,
    REQUEST_NAME,
    REQUIRED_KEYS,
    SEEN_KEEP,
    STATE_DIR,
)
from util import Refused, ensure_root_dir, now, read_small, strict_json, uid_of, write_file


def _open_request_dir(path):
    """Hold the actual directory while refusing symlinks at every path component."""
    if not os.path.isabs(path):
        raise OSError(errno.EINVAL, "request directory must be absolute")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open(os.path.sep, flags)
    try:
        for component in (part for part in path.split(os.path.sep) if part):
            child = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def _discard_claim(directory):
    """Remove a claimed entry; keep a non-empty directory without descending."""
    try:
        os.unlink("claimed", dir_fd=directory)
        return True
    except FileNotFoundError:
        return True
    except OSError as e:
        if e.errno not in (errno.EISDIR, errno.EPERM, errno.EACCES):
            return False
    try:
        os.rmdir("claimed", dir_fd=directory)
        return True
    except OSError:
        return False


def _new_claim_dir(directory):
    """Create and hold a private same-filesystem claim directory."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    for _ in range(3):
        name = ".request.claim." + os.urandom(12).hex()
        try:
            os.mkdir(name, 0o700, dir_fd=directory)
            break
        except FileExistsError:
            continue
    else:
        raise OSError(errno.EEXIST, "no claim directory name available")
    claim = os.open(name, flags, dir_fd=directory)
    try:
        st = os.fstat(claim)
        if st.st_uid != os.geteuid() or st.st_mode & 0o077:
            raise OSError(errno.EACCES, "untrusted claim directory")
    except BaseException:
        os.close(claim)
        raise
    return name, claim


def cleanup_claims(path, expected_uid):
    """Drop abandoned private claims after a crash; caller holds the engine lock.

    A claimed regular request may already have been consumed before the crash:
    do not replay it. Client-owned quarantines and anything unexpected are left
    intact. When the source user is root there is no trustworthy ownership
    distinction, so there is no automatic cleanup.
    """
    if expected_uid is None or expected_uid == os.geteuid():
        return
    try:
        directory = _open_request_dir(path)
    except OSError:
        return
    try:
        dst = os.fstat(directory)
        if dst.st_uid != expected_uid or dst.st_mode & 0o022:
            return
        for name in os.listdir(directory):
            if not re.fullmatch(r"\.request\.claim\.[0-9a-f]{24}", name):
                continue
            try:
                claim = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                dir_fd=directory)
            except OSError:
                continue
            try:
                st = os.fstat(claim)
                if st.st_uid != os.geteuid() or st.st_mode & 0o077:
                    continue
                entries = os.listdir(claim)
                if set(entries) - {"claimed"}:
                    continue
                if "claimed" in entries:
                    item = os.stat("claimed", dir_fd=claim, follow_symlinks=False)
                    if stat.S_ISDIR(item.st_mode):
                        continue
                    os.unlink("claimed", dir_fd=claim)
                here = os.stat(name, dir_fd=directory, follow_symlinks=False)
                if (here.st_dev, here.st_ino) == (st.st_dev, st.st_ino):
                    os.rmdir(name, dir_fd=directory)
            except OSError:
                continue
            finally:
                os.close(claim)
    finally:
        os.close(directory)


def take_request(path, expected_uid, name=REQUEST_NAME, limit=REQUEST_MAX):
    """Atomically claim one slot; never delete a later publication from it."""
    try:
        directory = _open_request_dir(path)
    except FileNotFoundError:
        return None
    except OSError:
        return Refused("BAD_REQUEST", detail={"reason": "REQUEST_DIR"})
    try:
        dst = os.fstat(directory)
        if expected_uid is None or dst.st_uid != expected_uid or dst.st_mode & 0o022:
            return Refused("BAD_REQUEST", detail={"reason": "REQUEST_DIR"})
        try:
            # Avoid creating a claim directory for an empty slot.
            os.stat(name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            return None
        except OSError:
            return Refused("BAD_REQUEST", detail={"reason": "REQUEST_STAT"})
        try:
            claim_name, claim = _new_claim_dir(directory)
        except OSError:
            return Refused("BAD_REQUEST", detail={"reason": "REQUEST_CLAIM_DIR"})
        preserve = False

        def quarantine(reason):
            # Invalid directories and other unremovable entries are never
            # recursively removed. Hand the private container to its owner.
            try:
                os.fchown(claim, dst.st_uid, dst.st_gid)
                return Refused("BAD_REQUEST", detail={"reason": reason, "quarantine": claim_name})
            except OSError:
                return Refused("BAD_REQUEST", detail={"reason": "REQUEST_QUARANTINE_OWNER",
                                                       "original_reason": reason,
                                                       "quarantine": claim_name})

        try:
            # Claim the actual name, not an inode checked earlier. Another writer
            # can publish a new request immediately after this rename.
            try:
                os.rename(name, "claimed", src_dir_fd=directory, dst_dir_fd=claim)
            except FileNotFoundError:
                return None
            except OSError:
                return Refused("BAD_REQUEST", detail={"reason": "REQUEST_CLAIM"})
            try:
                fd = os.open(
                    "claimed",
                    os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_NOCTTY | os.O_CLOEXEC,
                    dir_fd=claim,
                )
            except OSError:
                preserve = not _discard_claim(claim)
                if preserve:
                    return quarantine("REQUEST_NOT_FILE")
                return Refused("BAD_REQUEST", detail={"reason": "REQUEST_NOT_FILE"})
            try:
                preserve = not _discard_claim(claim)
                if preserve:
                    return quarantine("REQUEST_REMOVE")
                st = os.fstat(fd)
                # The bot publishes with link(tmp, request), then removes tmp.
                # Retain the previous 0.5 s allowance for the temporary link.
                for _ in range(10):
                    if st.st_nlink == 0:
                        break
                    time.sleep(0.05)
                    st = os.fstat(fd)
                if not stat.S_ISREG(st.st_mode):
                    return Refused("BAD_REQUEST", detail={"reason": "REQUEST_NOT_FILE"})
                if st.st_uid != expected_uid:
                    return Refused("BAD_REQUEST", detail={"reason": "REQUEST_FOREIGN_OWNER"})
                if st.st_nlink:
                    return Refused("BAD_REQUEST", detail={"reason": "REQUEST_LINKED"})
                data = bytearray()
                while len(data) <= limit:
                    chunk = os.read(fd, limit + 1 - len(data))
                    if not chunk:
                        break
                    data.extend(chunk)
                if len(data) > limit:
                    return Refused("BAD_REQUEST", detail={"reason": "REQUEST_SIZE"})
                return bytes(data)
            except OSError:
                return Refused("BAD_REQUEST", detail={"reason": "REQUEST_READ"})
            finally:
                os.close(fd)
        finally:
            if not preserve:
                # Never recursively remove anything if the name was replaced.
                try:
                    here = os.stat(claim_name, dir_fd=directory, follow_symlinks=False)
                    held = os.fstat(claim)
                    if (here.st_dev, here.st_ino) == (held.st_dev, held.st_ino):
                        os.rmdir(claim_name, dir_fd=directory)
                except OSError:
                    pass
            os.close(claim)
    finally:
        os.close(directory)


def parse_request(data):
    obj = strict_json(data, "BAD_REQUEST")
    if not isinstance(obj, dict):
        raise Refused("BAD_REQUEST")
    rid = obj.get("id")
    rid = rid if isinstance(rid, str) and ID_RE.fullmatch(rid) else None

    def bad(code, reason, detail=None):
        e = Refused(code, detail=dict({"reason": reason}, **(detail or {})))
        e.request_id = rid
        return e

    if obj.get("v") != 1 or isinstance(obj.get("v"), bool):
        raise bad("BAD_REQUEST", "VERSION")
    if rid is None:
        raise bad("BAD_REQUEST", "ID")
    action = obj.get("action")
    if action not in ACTIONS:
        raise bad("BAD_REQUEST", "UNKNOWN_ACTION")
    params = {k: v for k, v in obj.items() if k not in ("v", "id", "action")}
    if not set(params) <= set(REQUEST_KEYS[action]) or not set(
        REQUIRED_KEYS.get(action, ())
    ) <= set(params):
        raise bad("BAD_REQUEST", "KEYS")
    out = {}
    if "archive" in params:
        archive = params["archive"]
        if not isinstance(archive, str) or not ARCHIVE_RE.fullmatch(archive):
            raise bad("BAD_REQUEST", "ARCHIVE")
        out["archive"] = archive
    if "bot_id" in params:
        bid = params["bot_id"]
        if not isinstance(bid, str) or not BOT_ID_RE.fullmatch(bid):
            raise bad("BAD_REQUEST", "BOT_ID")
        out["bot_id"] = bid
    if "sleep_revision" in params:
        revision = params["sleep_revision"]
        if 'bot_id' not in out or not isinstance(revision, str) or not re.fullmatch(
                r'[0-9]{1,20}:[0-9]{1,20}:[0-9]{1,20}', revision):
            raise bad("BAD_REQUEST", "SLEEP_REVISION")
        out['sleep_revision'] = revision
    return {"id": rid, "action": action, "params": out}


def load_memory():
    raw = read_small(os.path.join(STATE_DIR, "requests.json"), 1 << 20)
    try:
        mem = json.loads(raw.decode()) if raw else {}
    except Exception:
        mem = {}
    return mem if isinstance(mem, dict) else {}


def save_memory(mem):
    ensure_root_dir(STATE_DIR, 0o700)
    write_file(
        os.path.join(STATE_DIR, "requests.json"),
        (json.dumps(mem, sort_keys=True) + "\n").encode(),
        0o600,
    )


def spend(source, rid, action):
    """RATE_LIMITED / REPLAY или None."""
    mem = load_memory()
    src = mem.setdefault(source, {"seen": [], "times": []})
    seen = [x for x in src.get("seen", []) if isinstance(x, str)]
    if rid in seen:
        return "REPLAY"
    t = now()
    times = [x for x in src.get("times", []) if isinstance(x, int) and t - x < RATE_WINDOW]
    if len(times) >= REQUEST_LIMIT:
        return "RATE_LIMITED"
    times.append(t)
    seen.append(rid)
    src["times"] = times[-REQUEST_LIMIT * 2 :]
    src["seen"] = seen[-SEEN_KEEP:]
    mem[source] = src
    save_memory(mem)
    return None


def locked(wait=True):
    from const import RUN_DIR

    ensure_root_dir(RUN_DIR, 0o755)
    fd = os.open(
        os.path.join(RUN_DIR, "lock"),
        os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600,
    )
    try:
        fcntl.flock(fd, fcntl.LOCK_EX if wait else fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        return None
    return fd

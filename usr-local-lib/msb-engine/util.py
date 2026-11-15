import json
import os
import pwd
import shutil
import stat
import subprocess
import sys
import time


class Refused(Exception):
    def __init__(self, code, result="refused", detail=None):
        super().__init__(code)
        self.code = code
        self.result = result
        self.detail = detail or {}
        self.request_id = None


def need_root():
    if os.geteuid() != 0:
        raise SystemExit("msb-engine: нужен root")


def now():
    return int(time.time())


def iso(t=None):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t if t is not None else now()))


def uid_of(name):
    try:
        return pwd.getpwnam(name).pw_uid
    except KeyError:
        return None


def gid_of(name):
    try:
        return pwd.getpwnam(name).pw_gid
    except KeyError:
        return None


def ensure_root_dir(path, mode):
    """Create/check the private system directory without following its final link."""
    os.makedirs(path, mode=mode, exist_ok=True)
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid():
            raise Refused("ROOT_DIR", "failed")
        if stat.S_IMODE(st.st_mode) != mode:
            os.fchmod(fd, mode)
    finally:
        os.close(fd)


def write_file(path, data, mode=0o600):
    """Replace a file atomically without changing its already-prepared parent."""
    if isinstance(data, str):
        data = data.encode()
    directory = os.path.dirname(path) or "."
    tmp = path + "." + os.urandom(8).hex() + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
    try:
        try:
            remaining = memoryview(data)
            while remaining:
                written = os.write(fd, remaining)
                if written <= 0:
                    raise OSError("short write")
                remaining = remaining[written:]
            os.fchmod(fd, mode)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    try:
        parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    except OSError as e:
        # replace already committed the visible file: report durability trouble
        # but let its caller finish the matching operation, not a false rollback.
        log(f"write_file: published, directory fsync failed errno={e.errno}")


def read_small(path, limit=4096):
    try:
        with open(path, "rb") as f:
            return f.read(limit + 1)
    except OSError:
        return None


def systemctl_word(*args, timeout=60):
    try:
        p = subprocess.run(
            ["systemctl", *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return (p.stdout or "").strip().split("\n")[0] if p.stdout else ""
    except Exception:
        return ""


def systemctl_ok(*args, timeout=60):
    try:
        p = subprocess.run(
            ["systemctl", *args],
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        return p.returncode == 0
    except Exception:
        return False


def strict_json(data, code):
    if not isinstance(data, (bytes, bytearray)):
        raise Refused(code)
    if len(data) > 1 << 20:
        raise Refused(code)

    def reject_duplicates(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise Refused(code)
            result[key] = value
        return result

    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=reject_duplicates)
    except Refused:
        raise
    except Exception:
        raise Refused(code)


def as_client_touch(path, content=b""):
    """Change a sleep marker after dropping to client UID/GID, never as root."""
    uid, gid = uid_of("client"), gid_of("client")
    if uid is None or gid is None:
        raise Refused("HOST_NOT_READY", detail={"reason": "NO_CLIENT"})
    try:
        result = subprocess.run(
            [sys.executable, '-IS', os.path.join(os.path.dirname(__file__), 'client_markers.py'),
             path, 'remove' if content is None else 'write'],
            input=content if content is not None else b'', capture_output=True,
            user=uid, group=gid, extra_groups=(), timeout=30, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        raise Refused("FAILED", "failed", {"reason": "CLIENT_STEP"}) from e
    if result.returncode:
        raise Refused("FAILED", "failed", {"reason": "CLIENT_STEP"})


def disk():
    st = os.statvfs("/")
    return {
        "free_bytes": st.f_bavail * st.f_frsize,
        "total_bytes": st.f_blocks * st.f_frsize,
    }


def gb(n):
    return round(n / (1024 ** 3), 2) if n is not None else None


def mem_total_mb():
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) // 1024
    except OSError:
        return None
    return None


def cc_cli_version():
    for path in ("/usr/bin/claude", shutil.which("claude") or ""):
        if not path or not os.path.isfile(path):
            continue
        try:
            p = subprocess.run(
                [path, "--version"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            line = (p.stdout or p.stderr or "").strip().split("\n")[0]
            return line[:80] if line else None
        except Exception:
            continue
    return None


def log(msg):
    print(f"MSB_ENGINE {msg}", file=sys.stderr)

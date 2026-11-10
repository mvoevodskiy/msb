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
    os.makedirs(path, mode=mode, exist_ok=True)
    os.chmod(path, mode)


def write_file(path, data, mode=0o600):
    if isinstance(data, str):
        data = data.encode()
    d = os.path.dirname(path)
    if d:
        ensure_root_dir(d, 0o755)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_CLOEXEC, mode)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


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
    try:
        return json.loads(data.decode("utf-8"))
    except Exception:
        raise Refused(code)


def as_client_touch(path, content=b""):
    """Создать файл от имени client (или удалить, если content is None)."""
    uid, gid = uid_of("client"), gid_of("client")
    if uid is None:
        raise Refused("HOST_NOT_READY", detail={"reason": "NO_CLIENT"})
    if content is None:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        return
    d = os.path.dirname(path)
    os.makedirs(d, mode=0o700, exist_ok=True)
    try:
        os.chown(d, uid, gid)
    except OSError:
        pass
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_CLOEXEC, 0o600)
    try:
        if content:
            os.write(fd, content)
    finally:
        os.close(fd)
    os.chown(path, uid, gid)
    os.chmod(path, 0o600)


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

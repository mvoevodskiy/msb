import fcntl
import json
import os
import stat

from const import (
    ACTIONS,
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


def take_request(path, expected_uid, name=REQUEST_NAME, limit=REQUEST_MAX):
    """Атомарно забрать request: прочитать и удалить. None если нет файла."""
    req_path = os.path.join(path, name)
    try:
        st = os.lstat(req_path)
    except FileNotFoundError:
        return None
    except OSError as e:
        return Refused("BAD_REQUEST", detail={"reason": "STAT", "errno": e.errno})
    if not stat.S_ISREG(st.st_mode):
        try:
            os.unlink(req_path)
        except OSError:
            pass
        return Refused("BAD_REQUEST", detail={"reason": "NOT_REG"})
    if expected_uid is not None and st.st_uid != expected_uid:
        try:
            os.unlink(req_path)
        except OSError:
            pass
        return Refused("BAD_REQUEST", detail={"reason": "OWNER"})
    if st.st_size > limit:
        try:
            os.unlink(req_path)
        except OSError:
            pass
        return Refused("BAD_REQUEST", detail={"reason": "TOO_BIG"})
    try:
        with open(req_path, "rb") as f:
            data = f.read(limit + 1)
        os.unlink(req_path)
    except OSError as e:
        return Refused("BAD_REQUEST", detail={"reason": "READ", "errno": e.errno})
    if len(data) > limit:
        return Refused("BAD_REQUEST", detail={"reason": "TOO_BIG"})
    return data


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
    if "bot_id" in params:
        bid = params["bot_id"]
        if not isinstance(bid, str) or not BOT_ID_RE.fullmatch(bid):
            raise bad("BAD_REQUEST", "BOT_ID")
        out["bot_id"] = bid
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

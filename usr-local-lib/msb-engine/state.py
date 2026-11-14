"""Read engine and bot facts into state.json for cli.py and the Telegram client.

OpenClaw scope is selected by openclaw_service.py and root-owned setup facts by
openclaw_readiness.py; request results remain here. Checks: tests/test_switch_safety.py
and tests/test_openclaw_service.py. Deletion trash is read as client via
archive_service.py; tests/test_archive_restore.py covers its state contract.
"""
import json
import os

from const import (
    BOT_ID_RE,
    BOT_TEMPLATE,
    BOT_UNIT_TMPL,
    CLIENT_ROOT,
    CODES,
    HELPER_VERSION,
    LEGACY_OC_MARKER,
    LEGACY_OC_OFF,
    MARKS_DIR,
    OC_HOME,
    OC_MARKER,
    OC_OFF,
    OC_SETUP,
    RUN_DIR,
    SLEEP_PREFIX,
    SOURCE_ACTIONS,
    SOURCES,
    STATE_DIR,
)
from openclaw_service import discover as discover_oc_service, word as oc_service_word
from openclaw_readiness import incomplete as openclaw_incomplete
from archive_service import list_trash
from util import (
    cc_cli_version,
    disk,
    ensure_root_dir,
    gb,
    iso,
    log,
    mem_total_mb,
    read_small,
    systemctl_word,
    write_file,
)


def bot_ids():
    root = os.path.join(CLIENT_ROOT, "bots")
    try:
        names = os.listdir(root)
    except OSError:
        return []
    return sorted(n for n in names if BOT_ID_RE.fullmatch(n) and os.path.isdir(os.path.join(root, n)))


def bot_unit(bot):
    return BOT_UNIT_TMPL % bot


def bot_mark(bot, kind):
    return os.path.join(MARKS_DIR, f"{bot}.{kind}")


def sleep_marks():
    eng = SOURCES[0][1]
    try:
        names = os.listdir(eng)
    except OSError:
        return set()
    out = set()
    for n in names:
        if n.startswith(SLEEP_PREFIX):
            bid = n[len(SLEEP_PREFIX) :]
            if BOT_ID_RE.fullmatch(bid):
                out.add(bid)
    return out


def msb_present():
    return os.path.lexists(BOT_TEMPLATE)


def msb_bots():
    asleep = sleep_marks()
    out = []
    for b in bot_ids():
        removed = os.path.lexists(bot_mark(b, "removed"))
        off = os.path.lexists(bot_mark(b, "off"))
        word = systemctl_word("is-enabled", bot_unit(b))
        masked = word.startswith("masked")
        active = systemctl_word("is-active", bot_unit(b)) == "active"
        enabled = not removed and not off and not masked
        sleeping = enabled and b in asleep
        known = active or word.split("-")[0] in (
            "enabled",
            "masked",
            "static",
            "indirect",
            "linked",
        )
        out.append(
            {
                "id": b,
                "active": active,
                "enabled": enabled,
                "removed": removed,
                "masked": masked,
                "sleeping": sleeping,
                "working": enabled and active and not sleeping,
                "known": known,
            }
        )
    return out


def jarvis_info():
    """Ключ `jarvis` в state сохранён для совместимости UI; это MSB-боты (Claude Code)."""
    bots = msb_bots() if msb_present() else []
    installed = any(not b["removed"] for b in bots)
    enabled = any(b["enabled"] for b in bots)
    if not msb_present():
        state = "absent"
    elif bots and not installed:
        state = "removed"
    elif bots and not enabled:
        state = "disabled"
    elif any(b["working"] for b in bots):
        state = "active"
    elif any(b["sleeping"] for b in bots) and all(
        b["sleeping"] for b in bots if b["enabled"]
    ):
        state = "asleep"
    else:
        state = "inactive"
    return {
        "installed": installed,
        "enabled": enabled,
        "state": state,
        "bots": bots,
        "cc_cli_version": cc_cli_version() if msb_present() else None,
    }


def detect_oc_unit():
    """Compatibility accessor; use discover_oc_service for its required scope."""
    service = discover_oc_service()
    return service.get('unit') if service else None


def openclaw_off_paths(scope):
    paths = [OC_OFF]
    # Old helper managed only the user unit. Preserve its explicit off intent
    # even if a new marker exists; do not apply it to a separate system unit.
    if scope == 'user':
        paths.append(LEGACY_OC_OFF)
    return [path for path in paths if os.path.lexists(path)]


def openclaw_info():
    marker = os.path.lexists(OC_MARKER)
    home = os.path.isdir(os.path.join(OC_HOME, ".openclaw"))
    service = discover_oc_service()
    unit = service.get('unit') if service else None
    scope = service.get('scope') if service else None
    legacy = scope == 'user' and os.path.lexists(LEGACY_OC_MARKER)
    off = bool(openclaw_off_paths(scope))
    if scope in ('unknown', 'ambiguous'):
        return {
            "installed": True if marker or scope == 'ambiguous' else None,
            "enabled": None,
            "incomplete": None,
            "gateway": "unknown",
            "plugin": None,
            "plugin_alive": False,
            "version": None,
            "frozen": None,
            "unit": None,
            "scope": scope,
        }
    if not marker and not legacy and not home and not service:
        return {
            "installed": False,
            "enabled": False,
            "incomplete": False,
            "gateway": "absent",
            "plugin": None,
            "plugin_alive": False,
            "version": None,
            "frozen": None,
            "unit": None,
            "scope": scope,
        }
    gateway = "unknown"
    if unit:
        st = oc_service_word(service, "is-active")
        gateway = st if st else "unknown"
    return {
        "installed": True,
        "enabled": not off,
        "incomplete": openclaw_incomplete(OC_MARKER, OC_SETUP),
        # The off marker is intent, not evidence that systemd has stopped.
        "gateway": gateway,
        "plugin": None,
        "plugin_alive": False,
        "version": None,
        "frozen": None,
        "unit": unit,
        "scope": scope,
    }


def way_back(o):
    return bool(
        o.get("installed")
        and o.get("enabled")
        and o.get("gateway") == "active"
        and o.get("plugin_alive")
    )


def available_actions(j, o, p=None, trash=None):
    acts = ["status"]
    if trash:
        acts.append("restore")
    if o["installed"] and o.get("scope") in ("system", "user") and isinstance(o.get("enabled"), bool):
        acts.append("disable-openclaw" if o["enabled"] else "enable-openclaw")
        if o["enabled"]:
            acts.append("update-openclaw")
    if j["installed"]:
        if any(b["enabled"] and not b["sleeping"] for b in j["bots"]):
            acts.append("disable-msb")
        if any(
            not b["removed"] and (not b["enabled"] or b["masked"] or b["sleeping"])
            for b in j["bots"]
        ):
            acts.append("enable-msb")
    if p and p.get("installed"):
        acts.append("disable-pult" if p.get("enabled") else "enable-pult")
    return {s: [a for a in acts if a in SOURCE_ACTIONS[s]] for s, _, _ in SOURCES}


def pult_info():
    """Статус модуля Пульт (без импорта actions — иначе цикл state↔actions)."""
    root = os.path.join(CLIENT_ROOT, "pult")
    off = os.path.join(STATE_DIR, "pult.off")
    units = ("pult-web.service", "pult-collector.service")
    installed = os.path.isfile(os.path.join(root, "package.json")) and os.path.isfile(
        "/etc/systemd/system/pult-web.service"
    )
    active = all(systemctl_word("is-active", u) == "active" for u in units) if installed else False
    enabled_unit = any(
        systemctl_word("is-enabled", u) in ("enabled", "enabled-runtime") for u in units
    )
    enabled = installed and enabled_unit and not os.path.lexists(off)
    return {
        "installed": installed,
        "enabled": enabled,
        "active": active,
        "units": list(units),
        "root": root,
    }


def compute_state():
    d = disk()
    j = jarvis_info()
    o = openclaw_info()
    p = pult_info()
    trash = list_trash()
    return {
        "v": 1,
        "helper_version": HELPER_VERSION,
        "helper": "msb-engine",
        "at": iso(),
        "managed": True,
        "hold": False,
        "host_ready": True,
        "actions": available_actions(j, o, p, trash),
        "codes": list(CODES),
        # `jarvis` — совместимое имя блока MSB-ботов (контракт UI/старых экранов).
        # `msb` — канонический алиас без бренда создателя.
        "jarvis": j,
        "msb": j,
        "openclaw": o,
        "pult": p,
        "way_back": way_back(o),
        "updates": {"auto": False},
        "openclaw_update": None,
        "disk": {
            "free_gb": gb(d["free_bytes"]),
            "total_gb": gb(d["total_bytes"]),
            "need_gb": 3,
            "used_pct": round(100 * (1 - d["free_bytes"] / d["total_bytes"]))
            if d["total_bytes"]
            else None,
        },
        "memory_mb": mem_total_mb(),
        "puller": {"timer_enabled": False, "timer_active": False},
        "base_pulse": {"installed": False, "timer_active": False},
        "usage": {"day": time_day(), "jarvis_sessions": 0, "openclaw_sessions": 0},
        "trash": trash,
        "openclaw_version_offered": None,
        "update": None,
        "snapshot": None,
        "openclaw_defaults": None,
        "rights": {"openclaw": False, "client": False},
    }


def time_day():
    return iso()[:10]


def ensure_run_dirs():
    ensure_root_dir(RUN_DIR, 0o755)
    ensure_root_dir(STATE_DIR, 0o700)
    ensure_root_dir(MARKS_DIR, 0o700)
    # Жёсткий cutover: не создаём /run/jarvis-engine. Старый symlink/каталог — только чистим при migrate.


def read_state():
    raw = read_small(os.path.join(RUN_DIR, "state.json"), 1 << 20)
    try:
        st = json.loads(raw.decode()) if raw else {}
    except Exception:
        st = {}
    return st if isinstance(st, dict) else {}


def write_state(update):
    ensure_run_dirs()
    st = read_state()
    st.update(update)
    payload = (json.dumps(st, sort_keys=True) + "\n").encode()
    write_file(os.path.join(RUN_DIR, "state.json"), payload, 0o644)


def write_result(source, rid, action, result, code, phase=None, detail=None, bot_id=None):
    if code not in CODES:
        detail = dict(detail or {}, reason=code)
        code = "FAILED" if result == "failed" else "HOST_NOT_READY"
    body = {
        "id": rid,
        "source": source,
        "action": action,
        "result": result,
        "code": code,
        "at": iso(),
    }
    if bot_id:
        body["bot_id"] = bot_id
    if phase:
        body["phase"] = phase
    if detail:
        body["detail"] = detail
    st = read_state()
    results = st.get("results") if isinstance(st.get("results"), dict) else {}
    results[source] = body
    update = {"last": body, "results": results}
    if rid:
        reqs = st.get("requests") if isinstance(st.get("requests"), dict) else {}
        reqs = {k: v for k, v in reqs.items() if isinstance(k, str) and isinstance(v, dict)}
        reqs[rid] = body
        for k in sorted(reqs, key=lambda x: (str(reqs[x].get("at", "")), x))[
            : max(0, len(reqs) - 32)
        ]:
            del reqs[k]
        update["requests"] = reqs
    write_state(update)
    log(f"result={result} code={code} action={action or 'none'} source={source}")

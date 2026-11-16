"""OpenClaw lifecycle actions; service routing belongs to openclaw_service.py.

Called by actions.ACTS via cli.handle; guarded status is read from state.py.
See tests/test_openclaw_service.py for system/user and failure paths.
"""
import os

from const import OC_OFF, STATE_DIR
from openclaw_service import ok as oc_service_ok, wait_stopped, word as oc_service_word
from state import jarvis_info, openclaw_info, openclaw_off_paths, sleep_marks
from util import Refused, ensure_root_dir, now, write_file
from .bots import set_sleep


def _service(info):
    return {'unit': info.get('unit'), 'scope': info.get('scope')}


def act_enable_openclaw(source, req, progress):
    o = openclaw_info()
    if o.get('adoption_pending'):
        raise Refused('NOT_AVAILABLE', detail={'reason': 'ADOPTION_PENDING'})
    if o["installed"] is None or o["enabled"] is None:
        raise Refused("NOT_AVAILABLE", detail={"reason": "OC_STATE_UNKNOWN"})
    if not o["installed"]:
        raise Refused("NOT_INSTALLED")
    if o["enabled"] and o.get("gateway") == "active":
        raise Refused("ALREADY_ENABLED")
    unit = o.get("unit")
    if not unit:
        raise Refused("NOT_AVAILABLE", detail={"reason": "NO_OC_UNIT"})
    progress("start")
    off_paths = openclaw_off_paths(o.get('scope'))
    was_off = bool(off_paths)
    if not oc_service_ok(_service(o), "enable", "--now", timeout=120):
        if was_off:
            oc_service_ok(_service(o), "disable", "--now", "--no-block", timeout=30)
        raise Refused("FAILED", "failed", {"reason": "OC_START", "unit": unit})
    gateway = oc_service_word(_service(o), "is-active") or "unknown"
    if gateway != 'active':
        if was_off:
            oc_service_ok(_service(o), "disable", "--now", "--no-block", timeout=30)
        raise Refused("FAILED", "failed", {"reason": "OC_NOT_ACTIVE", "gateway": gateway})
    if was_off:
        try:
            for marker in off_paths:
                try:
                    os.unlink(marker)
                except FileNotFoundError:
                    pass
        except OSError:
            # A partial removal must retain a local off intent.
            restored = False
            try:
                ensure_root_dir(STATE_DIR, 0o700)
                write_file(OC_OFF, f"off_at={now()}\n".encode(), 0o600)
                restored = True
            except (OSError, Refused):
                pass
            oc_service_ok(_service(o), "disable", "--now", "--no-block", timeout=30)
            raise Refused("FAILED", "failed", {"reason": "OC_OFF_MARKER", "off_restored": restored})
    return {"gateway": gateway, "unit": unit}


def act_disable_openclaw(source, req, progress):
    o = openclaw_info()
    if o["installed"] is None or o["enabled"] is None:
        raise Refused("NOT_AVAILABLE", detail={"reason": "OC_STATE_UNKNOWN"})
    if not o["installed"]:
        raise Refused("NOT_INSTALLED")
    if not o["enabled"] and o.get("gateway") in ("inactive", "failed"):
        raise Refused("ALREADY_DISABLED")
    unit = o.get("unit")
    if not unit:
        raise Refused("NOT_AVAILABLE", detail={"reason": "NO_OC_UNIT"})
    bots = jarvis_info()
    if not any(b.get("working") for b in bots.get("bots", [])):
        raise Refused("LAST_ENGINE", detail={"other": bots.get("state", "unknown")})
    progress("stop")
    ensure_root_dir(STATE_DIR, 0o700)
    write_file(OC_OFF, f"off_at={now()}\n".encode(), 0o600)
    woken = []
    try:
        if not oc_service_ok(_service(o), "disable", "--now", "--no-block", timeout=30):
            raise Refused("FAILED", "failed", {"reason": "OC_STOP", "unit": unit})
        gateway = wait_stopped(_service(o))
        if gateway is None:
            raise Refused("FAILED", "failed", {"reason": "OC_STILL_ACTIVE"})
    finally:
        try:
            ids = sorted(sleep_marks())
            if ids:
                set_sleep(ids, False, req.get('id', ''))
                woken = ids
        except Refused as e:
            woken = {"failed": e.detail.get("reason", "CLIENT_STEP")}
    return {"gateway": gateway, "unit": unit, "woken": woken}


def act_update_openclaw(source, req, progress):
    o = openclaw_info()
    if not o["installed"]:
        raise Refused("NOT_INSTALLED")
    if not o["enabled"]:
        raise Refused("ENGINE_OFF")
    # v1: нет собственного канала OC-релизов (TDR non-goal / шаг v1.1)
    raise Refused(
        "NOT_AVAILABLE",
        detail={"reason": "OWN_OC_UPDATES_LATER", "hint": "v1.1"},
    )

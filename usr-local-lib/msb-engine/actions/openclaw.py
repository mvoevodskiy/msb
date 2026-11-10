import os

from const import OC_OFF, STATE_DIR
from state import detect_oc_unit, openclaw_info
from util import Refused, ensure_root_dir, now, systemctl_ok, systemctl_word, write_file


def act_enable_openclaw(source, req, progress):
    o = openclaw_info()
    if not o["installed"]:
        raise Refused("NOT_INSTALLED")
    if o["enabled"] and o.get("gateway") == "active":
        raise Refused("ALREADY_ENABLED")
    progress("start")
    if os.path.lexists(OC_OFF):
        os.unlink(OC_OFF)
    unit = o.get("unit") or detect_oc_unit()
    if not unit:
        raise Refused("NOT_AVAILABLE", detail={"reason": "NO_OC_UNIT"})
    if not systemctl_ok("enable", "--now", unit, timeout=120):
        raise Refused("FAILED", "failed", {"reason": "OC_START", "unit": unit})
    return {"gateway": systemctl_word("is-active", unit) or "unknown", "unit": unit}


def act_disable_openclaw(source, req, progress):
    o = openclaw_info()
    if not o["installed"]:
        raise Refused("NOT_INSTALLED")
    if not o["enabled"]:
        raise Refused("ALREADY_DISABLED")
    progress("stop")
    ensure_root_dir(STATE_DIR, 0o700)
    write_file(OC_OFF, f"off_at={now()}\n".encode(), 0o600)
    unit = o.get("unit") or detect_oc_unit()
    if unit:
        systemctl_ok("stop", unit, timeout=120)
        # не disable навсегда — enable-openclaw вернёт
    return {"gateway": "inactive", "unit": unit}


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

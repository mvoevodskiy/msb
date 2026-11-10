import os

from const import SLEEP_PREFIX, SOURCES
from state import bot_unit, jarvis_info, sleep_marks
from util import Refused, as_client_touch, systemctl_ok, systemctl_word


def set_sleep(ids, on, rid=""):
    eng = SOURCES[0][1]
    for bot in ids:
        path = os.path.join(eng, f"{SLEEP_PREFIX}{bot}")
        if on:
            body = f"at={rid or 'manual'}\n".encode()
            as_client_touch(path, body)
        else:
            as_client_touch(path, None)


def start_bots(ids):
    ok = True
    for b in ids:
        systemctl_ok("unmask", bot_unit(b))
        if not systemctl_ok("enable", "--now", bot_unit(b), timeout=120):
            ok = False
    if not ok:
        raise Refused("FAILED", "failed", {"reason": "MSB_START"})


def act_enable_jarvis(source, req, progress):
    j = jarvis_info()
    if not j["installed"]:
        raise Refused("NOT_INSTALLED", detail={"state": j["state"]})
    want = req["params"].get("bot_id")
    live = [b for b in j["bots"] if not b["removed"] and (want is None or b["id"] == want)]
    if want and not live:
        raise Refused("NOT_INSTALLED", detail={"bot_id": want})
    off = [b["id"] for b in live if not b["enabled"] or b["masked"]]
    asleep = [b["id"] for b in live if b["sleeping"]]
    if not off and not asleep:
        raise Refused("ALREADY_ENABLED")
    progress("start")
    marks = sleep_marks()
    set_sleep([b["id"] for b in live if b["id"] in marks], False, req["id"])
    if off:
        start_bots(off)
    return {"bots": sorted(set(off) | set(asleep)), "woken": asleep, "started": off}


def act_disable_jarvis(source, req, progress):
    bot = req["params"]["bot_id"]
    j = jarvis_info()
    if not j["installed"]:
        raise Refused("NOT_INSTALLED", detail={"state": j["state"]})
    b = next((x for x in j["bots"] if x["id"] == bot and not x["removed"]), None)
    if b is None:
        raise Refused("NOT_INSTALLED", detail={"bot_id": bot})
    if b["sleeping"] or not b["enabled"]:
        raise Refused("ALREADY_DISABLED", detail={"bot_id": bot})
    # sleep без требования OC в v1 — иначе на боксе без OC нельзя «усыпить»
    progress("sleep")
    set_sleep([bot], True, req["id"])
    active = systemctl_word("is-active", bot_unit(bot)) == "active"
    return {"bots": [bot], "sleeping": True, "unit_active": active}

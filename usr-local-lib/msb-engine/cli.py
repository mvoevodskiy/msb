#!/usr/bin/env python3
"""msb-engine CLI: run | tick | status | setup"""

from __future__ import annotations

import os
import sys
import time

# Allow: python3 -IS usr-local-lib/msb-engine/cli.py  OR  /usr/local/sbin/msb-engine
_LIB = os.path.dirname(os.path.abspath(__file__))
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

from actions import ACTS  # noqa: E402
from const import (  # noqa: E402
    HELPER_VERSION,
    REQUEST_NAME,
    SOURCE_ACTIONS,
    SOURCES,
    STUCK_SLEEP,
)
from ipc import locked, parse_request, spend, take_request  # noqa: E402
from state import (  # noqa: E402
    compute_state,
    ensure_run_dirs,
    read_state,
    write_result,
    write_state,
)
from util import Refused, log, need_root, uid_of  # noqa: E402


def handle(source, data):
    try:
        req = parse_request(data)
    except Refused as e:
        return write_result(
            source,
            getattr(e, "request_id", None),
            None,
            "refused",
            e.code,
            None,
            e.detail,
        )
    rid, action = req["id"], req["action"]
    bot = req["params"].get("bot_id")
    if action not in SOURCE_ACTIONS[source]:
        return write_result(source, rid, action, "refused", "NOT_ALLOWED", bot_id=bot)
    limited = spend(source, rid, action)
    if limited:
        return write_result(source, rid, action, "refused", limited, bot_id=bot)

    def progress(phase, detail=None):
        write_result(source, rid, action, "running", "RUNNING", phase, detail, bot)

    progress("start")
    try:
        detail = ACTS[action](source, req, progress)
        outcome = ("done", "OK", detail)
    except Refused as e:
        outcome = (e.result, e.code, e.detail)
    except Exception as e:
        outcome = ("failed", "FAILED", {"reason": "INTERNAL_" + type(e).__name__.upper()[:40]})
    try:
        write_state(compute_state())
    except Exception as e:
        log(f"compute_state failed: {e}")
    write_result(source, rid, action, outcome[0], outcome[1], None, outcome[2], bot)


def cmd_run(_args):
    need_root()
    lock = locked()
    try:
        ensure_run_dirs()
        todo = [(n, take_request(p, uid_of(u))) for n, p, u in SOURCES if uid_of(u) is not None]
        for name, got in todo:
            if got is None:
                continue
            if isinstance(got, Refused):
                write_result(name, None, None, got.result, got.code, None, got.detail)
            else:
                handle(name, got)
        stuck = any(os.path.exists(os.path.join(p, REQUEST_NAME)) for _, p, _ in SOURCES)
    finally:
        os.close(lock)
    if stuck:
        time.sleep(STUCK_SLEEP)
    return 0


def cmd_tick(_args):
    need_root()
    lock = locked(wait=False)
    if lock is None:
        log("tick skipped: busy")
        return 0
    try:
        ensure_run_dirs()
        # health: failed msb-bot@* → reset-failed (не трогаем masked/sleep)
        from state import bot_ids, bot_unit, sleep_marks
        from util import systemctl_ok, systemctl_word

        asleep = sleep_marks()
        for b in bot_ids():
            if b in asleep:
                continue
            unit = bot_unit(b)
            if systemctl_word("is-failed", unit) == "failed":
                systemctl_ok("reset-failed", unit)
                log(f"reset-failed {unit}")
            # revive enabled but inactive (crash)
            if (
                systemctl_word("is-enabled", unit) == "enabled"
                and systemctl_word("is-active", unit) != "active"
            ):
                systemctl_ok("start", unit)
                log(f"revived {unit}")
        # OpenClaw revive if installed and not OC_OFF
        from const import OC_OFF
        from state import detect_oc_unit, openclaw_info

        o = openclaw_info()
        if o["installed"] and o["enabled"] and not os.path.lexists(OC_OFF):
            unit = o.get("unit") or detect_oc_unit()
            if unit and systemctl_word("is-active", unit) != "active":
                systemctl_ok("start", unit)
                log(f"revived {unit}")
        write_state(compute_state())
    finally:
        os.close(lock)
    return 0


def cmd_status(_args):
    need_root()
    lock = locked(wait=False)
    try:
        if lock is not None:
            ensure_run_dirs()
            write_state(compute_state())
        data = read_state()
        import json

        sys.stdout.write(json.dumps(data, sort_keys=True, indent=2) + "\n")
    finally:
        if lock is not None:
            os.close(lock)
    return 0


def cmd_setup(_args):
    need_root()
    ensure_run_dirs()
    for _name, path, user in SOURCES:
        if uid_of(user) is None:
            continue
        os.makedirs(path, mode=0o700, exist_ok=True)
        try:
            import pwd

            pw = pwd.getpwnam(user)
            os.chown(path, pw.pw_uid, pw.pw_gid)
        except Exception:
            pass
    write_state(compute_state())
    log(f"setup ok version={HELPER_VERSION}")
    return 0


COMMANDS = {
    "run": cmd_run,
    "tick": cmd_tick,
    "status": cmd_status,
    "setup": cmd_setup,
}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print("usage: msb-engine {run|tick|status|setup}", file=sys.stderr)
        return 2
    cmd = argv[0]
    if cmd not in COMMANDS:
        print(f"unknown command: {cmd}", file=sys.stderr)
        return 2
    try:
        return COMMANDS[cmd](argv[1:]) or 0
    except Refused as e:
        log(f"refused {e.code} {e.detail}")
        return 1
    except SystemExit as e:
        raise
    except Exception as e:
        log(f"fatal {type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    # Package import name when installed under /usr/local/lib/msb-engine
    # Fix: modules live in /usr/local/lib/msb-engine but import as msb_engine —
    # install copies tree as /usr/local/lib/msb-engine with package dir OR we use path hack.
    sys.exit(main())

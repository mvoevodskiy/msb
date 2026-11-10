"""enable/disable Пульта: pult-web + pult-collector в выбранном client root."""
import os
import subprocess

from const import CLIENT_HOME, CLIENT_ROOT, STATE_DIR
from state import pult_info
from util import Refused, ensure_root_dir, now, systemctl_ok, systemctl_word, write_file

PULT_ROOT = os.path.join(CLIENT_ROOT, "pult")
PULT_SECRETS = os.path.join(CLIENT_HOME, "pult-secrets")
PULT_OFF = os.path.join(STATE_DIR, "pult.off")
UNITS = ("pult-web.service", "pult-collector.service")


def _bot_env_path(bot_id):
    return os.path.join(CLIENT_ROOT, "bots", bot_id, ".env")


def _load_bot_env(bot_id):
    path = _bot_env_path(bot_id)
    env = os.environ.copy()
    if not os.path.isfile(path):
        return env
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                if k and k not in env:
                    env[k] = v
                elif k.startswith("PULT_") or k in ("OWNER_USER_ID", "DEEPGRAM_API_KEY", "ADMIN_ID"):
                    env[k] = v
    except OSError:
        pass
    return env


def _has_password(env):
    if (env.get("PULT_PASSWORD") or "").strip():
        return True
    web = os.path.join(PULT_SECRETS, "web.env")
    if not os.path.isfile(web):
        return False
    try:
        with open(web, "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("PULT_PASSWORD=") and line.strip() != "PULT_PASSWORD=":
                    return True
    except OSError:
        pass
    return False


def act_enable_pult(source, req, progress):
    info = pult_info()
    if not info["installed"]:
        raise Refused("NOT_INSTALLED", detail={"reason": "NO_PULT_CODE"})
    if info["enabled"] and info["active"]:
        raise Refused("ALREADY_ENABLED")

    bot_id = (req.get("bot_id") or "default").strip() or "default"
    _write_secrets(bot_id, progress)

    progress("start")
    if os.path.lexists(PULT_OFF):
        os.unlink(PULT_OFF)
    for u in UNITS:
        if not systemctl_ok("enable", "--now", u, timeout=120):
            raise Refused("FAILED", "failed", {"reason": "PULT_START", "unit": u})

    bin_link = "/usr/local/bin/pult"
    src_bin = os.path.join(PULT_ROOT, "bin", "pult")
    if os.path.isfile(src_bin) and not os.path.exists(bin_link):
        try:
            os.symlink(src_bin, bin_link)
        except OSError:
            pass

    return {
        "web": systemctl_word("is-active", "pult-web.service") or "unknown",
        "collector": systemctl_word("is-active", "pult-collector.service") or "unknown",
    }


def act_disable_pult(source, req, progress):
    info = pult_info()
    if not info["installed"]:
        raise Refused("NOT_INSTALLED", detail={"reason": "NO_PULT_CODE"})
    if not info["enabled"] and not info["active"]:
        raise Refused("ALREADY_DISABLED")

    progress("stop")
    ensure_root_dir(STATE_DIR, 0o700)
    write_file(PULT_OFF, f"off_at={now()}\n".encode(), 0o600)
    for u in UNITS:
        systemctl_ok("stop", u, timeout=120)
        systemctl_ok("disable", u, timeout=60)
    return {
        "web": systemctl_word("is-active", "pult-web.service") or "inactive",
        "collector": systemctl_word("is-active", "pult-collector.service") or "inactive",
    }


def _write_secrets(bot_id, progress):
    env = _load_bot_env(bot_id)
    if not _has_password(env):
        raise Refused(
            "NOT_AVAILABLE",
            detail={
                "reason": "NO_PULT_PASSWORD",
                "hint": "Задай пароль в /settings → Пульт → Пароль",
            },
        )
    progress("secrets")
    secrets_sh = os.path.join(PULT_ROOT, "deploy", "secrets.sh")
    if not os.path.isfile(secrets_sh):
        raise Refused("NOT_AVAILABLE", detail={"reason": "NO_SECRETS_SH"})
    public_url = (env.get("PULT_PUBLIC_URL") or "http://127.0.0.1:8791").strip()
    port = (env.get("PULT_PORT") or "8791").strip()
    try:
        subprocess.run(
            ["bash", secrets_sh, "--public-url", public_url, "--port", port],
            check=True,
            env=env,
            cwd=PULT_ROOT,
            timeout=60,
            user="client",
            group="client",
        )
    except (subprocess.CalledProcessError, OSError, subprocess.TimeoutExpired) as e:
        raise Refused("FAILED", "failed", {"reason": "SECRETS", "error": str(e)[:200]}) from e
    return env


def act_reload_pult(source, req, progress):
    """Переписать секреты из .env бота и перезапустить службы, если Пульт включён."""
    info = pult_info()
    if not info["installed"]:
        raise Refused("NOT_INSTALLED", detail={"reason": "NO_PULT_CODE"})
    bot_id = (req.get("bot_id") or "default").strip() or "default"
    _write_secrets(bot_id, progress)
    if not info["enabled"] and not info["active"]:
        return {"reloaded": "secrets-only", "running": False}
    progress("restart")
    for u in UNITS:
        systemctl_ok("restart", u, timeout=120)
    return {
        "reloaded": "secrets+restart",
        "web": systemctl_word("is-active", "pult-web.service") or "unknown",
        "collector": systemctl_word("is-active", "pult-collector.service") or "unknown",
    }

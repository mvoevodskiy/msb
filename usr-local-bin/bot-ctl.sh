#!/bin/bash
#
# bot-ctl.sh — controlled wrapper for systemctl operations on msb-bot instances.
#
# After multi-bot lands, a VPS may run several systemd template instances
# (msb-bot@default, msb-bot@visual, msb-bot@text, ...). Sudoers does not support
# globs in unit names, so granting the client user broad systemctl access would
# be required to manage them. Instead, this script provides a narrow gate:
# sudoers allows /usr/local/bin/bot-ctl.sh *, and the script itself validates
# both the action verb and the bot-id before calling systemctl.
#
# Usage:
#   bot-ctl.sh <action> [bot-id|all] [token-file]
#     action: restart | reload | stop | status | is-active | reset-failed
#             | add | remove
#     bot-id: optional — defaults to "default". Must match [a-zA-Z0-9_-]{1,32}.
#             Special: "all" — every dir under /home/client/.msb/bots (multi-bot only).
#             Ignored on legacy single-bot VPS (target is always msb-bot).
#     token-file (add only): path to a mode-600 file with BOT_TOKEN=... and
#             optional OWNER_USER_ID=... (written by local-ssh; deleted after read).
#
# Examples:
#   bot-ctl.sh restart             # legacy: systemctl restart msb-bot
#                                  # multi-bot: systemctl restart msb-bot@default
#   bot-ctl.sh reload              # light signal (v1: aliases to restart)
#   bot-ctl.sh restart visual      # systemctl restart msb-bot@visual
#   bot-ctl.sh restart all         # all bots on this box (shared code apply)
#   bot-ctl.sh status text         # systemctl status msb-bot@text
#   bot-ctl.sh add sales /tmp/msb-add-sales.env
#   bot-ctl.sh remove sales
#
# Exit codes:
#   0    — systemctl call succeeded
#   64   — bad usage (invalid action or bot-id)
#   *    — passed through from systemctl

set -euo pipefail

ACTION="${1:-}"
BOT_ID="${2:-default}"
TOKEN_FILE="${3:-}"
BOTS_ROOT="/home/client/.msb/bots"
WORKSPACE="/home/client/workspace"
CLIENT_USER="client"

# Whitelist of permitted actions. `reload` is the v1 graduated-signal placeholder
# — currently aliased to restart, intended for future hot-reload semantics where
# the bot reloads menu/skill/config files without dropping active sessions.
# Puller-side contract uses `reload` semantically already; bot-track flips the
# alias when it implements SIGHUP-based reload.
# `add` / `remove` — local multibot (MSB_LOCAL_SSH_HOST), without SSH from hub.
case " restart reload stop status is-active reset-failed add remove " in
  *" $ACTION "*) ;;
  *)
    echo "bot-ctl: action must be one of: restart, reload, stop, status, is-active, reset-failed, add, remove" >&2
    exit 64
    ;;
esac

# Validate bot-id format. Tight enough to forbid shell metachars, dashes, dots,
# slashes — anything that could escape into systemctl's arguments.
# "all" is reserved for multi-bot fan-out (not a real instance id).
if [ "$BOT_ID" != "all" ] && ! [[ "$BOT_ID" =~ ^[a-zA-Z0-9_-]{1,32}$ ]]; then
  echo "bot-ctl: bot-id must match [a-zA-Z0-9_-]{1,32} or be 'all'" >&2
  exit 64
fi

# ─── add / remove (multi-bot layout) ──────────────────────────────────────────
# Mirrors constructor's add-bot-to-multibot.sh / remove, but runs on-box via
# sudo bot-ctl (local SSH mode). Only the differing per-bot keys go into .env.

ensure_multibot_template() {
  if [ ! -f /etc/systemd/system/msb-bot@.service ]; then
    echo "bot-ctl: нет шаблона msb-bot@.service — multi-bot недоступен" >&2
    exit 64
  fi
}

fstab_line_for() {
  local id="$1"
  printf '%s  %s/bots/%s/cwd  none  bind,nofail  0  0\n' "$WORKSPACE" "/home/client/.msb" "$id"
}

add_bot_instance() {
  local id="$1" token_file="$2"
  local bot_dir="${BOTS_ROOT}/${id}"
  local token="" owner="" line cwd

  ensure_multibot_template

  if [ "$id" = "default" ] || [ "$id" = "all" ]; then
    echo "bot-ctl: нельзя add для '$id'" >&2
    exit 64
  fi
  if [ -d "$bot_dir" ]; then
    echo "bot-ctl: бот '$id' уже есть ($bot_dir)" >&2
    exit 64
  fi
  if [ ! -d "$WORKSPACE" ]; then
    echo "bot-ctl: нет $WORKSPACE" >&2
    exit 64
  fi
  if [ -z "$token_file" ] || [ ! -f "$token_file" ]; then
    echo "bot-ctl: add требует token-file (BOT_TOKEN=...)" >&2
    exit 64
  fi

  # shellcheck disable=SC1090
  token=$(grep -E '^BOT_TOKEN=' "$token_file" | head -1 | cut -d= -f2- || true)
  owner=$(grep -E '^OWNER_USER_ID=' "$token_file" | head -1 | cut -d= -f2- || true)
  rm -f "$token_file"
  if [ -z "$token" ] || [ "${#token}" -lt 20 ]; then
    echo "bot-ctl: пустой или слишком короткий BOT_TOKEN" >&2
    exit 64
  fi

  mkdir -p \
    "${bot_dir}/sessions" \
    "${bot_dir}/transcripts" \
    "${bot_dir}/agent-hooks" \
    "${bot_dir}/traces" \
    "${bot_dir}/autonomy" \
    "${bot_dir}/cwd"
  chown -R "${CLIENT_USER}:${CLIENT_USER}" "$bot_dir"
  chmod 700 "$bot_dir" \
    "${bot_dir}/sessions" \
    "${bot_dir}/transcripts" \
    "${bot_dir}/agent-hooks" \
    "${bot_dir}/traces"

  {
    echo "# Per-bot env — ONLY keys that must differ between bots."
    echo "# Shared secrets belong in /home/client/.msb/.env. Do NOT copy them here:"
    echo "# systemd loads this file before the bot starts, so a copy here silently"
    echo "# overrides the shared file forever, including after the key is rotated."
    echo "BOT_TOKEN=${token}"
    echo "MSB_BOT_ID=${id}"
    echo "MSB_SESSION_DIR=${bot_dir}/sessions"
    echo "MSB_TRANSCRIPT_DIR=${bot_dir}/transcripts"
    echo "MSB_HOOKS_DIR=${bot_dir}/agent-hooks"
    echo "MSB_TRACES_DIR=${bot_dir}/traces"
    if [ -n "$owner" ]; then
      echo "OWNER_USER_ID=${owner}"
    fi
  } >"${bot_dir}/.env"
  chown "${CLIENT_USER}:${CLIENT_USER}" "${bot_dir}/.env"
  chmod 600 "${bot_dir}/.env"

  cat >"${bot_dir}/remote-config.json" <<'JSON'
{
  "version": "v-autonomy-auto-on-oc-2026-09-03",
  "autonomyAutoOnCc": true,
  "autonomyAutoOnOc": true,
  "autonomyGlobalStop": false,
  "_version": "v-autonomy-auto-on-oc-2026-09-03"
}
JSON
  chown "${CLIENT_USER}:${CLIENT_USER}" "${bot_dir}/remote-config.json"
  date -u +%Y-%m-%dT%H:%M:%SZ >"${bot_dir}/.added-at"
  chown "${CLIENT_USER}:${CLIENT_USER}" "${bot_dir}/.added-at"

  cwd="${bot_dir}/cwd"
  if ! findmnt -n "$cwd" >/dev/null 2>&1; then
    mount --bind "$WORKSPACE" "$cwd"
  fi
  line=$(fstab_line_for "$id")
  if ! grep -Fqx "$line" /etc/fstab 2>/dev/null; then
    echo "$line" >>/etc/fstab
  fi

  /bin/systemctl daemon-reload
  /bin/systemctl reset-failed "msb-bot@${id}" 2>/dev/null || true
  /bin/systemctl enable --now "msb-bot@${id}"

  local state=inactive i
  for i in $(seq 1 60); do
    state=$(/bin/systemctl is-active "msb-bot@${id}" 2>/dev/null || echo inactive)
    [ "$state" = "active" ] && break
    sleep 1
  done
  if [ "$state" != "active" ]; then
    echo "bot-ctl: msb-bot@${id} не стал active за 60с (state=${state})" >&2
    /bin/journalctl -u "msb-bot@${id}" --no-pager -n 30 >&2 || true
    exit 1
  fi
  echo "ok botId=${id}"
}

remove_bot_instance() {
  local id="$1"
  local bot_dir="${BOTS_ROOT}/${id}"
  local cwd line

  ensure_multibot_template

  if [ "$id" = "default" ] || [ "$id" = "all" ]; then
    echo "bot-ctl: нельзя remove для '$id'" >&2
    exit 64
  fi
  if [ ! -d "$bot_dir" ]; then
    echo "bot-ctl: бот '$id' не найден" >&2
    exit 64
  fi

  /bin/systemctl disable --now "msb-bot@${id}" 2>/dev/null || true
  /bin/systemctl reset-failed "msb-bot@${id}" 2>/dev/null || true

  cwd="${bot_dir}/cwd"
  if findmnt -n "$cwd" >/dev/null 2>&1; then
    umount "$cwd" || umount -l "$cwd" || true
  fi
  line=$(fstab_line_for "$id")
  if grep -Fqx "$line" /etc/fstab 2>/dev/null; then
    # удалить точную строку bind без затрагивания других ботов
    grep -Fxv "$line" /etc/fstab > /etc/fstab.bot-ctl.tmp
    mv /etc/fstab.bot-ctl.tmp /etc/fstab
  fi

  rm -rf "$bot_dir"
  /bin/systemctl daemon-reload
  echo "ok removed=${id}"
}


if [ "$ACTION" = "add" ]; then
  add_bot_instance "$BOT_ID" "$TOKEN_FILE"
  exit 0
fi
if [ "$ACTION" = "remove" ]; then
  remove_bot_instance "$BOT_ID"
  exit 0
fi

case "$ACTION" in
  status|is-active) ;;
  *) ;;
esac

# Pick the target unit. On a multi-bot VPS the template file exists; legacy
# single-bot VPS only have msb-bot.service.
if [ -f /etc/systemd/system/msb-bot@.service ]; then
  UNIT="msb-bot@${BOT_ID}"
else
  UNIT="msb-bot"
fi

# Fan-out: shared code lives once under ~/.msb/bot — after apply/restart every
# instance must pick it up. status/is-active on "all" print one line per bot.
if [ "$BOT_ID" = "all" ]; then
  if [ ! -f /etc/systemd/system/msb-bot@.service ]; then
    if [ "$ACTION" = "reload" ]; then
      exec /bin/systemctl restart msb-bot
    fi
    exec /bin/systemctl "$ACTION" msb-bot
  fi
  ids=()
  if [ -d "$BOTS_ROOT" ]; then
    for d in "$BOTS_ROOT"/*; do
      [ -d "$d" ] || continue
      id=$(basename "$d")
      [[ "$id" =~ ^[a-zA-Z0-9_-]{1,32}$ ]] || continue
      ids+=("$id")
    done
  fi
  if [ ${#ids[@]} -eq 0 ]; then
    echo "bot-ctl: no bots under $BOTS_ROOT" >&2
    exit 64
  fi
  # stable order: default first, then alpha
  IFS=$'\n' ids=($(printf '%s\n' "${ids[@]}" | awk '
    $0=="default"{print "0\t"$0; next}
    {print "1\t"$0}
  ' | sort | cut -f2-))
  unset IFS
  ec=0
  sys_action="$ACTION"
  if [ "$ACTION" = "reload" ]; then
    sys_action="restart"
  fi
  for id in "${ids[@]}"; do
    if [ "$ACTION" = "status" ] || [ "$ACTION" = "is-active" ]; then
      echo -n "$id "
      /bin/systemctl "$sys_action" "msb-bot@$id" || ec=$?
    else
      /bin/systemctl "$sys_action" "msb-bot@$id" || ec=$?
    fi
  done
  exit "$ec"
fi

# v1: reload aliases to restart until bot-track implements true hot-reload.
# This branch will be replaced (or removed) once the bot supports SIGHUP-based
# config/menu reload without process restart.
if [ "$ACTION" = "reload" ]; then
  exec /bin/systemctl restart "$UNIT"
fi

exec /bin/systemctl "$ACTION" "$UNIT"

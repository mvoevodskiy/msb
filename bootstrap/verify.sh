#!/usr/bin/env bash
# Проверка установки ядра MSB на этом хосте.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

FAILS=0
ok()   { printf '  OK  %s\n' "$*"; }
bad()  { printf '  FAIL %s\n' "$*"; FAILS=$((FAILS + 1)); }
info() { printf '  --  %s\n' "$*"; }

echo "=== MSB bootstrap verify ==="

id -u "$CLIENT_USER" >/dev/null 2>&1 && ok "user $CLIENT_USER" || bad "user $CLIENT_USER"
# msb-admin (новый) или iia-admin (legacy на уже живых боксах)
if id -u "$ADMIN_USER" >/dev/null 2>&1; then
  ok "user $ADMIN_USER"
elif id -u iia-admin >/dev/null 2>&1; then
  ok "user iia-admin (legacy admin)"
else
  bad "user $ADMIN_USER (и нет iia-admin)"
fi

command -v node >/dev/null && ok "node $(node -v)" || bad "node"
[[ -x /usr/bin/node ]] && ok "/usr/bin/node (как в unit)" || bad "/usr/bin/node"

[[ -f "$MSB_HOME/bot/index.js" ]] && ok "bot/index.js" || bad "bot/index.js"
[[ -d "$MSB_HOME/bot/node_modules" ]] && ok "bot/node_modules" || bad "bot/node_modules (npm ci?)"
[[ -x /usr/local/sbin/msb-engine ]] && ok "msb-engine" || bad "msb-engine"
[[ -f /usr/local/lib/msb-engine/cli.py ]] && ok "msb-engine lib" || bad "msb-engine lib"
[[ -x /usr/local/bin/bot-ctl.sh ]] && ok "bot-ctl.sh" || bad "bot-ctl.sh"
[[ -x /usr/local/bin/msb-bot-watchdog.sh ]] && ok "watchdog" || bad "watchdog"
[[ -f /etc/sudoers.d/msb-engine ]] && ok "sudoers msb-engine" || bad "sudoers msb-engine"
if [[ -f /etc/sudoers.d/jarvis-client ]]; then
  bad "jarvis-client sudoers ещё на месте (нужен migrate / удаление)"
else
  ok "нет jarvis-client sudoers"
fi
if systemctl is-enabled msb-engine.path >/dev/null 2>&1; then
  ok "msb-engine.path enabled"
else
  bad "msb-engine.path не enabled"
fi
if systemctl is-enabled msb-engine-tick.timer >/dev/null 2>&1; then
  ok "msb-engine-tick.timer enabled"
else
  bad "msb-engine-tick.timer не enabled"
fi
if [[ -e /usr/local/sbin/jarvis-engine ]] || [[ -d /usr/local/lib/jarvis-engine ]]; then
  bad "jarvis-engine ещё на диске — запусти migrate-from-jarvis.sh"
else
  ok "нет jarvis-engine binary/lib"
fi
if [[ -f /etc/systemd/system/jarvis-engine.path ]] || [[ -f /etc/systemd/system/msb-base-pulse.service ]]; then
  bad "unit-файлы Jarvis/base-pulse ещё в /etc/systemd/system"
else
  ok "нет jarvis/base-pulse unit-файлов в /etc"
fi
if [[ -e /run/jarvis-engine ]]; then
  bad "/run/jarvis-engine ещё существует (нужен cutover)"
else
  ok "нет /run/jarvis-engine"
fi
if [[ -e /etc/jarvis-runtime-enrolled ]] || [[ -e /var/lib/jarvis-runtime ]]; then
  bad "enrollment-маркеры создателя ещё на месте"
else
  ok "нет jarvis-runtime enrollment"
fi
if [[ -x /usr/local/sbin/msb-engine ]]; then
  if /usr/local/sbin/msb-engine status >/dev/null 2>&1; then
    ok "msb-engine status"
  else
    info "msb-engine status не отработал (нужен root?)"
  fi
fi

[[ -d "$WORKSPACE" ]] && ok "workspace" || bad "workspace"
[[ -d "$PROJECTS" ]] && ok "projects (пусто — норма)" || bad "projects"
[[ -e "$WORKSPACE/ops/pult" ]] && bad "workspace/ops/pult не должен быть на чистой установке" || ok "нет ops/pult"

[[ -f "$MSB_HOME/pult/package.json" ]] && ok "модуль Пульт (~/.msb/pult)" || bad "нет ~/.msb/pult"
[[ -f /etc/systemd/system/pult-web.service ]] && ok "unit pult-web (выкл по умолчанию)" || bad "unit pult-web"
[[ -f /etc/systemd/system/pult-collector.service ]] && ok "unit pult-collector" || bad "unit pult-collector"
if systemctl is-enabled pult-web.service >/dev/null 2>&1; then
  info "pult-web enabled — норма, если включили из /settings"
else
  ok "pult-web не enabled (сток)"
fi

[[ -f /etc/systemd/system/msb-bot@.service ]] && ok "unit msb-bot@" || bad "unit msb-bot@"
[[ -f /etc/systemd/system/msb-sync.timer ]] && ok "unit msb-sync.timer" || bad "msb-sync.timer"
[[ -f /etc/systemd/system/msb-backup.service ]] && bad "msb-backup не должен ставиться ядром" || ok "нет msb-backup"
[[ -f /etc/systemd/system/msb-oc-install.service ]] && bad "msb-oc-install не должен ставиться ядром" || ok "нет oc-install"

if [[ -f "$MSB_HOME/.env" ]]; then
  ok ".env существует"
  if grep -E '^(PULT_|SOCPUB_|ZAPCITA_|INFOSEC_)[A-Z0-9_]*=' "$MSB_HOME/.env" >/dev/null; then
    bad ".env содержит продуктовые ключи"
  else
    ok ".env без продуктовых ключей"
  fi
  if grep -q '^SYNC_URL=.\+' "$MSB_HOME/.env" && grep -q '^SYNC_KEY=.\+' "$MSB_HOME/.env"; then
    ok "SYNC_URL/SYNC_KEY заданы"
  else
    info "SYNC_URL/SYNC_KEY пусты — puller/sync не заработают"
  fi
  if grep -q '^CLAUDE_CODE_OAUTH_TOKEN=.\+' "$MSB_HOME/.env"; then
    ok "CLAUDE_CODE_OAUTH_TOKEN задан"
  else
    info "CLAUDE_CODE_OAUTH_TOKEN пуст — агент без Claude"
  fi
else
  bad "нет $MSB_HOME/.env"
fi

shopt -s nullglob
bots=( "$MSB_HOME"/bots/*/ )
shopt -u nullglob
if [[ ${#bots[@]} -eq 0 ]]; then
  bad "нет инстансов в $MSB_HOME/bots"
else
  for d in "${bots[@]}"; do
    id="$(basename "$d")"
    findmnt -n "${d}cwd" >/dev/null 2>&1 && ok "bind cwd @$id" || bad "bind cwd @$id"
    [[ -f "${d}.env" ]] || { bad ".env @$id"; continue; }
    if grep -q '^BOT_TOKEN=.\+' "${d}.env"; then
      ok "BOT_TOKEN @$id"
    else
      info "BOT_TOKEN @$id пуст — юнит не должен быть active"
    fi
    if systemctl is-enabled "msb-bot@$id" >/dev/null 2>&1; then
      st="$(systemctl is-active "msb-bot@$id" 2>/dev/null || true)"
      if [[ "$st" == "active" ]]; then
        ok "msb-bot@$id active"
      else
        info "msb-bot@$id enabled, state=$st"
      fi
    else
      info "msb-bot@$id не enabled"
    fi
  done
fi

echo
if [[ "$FAILS" -eq 0 ]]; then
  echo "Итог: всё обязательное на месте ($FAILS fail)."
  exit 0
fi
echo "Итог: $FAILS проблем(ы)."
exit 1

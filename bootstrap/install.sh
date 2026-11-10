#!/usr/bin/env bash
# bootstrap/install.sh — развернуть чистое ядро MSB (оркестратор) на новом Linux-сервере.
#
# По умолчанию ставит ТОЛЬКО ядро (ExecStart → bot/index.js).
# Обвязка CLI (overlay/: Cursor/Codex/Qwen) — флаг --with-ext или отдельный overlay/install.sh.
# Продукты владельца и их секреты не ставятся.
#
# Использование (на целевом сервере, от root / sudo -n):
#   ./bootstrap/install.sh --env-file /root/msb.env --bot-env-file /root/bot-default.env
#   ./bootstrap/install.sh --with-ext
#   ./bootstrap/install.sh --dry-run
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

DRY_RUN=0
SKIP_START=0
SKIP_APT=0
RESET_WORKSPACE=0
WITH_EXT=0
SOURCE="$REPO_ROOT"
BOTS="default"
ENV_FILE=""
BOT_ENV_FILE=""
NODE_MAJOR="${NODE_MAJOR:-22}"

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --source DIR          корень снимка MSB (по умолчанию: родитель bootstrap/)
  --env-file FILE       заполненный общий .env (см. env/msb.env.example)
  --bot-env-file FILE   шаблон per-bot .env; MSB_BOT_ID/пути подставятся per id
  --bots LIST           через запятую, по умолчанию: default
  --with-ext            после ядра вызвать overlay/install.sh (CLI-провайдеры)
  --skip-start          установить, но не enable/start юниты бота
  --skip-apt            не ставить пакеты apt (уже есть node/build tools)
  --reset-workspace     ЗАТЕРЕТЬ workspace seed'ом (только осознанный сброс)
  --dry-run             только показать действия
  -h, --help            эта справка

Политика обновлений: bootstrap/UPDATE-POLICY.md
Ядро vs обвязка:     ../README.md  и  ../overlay/README.md
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="$(cd "$2" && pwd)"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --bot-env-file) BOT_ENV_FILE="$2"; shift 2 ;;
    --bots) BOTS="$2"; shift 2 ;;
    --with-ext) WITH_EXT=1; shift ;;
    --skip-start) SKIP_START=1; shift ;;
    --skip-apt) SKIP_APT=1; shift ;;
    --reset-workspace) RESET_WORKSPACE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "неизвестный аргумент: $1" ;;
  esac
done

need_root
[[ "$(uname -s)" == "Linux" ]] || die "только Linux"
command -v systemctl >/dev/null || die "нужен systemd"

[[ -d "$SOURCE/.msb/bot" ]] || die "нет $SOURCE/.msb/bot — укажи --source"
[[ -f "$SOURCE/usr-local-sbin/msb-engine" ]] || die "нет msb-engine в снимке"
[[ -d "$SOURCE/usr-local-lib/msb-engine" ]] || die "нет usr-local-lib/msb-engine в снимке"
[[ -f "$SOURCE/systemd/msb-bot@.service" ]] || die "нет systemd-юнитов в снимке"

IFS=',' read -r -a BOT_LIST <<<"$BOTS"
for b in "${BOT_LIST[@]}"; do
  validate_bot_id "$b"
done

if [[ -n "$ENV_FILE" ]]; then
  [[ -f "$ENV_FILE" ]] || die "--env-file не найден: $ENV_FILE"
  assert_no_product_secrets "$ENV_FILE"
fi
if [[ -n "$BOT_ENV_FILE" ]]; then
  [[ -f "$BOT_ENV_FILE" ]] || die "--bot-env-file не найден: $BOT_ENV_FILE"
  assert_no_product_secrets "$BOT_ENV_FILE"
fi

# ─── 1. Пакеты ───────────────────────────────────────────────────────────────
install_apt() {
  [[ "$SKIP_APT" == "1" ]] && { log "apt: пропуск (--skip-apt)"; return; }
  log "apt: базовые пакеты"
  export DEBIAN_FRONTEND=noninteractive
  run apt-get update -y
  run apt-get install -y \
    ca-certificates curl gnupg git rsync build-essential python3 \
    python3-pip sqlite3 jq unzip
}

install_node() {
  if command -v node >/dev/null 2>&1; then
    local v
    v="$(node -v | sed 's/^v//')"
    local major="${v%%.*}"
    if [[ "$major" -ge 20 ]]; then
      log "node: уже есть v$v"
      return
    fi
    warn "node v$v слишком старый, ставим Node $NODE_MAJOR"
  fi
  log "node: установка Node.js $NODE_MAJOR"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: NodeSource $NODE_MAJOR"
    return
  fi
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
  command -v node >/dev/null || die "node не установился"
}

# ─── 2. Пользователи ─────────────────────────────────────────────────────────
setup_users() {
  log "пользователи: $CLIENT_USER, $ADMIN_USER"
  ensure_group_user "$CLIENT_USER" "$CLIENT_HOME"
  ensure_group_user "$ADMIN_USER" "/home/$ADMIN_USER"
  if [[ "$DRY_RUN" != "1" ]]; then
    usermod -aG "$CLIENT_USER" "$ADMIN_USER" 2>/dev/null || true
  else
    log "dry-run: usermod -aG $CLIENT_USER $ADMIN_USER"
  fi
  run mkdir -p "$CLIENT_HOME" "$MSB_HOME" "$WORKSPACE" "$PROJECTS"
  run chown -R "$CLIENT_USER:$CLIENT_USER" "$CLIENT_HOME"
}

# ─── 3. Копирование ядра ─────────────────────────────────────────────────────
copy_platform() {
  log "копирование .msb (платформа)"
  run mkdir -p "$MSB_HOME"

  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: rsync .msb → $MSB_HOME"
    return
  fi

  # Ядро: никогда не копируем обвязку из .msb/bot (даже если лежит в снимке).
  rsync -a \
    --exclude 'node_modules/' \
    --exclude '/.env' \
    --exclude '.puller-state.json' \
    --exclude 'state.json' \
    --exclude '.base-pulse.json' \
    --exclude '_runtime-samples/' \
    --exclude 'bot/versions/' \
    --exclude 'bot/ext/' \
    --exclude 'bot/run.mjs' \
    --exclude 'bot/systemd/' \
    --exclude 'bot/vendor/index.closed.js' \
    --exclude 'bot/vendor/deobfuscated.js' \
    "$SOURCE/.msb/" "$MSB_HOME/"

  # чистые маркеры
  rm -f "$MSB_HOME/.puller-state.json" "$MSB_HOME/state.json" "$MSB_HOME/.base-pulse.json"
  : >"$MSB_HOME/state.json"
  echo "bootstrap $(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$MSB_HOME/.provisioned"

  # Workspace: только чистый seed (не археология SOURCE/workspace/).
  # Повторный прогон без --reset-workspace не затирает уже живой workspace.
  local seed="$SCRIPT_DIR/workspace-seed"
  [[ -d "$seed" ]] || seed="$SOURCE/bootstrap/workspace-seed"
  [[ -d "$seed" ]] || die "нет bootstrap/workspace-seed"

  if [[ -f "$WORKSPACE/CLAUDE.md" && "${RESET_WORKSPACE:-0}" != "1" ]]; then
    warn "workspace уже есть — не перезаписываю (UPDATE-POLICY). Сброс: --reset-workspace"
  else
    log "копирование workspace-seed → $WORKSPACE"
    if [[ "$DRY_RUN" != "1" ]]; then
      mkdir -p "$WORKSPACE"
      rsync -a --delete \
        --exclude 'README.md' \
        "$seed/" "$WORKSPACE/"
      mkdir -p "$WORKSPACE/memory" "$WORKSPACE/ops" "$WORKSPACE/.claude"
      rm -f "$WORKSPACE/.msb-bootstrapped"
    fi
  fi
  # пустые projects
  mkdir -p "$PROJECTS"
  if [[ "$DRY_RUN" != "1" && ! -f "$PROJECTS/README.md" ]]; then
    cat >"$PROJECTS/README.md" <<'EOF'
# projects

Каталог продуктовых проектов оркестратора MSB.
На чистой установке пуст — бот создаёт проекты здесь сам.
EOF
  fi

  chown -R "$CLIENT_USER:$CLIENT_USER" "$MSB_HOME" "$WORKSPACE" "$PROJECTS"
}

# ─── 4. npm / claude / playwright ────────────────────────────────────────────
install_node_deps() {
  log "npm ci в $MSB_HOME/bot"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: npm ci + claude-code + playwright"
    return
  fi
  [[ -f "$MSB_HOME/bot/package-lock.json" ]] || die "нет package-lock.json у бота"
  su -s /bin/bash -c "cd '$MSB_HOME/bot' && npm ci --omit=dev" "$CLIENT_USER" \
    || su -s /bin/bash -c "cd '$MSB_HOME/bot' && npm ci" "$CLIENT_USER"

  if ! command -v claude >/dev/null 2>&1 && [[ ! -f /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js ]]; then
    log "установка @anthropic-ai/claude-code (global)"
    npm install -g @anthropic-ai/claude-code
  else
    log "claude-code: уже есть"
  fi

  log "playwright chromium (для агента)"
  su -s /bin/bash -c "cd '$MSB_HOME/bot' && npx playwright install --with-deps chromium" "$CLIENT_USER" \
    || warn "playwright install не удался — бот без браузера; при необходимости повтори вручную"

  # Пульт в коробке (выкл): TypeScript нужен в runtime (node запускает .ts напрямую).
  if [[ -f "$MSB_HOME/pult/package-lock.json" ]]; then
    log "npm ci в $MSB_HOME/pult (модуль Пульт, службы выкл)"
    su -s /bin/bash -c "cd '$MSB_HOME/pult' && npm ci --include=dev" "$CLIENT_USER" \
      || warn "npm ci Пульта не удался — включение из настроек упадёт, пока не поставишь зависимости"
  else
    warn "нет $MSB_HOME/pult — модуль Пульт не скопирован"
  fi
}

# ─── 5. bin / sbin ────────────────────────────────────────────────────────────
install_bins() {
  log "скрипты /usr/local/bin и msb-engine"
  run install -d -m 0755 /usr/local/bin /usr/local/sbin /usr/local/lib/msb-engine
  run install -m 0755 "$SOURCE/usr-local-bin/bot-ctl.sh" /usr/local/bin/bot-ctl.sh
  run install -m 0755 "$SOURCE/usr-local-bin/msb-bot-watchdog.sh" /usr/local/bin/msb-bot-watchdog.sh
  run install -m 0755 "$SOURCE/usr-local-sbin/msb-engine" /usr/local/sbin/msb-engine
  if [[ "$DRY_RUN" != "1" ]]; then
    rsync -a --delete \
      --exclude 'rollback/' \
      "$SOURCE/usr-local-lib/msb-engine/" /usr/local/lib/msb-engine/
    cp -a /usr/local/sbin/msb-engine /usr/local/lib/msb-engine/msb-engine.good
    chmod 0755 /usr/local/lib/msb-engine/msb-engine.good
  fi
}

# ─── 6. sudoers / tick conf ───────────────────────────────────────────────────
install_sudoers() {
  log "sudoers + /etc/msb-tick"
  run install -d -m 0755 /etc/sudoers.d /etc/msb-tick
  # jarvis-client / msb-full-rights — НЕ ставим (opt-in). Узкий msb-engine + admin/tick/agent.
  for f in msb-admin agent-client msb-tick msb-engine; do
    run install -m 0440 "$SOURCE/etc/sudoers.d/$f" "/etc/sudoers.d/$f"
  done
  if [[ "$DRY_RUN" != "1" ]]; then
    visudo -cf /etc/sudoers.d/msb-admin \
      && visudo -cf /etc/sudoers.d/agent-client \
      && visudo -cf /etc/sudoers.d/msb-tick \
      && visudo -cf /etc/sudoers.d/msb-engine \
      || die "visudo отклонил sudoers"
  fi
  run install -m 0644 "$SOURCE/etc/msb-tick/puller.conf" /etc/msb-tick/puller.conf
}

# ─── 7. Боты: каталоги, env, fstab binds ─────────────────────────────────────
setup_bots() {
  log "инстансы ботов: ${BOT_LIST[*]}"
  local fstab_snip=/etc/fstab.d/msb-binds.conf
  if [[ "$DRY_RUN" != "1" ]]; then
    mkdir -p /etc/fstab.d
    : >"$fstab_snip"
  fi

  local id bot_dir
  for id in "${BOT_LIST[@]}"; do
    bot_dir="$MSB_HOME/bots/$id"
    run mkdir -p \
      "$bot_dir/cwd" \
      "$bot_dir/sessions" \
      "$bot_dir/transcripts" \
      "$bot_dir/traces" \
      "$bot_dir/agent-hooks" \
      "$bot_dir/diaries"

    if [[ "$DRY_RUN" != "1" ]]; then
      if ! findmnt -n "$bot_dir/cwd" >/dev/null 2>&1; then
        mount --bind "$WORKSPACE" "$bot_dir/cwd"
      fi
      local line="$WORKSPACE  $bot_dir/cwd  none  bind,nofail  0  0"
      if ! grep -Fqx "$line" /etc/fstab 2>/dev/null && ! grep -Fqx "$line" "$fstab_snip" 2>/dev/null; then
        echo "$line" >>"$fstab_snip"
      fi
      if ! grep -Fqx "$line" /etc/fstab 2>/dev/null; then
        echo "$line" >>/etc/fstab
      fi
    else
      log "dry-run: bind $WORKSPACE → $bot_dir/cwd"
    fi

    write_bot_env "$id" "$bot_dir"
  done

  [[ "$DRY_RUN" == "1" ]] || chown -R "$CLIENT_USER:$CLIENT_USER" "$MSB_HOME/bots"
}

write_bot_env() {
  local id="$1" bot_dir="$2" dest="$bot_dir/.env"
  if [[ -n "$BOT_ENV_FILE" ]]; then
    if [[ "$DRY_RUN" == "1" ]]; then
      log "dry-run: bot env $dest из $BOT_ENV_FILE"
      return
    fi
    # подставить пути/id, не трогая BOT_TOKEN из файла
    sed \
      -e "s|^MSB_BOT_ID=.*|MSB_BOT_ID=$id|" \
      -e "s|^MSB_SESSION_DIR=.*|MSB_SESSION_DIR=$bot_dir/sessions|" \
      -e "s|^MSB_TRANSCRIPT_DIR=.*|MSB_TRANSCRIPT_DIR=$bot_dir/transcripts|" \
      -e "s|^MSB_HOOKS_DIR=.*|MSB_HOOKS_DIR=$bot_dir/agent-hooks|" \
      -e "s|^MSB_TRACES_DIR=.*|MSB_TRACES_DIR=$bot_dir/traces|" \
      "$BOT_ENV_FILE" >"$dest"
  elif [[ "$DRY_RUN" != "1" ]]; then
    sed \
      -e "s/^MSB_BOT_ID=.*/MSB_BOT_ID=$id/" \
      -e "s|/home/client/.msb/bots/default/|$bot_dir/|g" \
      "$SCRIPT_DIR/env/bot.env.example" >"$dest"
    warn "записан шаблон $dest — заполни BOT_TOKEN до старта"
  fi
  [[ "$DRY_RUN" == "1" ]] || chmod 600 "$dest"
}

write_shared_env() {
  local dest="$MSB_HOME/.env"
  if [[ -n "$ENV_FILE" ]]; then
    log "общий .env из $ENV_FILE"
    if [[ "$DRY_RUN" != "1" ]]; then
      install -m 0600 -o "$CLIENT_USER" -g "$CLIENT_USER" "$ENV_FILE" "$dest"
    fi
  elif [[ "$DRY_RUN" != "1" ]]; then
    if [[ ! -f "$dest" ]]; then
      install -m 0600 -o "$CLIENT_USER" -g "$CLIENT_USER" \
        "$SCRIPT_DIR/env/msb.env.example" "$dest"
      warn "записан шаблон $dest — заполни секреты до старта"
    fi
  else
    log "dry-run: shared .env"
  fi
}

# ─── 8. systemd ───────────────────────────────────────────────────────────────
CORE_UNITS=(
  msb-bot@.service
  msb-sync.service
  msb-sync.timer
  msb-tick@.service
  msb-tick-puller.timer
  msb-pull-now.path
  msb-pull-now.service
  msb-engine.path
  msb-engine.service
  msb-engine-tick.timer
  msb-engine-tick.service
  # Пульт: юниты ставятся, автозапуск — только из /settings → Пульт
  pult-web.service
  pult-collector.service
  pult-notify-failure@.service
)
# НЕ ставим: jarvis-engine*, msb-base-pulse* (закрытый OS создателя снят).

install_systemd() {
  log "systemd-юниты ядра"
  run install -d /etc/systemd/system

  local u
  for u in "${CORE_UNITS[@]}"; do
    [[ -f "$SOURCE/systemd/$u" ]] || continue
    run install -m 0644 "$SOURCE/systemd/$u" "/etc/systemd/system/$u"
  done

  # drop-ins
  if [[ "$DRY_RUN" != "1" ]]; then
    mkdir -p /etc/systemd/system/msb-bot@.service.d
    for f in "$SOURCE/systemd/msb-bot@.service.d"/*.conf \
             "$SOURCE/systemd/drop-ins/msb-bot@.service.d"/*.conf; do
      [[ -f "$f" ]] || continue
      install -m 0644 "$f" /etc/systemd/system/msb-bot@.service.d/
    done
    mkdir -p /etc/systemd/system/msb-sync.service.d
    for f in "$SOURCE/systemd/msb-sync.service.d"/*.conf \
             "$SOURCE/systemd/drop-ins/msb-sync.service.d"/*.conf; do
      [[ -f "$f" ]] || continue
      install -m 0644 "$f" /etc/systemd/system/msb-sync.service.d/
    done
    mkdir -p /etc/systemd/system/msb-sync.timer.d
    for f in "$SOURCE/systemd/msb-sync.timer.d"/*.conf \
             "$SOURCE/systemd/drop-ins/msb-sync.timer.d"/*.conf; do
      [[ -f "$f" ]] || continue
      install -m 0644 "$f" /etc/systemd/system/msb-sync.timer.d/
    done
    if [[ -d "$SOURCE/systemd/drop-ins/system-msb-bot.slice.d" ]]; then
      # Для шаблона msb-bot@.service слайс — system-msb\x2dbot.slice
      local slice_d='/etc/systemd/system/system-msb\x2dbot.slice.d'
      mkdir -p "$slice_d"
      install -m 0644 "$SOURCE/systemd/drop-ins/system-msb-bot.slice.d/"*.conf "$slice_d/"
    fi
    systemctl daemon-reload
  else
    log "dry-run: install units + daemon-reload"
  fi
}

enable_services() {
  if [[ "$SKIP_START" == "1" ]]; then
    log "enable/start: пропуск (--skip-start)"
    return
  fi
  if [[ -z "$ENV_FILE" ]]; then
    warn "нет --env-file — юниты бота не стартуем (шаблон .env). Таймеры инфраструктуры — enable."
  fi

  log "enable инфраструктуры"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: systemctl enable --now timers/paths"
    return
  fi

  systemctl enable --now msb-sync.timer || warn "msb-sync.timer"
  systemctl enable --now msb-tick-puller.timer || warn "msb-tick-puller.timer"
  systemctl enable --now msb-pull-now.path || warn "msb-pull-now.path"
  systemctl enable --now msb-engine.path || warn "msb-engine.path"
  systemctl enable --now msb-engine-tick.timer || warn "msb-engine-tick.timer"
  if [[ "$DRY_RUN" != "1" ]]; then
    /usr/bin/python3 -IS /usr/local/lib/msb-engine/cli.py setup || warn "msb-engine setup"
    # Снести хвосты Jarvis/base-pulse, если остались с прошлой жизни бокса
    for u in jarvis-engine.path jarvis-engine.service jarvis-engine-tick.timer \
             jarvis-engine-tick.service jarvis-engine-update.path jarvis-engine-update.service \
             jarvis-engine-nft.service msb-base-pulse.timer msb-base-pulse.service; do
      systemctl disable --now "$u" 2>/dev/null || true
      systemctl unmask "$u" 2>/dev/null || true
      rm -f "/etc/systemd/system/$u"
    done
    rm -f /usr/local/sbin/jarvis-engine /etc/sudoers.d/jarvis-client
    rm -rf /usr/local/lib/jarvis-engine /etc/jarvis-engine /var/lib/jarvis-engine \
      /run/jarvis-engine /var/lib/jarvis-runtime /etc/jarvis-runtime-enrolled
    rm -f "$MSB_HOME/bot/vendor/index.closed.js" "$MSB_HOME/bot/vendor/deobfuscated.js"
    systemctl daemon-reload || true
  fi

  if [[ -n "$ENV_FILE" ]]; then
    local id
    for id in "${BOT_LIST[@]}"; do
      if grep -q '^BOT_TOKEN=.\+' "$MSB_HOME/bots/$id/.env" 2>/dev/null; then
        log "enable msb-bot@$id"
        systemctl enable --now "msb-bot@$id" || warn "не стартовал msb-bot@$id"
      else
        warn "msb-bot@$id: пустой BOT_TOKEN — не стартуем"
      fi
    done
  fi
}

# ─── main ─────────────────────────────────────────────────────────────────────
main() {
  log "источник: $SOURCE"
  log "цель: $CLIENT_HOME (bots: ${BOT_LIST[*]})"
  [[ "$DRY_RUN" == "1" ]] && log "режим dry-run"

  install_apt
  install_node
  setup_users
  copy_platform
  install_node_deps
  install_bins
  install_sudoers
  write_shared_env
  setup_bots
  install_systemd
  enable_services

  if [[ "$WITH_EXT" == "1" ]]; then
    local ov="$SOURCE/overlay/install.sh"
    [[ -x "$ov" || -f "$ov" ]] || die "нет $ov — обвязка не в снимке"
    log "обвязка: $ov"
    if [[ "$DRY_RUN" == "1" ]]; then
      log "dry-run: overlay/install.sh --dry-run"
    else
      local ov_args=(--source "$SOURCE" --target "$CLIENT_HOME")
      [[ "$SKIP_START" == "1" ]] && ov_args+=(--skip-restart)
      bash "$ov" "${ov_args[@]}"
    fi
  fi

  log "готово."
  if [[ "$DRY_RUN" != "1" ]]; then
    echo
    echo "Проверка:  $SCRIPT_DIR/verify.sh"
    echo "Логи бота: journalctl -u msb-bot@${BOT_LIST[0]} -f"
    echo "Секреты:   $MSB_HOME/.env  и  $MSB_HOME/bots/<id>/.env"
    if [[ "$WITH_EXT" != "1" ]]; then
      echo "Обвязка:   sudo $SOURCE/overlay/install.sh   # Cursor/Codex/Qwen (опционально)"
    fi
  fi
}

main

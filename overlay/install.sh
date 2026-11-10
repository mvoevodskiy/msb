#!/usr/bin/env bash
# overlay/install.sh — наложить обвязку CLI на уже установленное ядро MSB.
# Не ставит ядро. Не трогает workspace и продукты владельца.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="${TARGET:-/home/client}"
DRY_RUN=0
SKIP_RESTART=0

usage() {
  cat <<'EOF'
Usage: overlay/install.sh [options]

  --source DIR     корень репо (по умолчанию: родитель overlay/)
  --target DIR     home пользователя бота (по умолчанию: /home/client)
  --skip-restart   не перезапускать msb-bot@*
  --dry-run
  -h, --help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="$(cd "$2" && pwd)"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --skip-restart) SKIP_RESTART=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "неизвестный аргумент: $1" >&2; exit 64 ;;
  esac
done

need() { command -v "$1" >/dev/null || { echo "нужен $1" >&2; exit 1; }; }
need rsync
need install

BOT_DST="$TARGET/.msb/bot"
[[ -f "$BOT_DST/index.js" ]] || { echo "нет ядра: $BOT_DST/index.js — сначала bootstrap/install.sh" >&2; exit 1; }
[[ -d "$SOURCE/overlay/bot/ext" ]] || { echo "нет $SOURCE/overlay/bot/ext" >&2; exit 1; }

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "dry-run: $*"
  else
    "$@"
  fi
}

echo "[overlay] → $BOT_DST"

run mkdir -p "$BOT_DST/systemd"
run rsync -a --delete "$SOURCE/overlay/bot/ext/" "$BOT_DST/ext/"
run rsync -aL --delete "$SOURCE/overlay/bot/shared/" "$BOT_DST/shared/"
run install -m 0755 "$SOURCE/overlay/bot/run.mjs" "$BOT_DST/run.mjs"
run install -m 0644 "$SOURCE/overlay/bot/systemd/60-ext-entry.conf" "$BOT_DST/systemd/60-ext-entry.conf"
run install -m 0644 "$SOURCE/overlay/bot/package.json" "$BOT_DST/package.json"

if [[ -f "$SOURCE/overlay/usr-local-bin/bot-ctl.sh" ]]; then
  run install -m 0755 "$SOURCE/overlay/usr-local-bin/bot-ctl.sh" /usr/local/bin/bot-ctl.sh
fi

DROP_DIR=/etc/systemd/system/msb-bot@.service.d
run mkdir -p "$DROP_DIR"
run install -m 0644 "$SOURCE/overlay/bot/systemd/60-ext-entry.conf" "$DROP_DIR/60-ext-entry.conf"

if [[ "$DRY_RUN" != "1" ]]; then
  # пути в drop-in завязаны на /home/client — поправим при другом TARGET
  if [[ "$TARGET" != "/home/client" ]]; then
    sed -i "s|/home/client|$TARGET|g" "$DROP_DIR/60-ext-entry.conf"
  fi
  chown -R client:client "$BOT_DST/ext" "$BOT_DST/shared" "$BOT_DST/run.mjs" "$BOT_DST/systemd" "$BOT_DST/package.json" 2>/dev/null || true
  systemctl daemon-reload
  if [[ "$SKIP_RESTART" != "1" ]] && command -v bot-ctl.sh >/dev/null; then
    bot-ctl.sh restart all || bot-ctl.sh restart default || true
  fi
fi

echo "[overlay] готово. Вход: run.mjs (drop-in 60-ext-entry.conf)."
echo "[overlay] Откат: rm $DROP_DIR/60-ext-entry.conf && systemctl daemon-reload && bot-ctl.sh restart all"

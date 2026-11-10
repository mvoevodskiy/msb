#!/usr/bin/env bash
# Пишет файлы секретов Пульта из текущего окружения (переменные заданы в /settings личного бота).
# Значения никогда не печатаются — только «задан/нет». Повторный запуск безопасен:
# токен сборщика PULT_INGEST_TOKEN создаётся один раз и дальше берётся из прежнего файла.
#   deploy/secrets.sh [--public-url https://pult.dev.mp.aaa0.ru] [--port 8791]
set -euo pipefail
SECRETS=/home/client/pult-secrets
DATA=/home/client/pult-data
PUBLIC_URL=https://pult.dev.mp.aaa0.ru
PORT=8791
while [ $# -gt 0 ]; do
  case "$1" in
    --public-url) PUBLIC_URL=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "Неизвестный параметр: $1" >&2; exit 2 ;;
  esac
done
umask 077
mkdir -p "$SECRETS" "$DATA"
chmod 700 "$SECRETS" "$DATA"

old() { [ -f "$SECRETS/web.env" ] && sed -n "s/^$1=//p" "$SECRETS/web.env" | head -n1 || true; }
INGEST=$(old PULT_INGEST_TOKEN)
[ -n "$INGEST" ] || INGEST=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")
PASSWORD=${PULT_PASSWORD:-$(old PULT_PASSWORD)}
TG_TOKEN=${PULT_TG_TOKEN:-$(old PULT_TG_TOKEN)}
TG_CHAT=${PULT_TG_CHAT_ID:-${OWNER_USER_ID:-${ADMIN_ID:-$(old PULT_TG_CHAT_ID)}}}
# 127.0.0.1 — только локально; 0.0.0.0 — все интерфейсы; иначе конкретный IP.
HOST=${PULT_HOST:-$(old PULT_HOST)}
[ -n "$HOST" ] || HOST=127.0.0.1
SESSION_HOURS=${PULT_SESSION_HOURS:-$(old PULT_SESSION_HOURS)}
[ -n "$SESSION_HOURS" ] || SESSION_HOURS=4

# Значения с пробелами и спецсимволами допустимы: systemd EnvironmentFile понимает кавычки.
q() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }
# Mini App discovery uses this directory; collector sources stay in PULT_CONFIG.
BOTS_DIR=${PULT_BOTS_DIR:-${PULT_BOTS_ROOT:-}}
if [ -n "$BOTS_DIR" ]; then
  BOTS_ENV=$(q "$BOTS_DIR")
else
  BOTS_ENV=$(old PULT_BOTS_DIR)
  [ -n "$BOTS_ENV" ] || BOTS_ENV=$(old PULT_BOTS_ROOT)
  if [ -z "$BOTS_ENV" ] && [ "${MSB_RUNTIME_PROFILE:-msb}" = jar1 ]; then
    BOTS_ENV=/home/client/.iia/bots
  fi
fi
{
  echo "# Секреты веб-сервиса Пульта. Пишет deploy/secrets.sh, руками не править."
  echo "PULT_PORT=$PORT"
  echo "PULT_HOST=$HOST"
  echo "PULT_DATA_DIR=$DATA"
  echo "PULT_PUBLIC_URL=$PUBLIC_URL"
  echo "PULT_SESSION_HOURS=$SESSION_HOURS"
  [ -n "$BOTS_ENV" ] && echo "PULT_BOTS_DIR=$BOTS_ENV"
  # http://… (сток без TLS) — иначе браузер не сохранит cookie SameSite=Strict+Secure
  if [[ "$PUBLIC_URL" == http://* ]]; then echo "PULT_COOKIE_SECURE=0"; else echo "PULT_COOKIE_SECURE=1"; fi
  echo "PULT_TRUST_PROXY=1"
  echo "PULT_INGEST_TOKEN=$INGEST"
  [ -n "$PASSWORD" ] && echo "PULT_PASSWORD=$(q "$PASSWORD")"
  [ -n "$TG_TOKEN" ] && echo "PULT_TG_TOKEN=$TG_TOKEN"
  [ -n "$TG_CHAT" ] && echo "PULT_TG_CHAT_ID=$TG_CHAT"
  true
} > "$SECRETS/web.env.tmp"
mv "$SECRETS/web.env.tmp" "$SECRETS/web.env"

{
  echo "# Секреты сборщика Пульта. Пишет deploy/secrets.sh, руками не править."
  echo "PULT_URL=http://127.0.0.1:$PORT"
  echo "PULT_INGEST_TOKEN=$INGEST"
  echo "PULT_PUBLIC_URL=$PUBLIC_URL"
  # Сторож сборщика: веб-сервис 10 мин не принимает снимки — тревога через того же бота.
  [ -n "$TG_TOKEN" ] && echo "PULT_TG_TOKEN=$TG_TOKEN"
  [ -n "$TG_CHAT" ] && echo "PULT_TG_CHAT_ID=$TG_CHAT"
  [ -n "${DEEPGRAM_API_KEY:-}" ] && echo "DEEPGRAM_API_KEY=$DEEPGRAM_API_KEY"
  true
} > "$SECRETS/collector.env.tmp"
mv "$SECRETS/collector.env.tmp" "$SECRETS/collector.env"
chmod 600 "$SECRETS"/*.env

st() { [ -n "$1" ] && echo "задан" || echo "НЕТ"; }
echo "Секреты записаны в $SECRETS (0600):"
echo "  пароль входа PULT_PASSWORD — $(st "$PASSWORD")"
echo "  слушает PULT_HOST=$HOST"
echo "  сессия браузера PULT_SESSION_HOURS=$SESSION_HOURS"
echo "  бот тревог PULT_TG_TOKEN — $(st "$TG_TOKEN") (необязателен: /pult есть у любого MSB-бота)"
echo "  чат тревог — $(st "$TG_CHAT")"
echo "  токен сборщика — задан"
echo "  ключ Deepgram для остатка — $(st "${DEEPGRAM_API_KEY:-}")"
[ -n "$PASSWORD" ] || echo "Без пароля веб-сервис не запустится: задай пароль в /settings → Пульт."

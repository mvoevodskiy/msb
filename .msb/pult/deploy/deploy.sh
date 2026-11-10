#!/usr/bin/env bash
# Выкладка Пульта: проверки → выкладочная копия на коммите → зависимости → перезапуск служб → проверка здоровья.
#   deploy/deploy.sh [<коммит>] [--skip-check]
# Выкладывается только закоммиченное. Прежний коммит запоминается для deploy/rollback.sh.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
DEPLOY=/home/client/pult-deploy
DATA=/home/client/pult-data
COMMIT=HEAD
CHECK=1
for a in "$@"; do
  case "$a" in
    --skip-check) CHECK=0 ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) COMMIT=$a ;;
  esac
done
cd "$REPO"
git diff --quiet && git diff --cached --quiet || { echo "В $REPO есть незакоммиченные правки — сначала коммит." >&2; exit 1; }
SHA=$(git rev-parse --verify "$COMMIT^{commit}")
if [ "$CHECK" = 1 ]; then
  echo "Проверки (typecheck + тесты)…"
  npm run --silent check >/tmp/pult-check.log 2>&1 || { echo "Проверки не прошли, выкладку отменяю. Журнал: /tmp/pult-check.log" >&2; tail -n 30 /tmp/pult-check.log >&2; exit 1; }
fi
mkdir -p "$DATA" && chmod 700 "$DATA"
if [ -d "$DEPLOY/.git" ] || [ -f "$DEPLOY/.git" ]; then
  git -C "$DEPLOY" rev-parse HEAD > "$DATA/deploy-previous"
  git -C "$DEPLOY" checkout --quiet --detach "$SHA"
else
  git worktree add --detach "$DEPLOY" "$SHA"
fi
(cd "$DEPLOY" && NODE_ENV=production npm ci --omit=dev --no-audit --no-fund --silent)
echo "$SHA" > "$DATA/deploy-current"

restart() {
  local unit=$1
  if systemctl cat "$unit" >/dev/null 2>&1; then
    if [ "$unit" = pult-web.service ] && ! grep -q '^PULT_PASSWORD=' /home/client/pult-secrets/web.env 2>/dev/null; then
      echo "  $unit: не запускаю — нет пароля PULT_PASSWORD (deploy/secrets.sh)"; return
    fi
    sudo -n systemctl reset-failed "$unit" 2>/dev/null || true
    sudo -n systemctl enable --quiet "$unit"
    sudo -n systemctl restart "$unit" && echo "  $unit перезапущен (автозапуск включён)"
  else
    echo "  $unit не установлен (deploy/install.sh)"
  fi
}
echo "Выложен $(git log -1 --format='%h %s' "$SHA")"
restart pult-web.service
# Сборщику некуда слать, пока местный веб-сервис не запущен (нет пароля) — не плодим строки «не отправлено».
URL=$(sed -n 's/^PULT_URL=//p' /home/client/pult-secrets/collector.env 2>/dev/null || true)
if [[ "${URL:-http://127.0.0.1}" == http://127.0.0.1* ]] && ! systemctl is-active --quiet pult-web.service; then
  echo "  pult-collector.service: не запускаю — местный веб-сервис не запущен"
else
  restart pult-collector.service
fi

PORT=$(sed -n 's/^PULT_PORT=//p' /home/client/pult-secrets/web.env 2>/dev/null || true); PORT=${PORT:-8791}
if systemctl is-active --quiet pult-web.service; then
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then echo "Здоровье веб-сервиса: в порядке"; break; fi
    sleep 1
    [ $i = 10 ] && { echo "Веб-сервис не отвечает на /health — смотри journalctl -u pult-web -n 50; откат: deploy/rollback.sh" >&2; exit 1; }
  done
fi
